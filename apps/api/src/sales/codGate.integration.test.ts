/**
 * The COD advance-payment gate, end to end (R5.5), on real PostgreSQL.
 *
 * The PRD's acceptance criteria, as written:
 *
 *   Given   the COD advance threshold is AED 1,500 and a cart totals AED 4,299
 *   When    the shopper selects cash on delivery
 *   Then    checkout requires an advance payment of the configured amount or
 *           percentage by card or Tabby before the order can be placed
 *   And     the order records the advance as a separate transaction against
 *           the same order
 *   And     a customer whose COD risk score exceeds the configured ceiling is
 *           not offered COD at all, with honest copy explaining that card or
 *           Tabby is required
 *
 * The audit's finding was that this configuration was "read and never enforced
 * anywhere in checkout" — the single stated business problem, unmitigated in
 * code. These tests are what make the enforcement real.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { Db } from "../db.js";
import { MockGateway } from "../payments/gatewayPort.js";
import { buildPgApp } from "../pgApp.js";

/** Must match the paymentWebhookSecret the app is built with, below. */
const WEBHOOK_SECRET = "cod-gate-test-webhook-secret";
const signer = new MockGateway(WEBHOOK_SECRET);
const mockSignature = (raw: string): string => signer.sign(raw);

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

// AED 1,433.00 each; three of them make AED 4,299.00 — the PRD's cart.
const UNIT_PRICE_MINOR = 143_300;
const CART_TOTAL_MINOR = 429_900;

describe.skipIf(!run)("the COD advance gate", () => {
  let app: ReturnType<typeof buildPgApp>;
  let db: Db;
  let ownerToken = "";
  let tenantId = "";
  let variantId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `cod-shop-${suffix}`;

  const authed = () => ({ authorization: `Bearer ${ownerToken}` });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });
  const put = (url: string, payload?: unknown) =>
    app.inject({ method: "PUT", url, headers: authed(), payload: payload as never });
  const get = (url: string) => app.inject({ method: "GET", url, headers: authed() });

  /** Place a storefront order as a guest, on the public route. */
  const placeOrder = (body: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/v1/public/${slug}/orders`,
      payload: {
        customer: { name: "Fatima", phone: `+9715${suffix.slice(0, 7)}` },
        lines: [{ variantId, quantity: 3 }],
        ...body,
      } as never,
    });

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
      paymentWebhookSecret: WEBHOOK_SECRET,
    });
    db = new Db(APP_URL!);

    const reg = await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: {
        tenantName: "COD Shop", slug, fullName: "Owner",
        email: `owner@${slug}.test`, password: "correct-horse-battery",
      },
    });
    ownerToken = reg.json().accessToken;

    const locationId = (
      await post("/v1/locations", { kind: "warehouse", name: "WH", code: "WH1" })
    ).json().id;
    const productId = (
      await post("/v1/products", { name: "Phone D", slug: `phone-d-${suffix}` })
    ).json().id;
    variantId = (
      await post(`/v1/products/${productId}/variants`, {
        sku: `PD-${suffix}`, priceMinor: UNIT_PRICE_MINOR, currency: "AED",
      })
    ).json().id;
    await post("/v1/inventory/receipts", {
      locationId, lines: [{ variantId, quantity: 500 }],
    });

    tenantId = (await get("/v1/settings/supplier")).json() && (
      await db.withPlatform(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          "SELECT id FROM tenant WHERE slug = $1", [slug],
        );
        return rows[0]!.id;
      })
    );

    // The PRD's worked example: threshold AED 1,500, advance 20%.
    await put("/v1/settings/cod-policy", {
      enabled: true,
      advanceThresholdMinor: 150_000,
      advanceMode: "percent",
      advancePercentBp: 2_000,
      riskCeiling: 70,
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  /** The payment rows on an order, as the database holds them. */
  const paymentsFor = (orderId: string) =>
    db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query(
        `SELECT method, purpose, amount_minor, status
           FROM payment WHERE order_id = $1 ORDER BY purpose`,
        [orderId],
      );
      return rows.map((r) => ({ ...r, amount_minor: Number(r.amount_minor) }));
    });

  const orderRow = (orderId: string) =>
    db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query(
        `SELECT status, payment_method, cod_advance_required_minor,
                cod_advance_paid_minor, cod_risk_score
           FROM sales_order WHERE id = $1`,
        [orderId],
      );
      return rows[0]!;
    });

  describe("the value limb", () => {
    it("requires a 20% advance on a cart above the threshold", async () => {
      const res = await placeOrder({ paymentMethod: "cod" });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.totals.totalMinor).toBe(CART_TOTAL_MINOR);
      // 20% of AED 4,299.00 = AED 859.80.
      expect(body.codAdvanceRequiredMinor).toBe(85_980);
      expect(body.amountDueNowMinor).toBe(85_980);
      expect(body.status).toBe("pending_payment");

      const order = await orderRow(body.orderId);
      // The order may NOT confirm until the advance is collected.
      expect(order.status).toBe("pending");
      expect(Number(order.cod_advance_required_minor)).toBe(85_980);
      expect(Number(order.cod_advance_paid_minor)).toBe(0);
      expect(order.payment_method).toBe("cod");
    });

    it("records the advance as a separate transaction against the same order", async () => {
      const body = (await placeOrder({ paymentMethod: "cod" })).json();
      const payments = await paymentsFor(body.orderId);

      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({
        purpose: "cod_advance",
        amount_minor: 85_980,
        status: "pending",
      });
      // Deliberately NOT the full order value: the rest is collected at the
      // door. A deposit booked as settlement would misstate revenue.
      expect(payments[0]!.amount_minor).toBeLessThan(CART_TOTAL_MINOR);
    });

    it("takes no advance on a cart at or below the threshold", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/v1/public/${slug}/orders`,
        payload: {
          customer: { name: "Small Basket", phone: `+9715${suffix.slice(0, 7)}` },
          lines: [{ variantId, quantity: 1 }], // AED 1,433.00 < 1,500.00
          paymentMethod: "cod",
        } as never,
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.codAdvanceRequiredMinor).toBe(0);
      expect(body.status).toBe("cod_pending_delivery");

      const order = await orderRow(body.orderId);
      // Nothing to wait for, so the order confirms immediately.
      expect(order.status).toBe("confirmed");
      // And no gateway payment row is created for money nobody owes yet.
      expect(await paymentsFor(body.orderId)).toHaveLength(0);
    });

    it("confirms the order only once the advance is actually captured", async () => {
      const body = (await placeOrder({ paymentMethod: "cod" })).json();

      // Paying charges the ADVANCE, not the order total — the difference is
      // the whole point of the gate.
      const intent = await app.inject({
        method: "POST",
        url: `/v1/public/${slug}/orders/${body.orderId}/pay`,
        payload: { gateway: "mock" } as never,
      });
      expect(intent.statusCode).toBe(201);

      const intentRow = await db.withTenant(tenantId, async (c) => {
        const { rows } = await c.query(
          "SELECT amount_minor FROM payment_intent WHERE order_id = $1",
          [body.orderId],
        );
        return rows[0]!;
      });
      expect(Number(intentRow.amount_minor)).toBe(85_980);

      // Still unconfirmed: an intent is not a payment.
      expect((await orderRow(body.orderId)).status).toBe("pending");

      const raw = JSON.stringify({
        id: `evt-${body.orderId}`,
        type: "payment.succeeded",
        gatewayRef: intent.json().gatewayRef,
      });
      const signed = await app.inject({
        method: "POST",
        url: "/v1/webhooks/payments/mock",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": mockSignature(raw),
        },
        payload: raw,
      });
      expect(signed.statusCode).toBe(200);

      const after = await orderRow(body.orderId);
      expect(Number(after.cod_advance_paid_minor)).toBe(85_980);
      expect(after.status).toBe("confirmed");
    });

    it("honours a flat advance when the policy says fixed", async () => {
      await put("/v1/settings/cod-policy", {
        advanceMode: "fixed", advanceFixedMinor: 50_000,
      });
      const body = (await placeOrder({ paymentMethod: "cod" })).json();
      expect(body.codAdvanceRequiredMinor).toBe(50_000);

      await put("/v1/settings/cod-policy", {
        advanceMode: "percent", advancePercentBp: 2_000,
      });
    });
  });

  describe("the risk limb", () => {
    it("refuses COD outright for a customer over the ceiling", async () => {
      // Build a customer with a history no advance can cure: 30 refusals in
      // 40 deliveries scores 71, over the ceiling of 70.
      const customerId = (
        await post("/v1/customers", {
          fullName: "Serial Refuser", phone: `+97150${suffix.slice(0, 6)}`,
        })
      ).json().id;

      // Ten refusals out of ten scores 80 — comfortably over the ceiling of
      // 70, and the smallest history that gets there. Kept small on purpose:
      // the public checkout route is rate limited (R14.3), and a test that
      // needs 40 orders in a minute is testing the limiter, not the gate.
      for (let i = 0; i < 10; i++) {
        const order = (await placeOrder({})).json();
        const res = await post(`/v1/orders/${order.orderId}/cod-outcome`, {
          customerId,
          outcome: "refused",
          freightCostMinor: 2_500,
          area: i % 2 === 0 ? "Deira" : "Al Quoz",
        });
        expect(res.statusCode).toBe(201);
      }

      const risk = (await get(`/v1/customers/${customerId}/cod-risk`)).json();
      expect(risk.score).toBe(80);
      expect(risk.history).toEqual({ delivered: 0, refused: 10, undeliverable: 0 });

      const quote = (
        await get(`/v1/cod/quote?totalMinor=50000&customerId=${customerId}`)
      ).json();
      expect(quote.allowed).toBe(false);
      expect(quote.reason).toBe("risk_too_high");
      // Honest copy that names the alternative, and does not leak the score.
      expect(quote.message).toContain("card or Tabby");
      expect(quote.message).not.toContain("71");
    });

    it("still offers COD to a customer with a clean record", async () => {
      const customerId = (
        await post("/v1/customers", {
          fullName: "Reliable Buyer", phone: `+97155${suffix.slice(0, 6)}`,
        })
      ).json().id;
      for (let i = 0; i < 8; i++) {
        const order = (await placeOrder({})).json();
        await post(`/v1/orders/${order.orderId}/cod-outcome`, {
          customerId, outcome: "delivered",
          collectedMinor: CART_TOTAL_MINOR, expectedMinor: CART_TOTAL_MINOR,
        });
      }

      const quote = (
        await get(`/v1/cod/quote?totalMinor=50000&customerId=${customerId}`)
      ).json();
      expect(quote.allowed).toBe(true);
      // Eight clean deliveries pull the score well below the prior of 30.
      expect(quote.riskScore).toBeLessThan(15);
    });

    it("refuses every COD order when the policy is switched off", async () => {
      await put("/v1/settings/cod-policy", { enabled: false });

      const res = await placeOrder({ paymentMethod: "cod" });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("COD_NOT_AVAILABLE");
      expect(res.json().reason).toBe("cod_disabled");
      expect(res.json().alternatives).toEqual(["card", "tabby"]);

      await put("/v1/settings/cod-policy", { enabled: true });
    });

    it("refuses above the absolute maximum", async () => {
      await put("/v1/settings/cod-policy", { maxOrderMinor: 100_000 });

      const res = await placeOrder({ paymentMethod: "cod" });
      expect(res.statusCode).toBe(422);
      expect(res.json().reason).toBe("over_maximum");

      // null genuinely clears the cap — it is not the same instruction as
      // "leave it alone", which is what an omitted field means.
      await put("/v1/settings/cod-policy", { maxOrderMinor: null });
      expect((await placeOrder({ paymentMethod: "cod" })).statusCode).toBe(201);
    });
  });

  describe("delivery outcomes", () => {
    it("counts one outcome per order, however many times it is reported", async () => {
      const customerId = (
        await post("/v1/customers", {
          fullName: "Double Reported", phone: `+97152${suffix.slice(0, 6)}`,
        })
      ).json().id;
      const order = (await placeOrder({})).json();

      const first = await post(`/v1/orders/${order.orderId}/cod-outcome`, {
        customerId, outcome: "refused", freightCostMinor: 2_500,
      });
      const second = await post(`/v1/orders/${order.orderId}/cod-outcome`, {
        customerId, outcome: "refused", freightCostMinor: 2_500,
      });

      expect(first.json().recorded).toBe(true);
      // A courier feed that replays must not double-count the customer's
      // reputation or the freight the refusal cost.
      expect(second.json().recorded).toBe(false);

      const risk = (await get(`/v1/customers/${customerId}/cod-risk`)).json();
      expect(risk.history.refused).toBe(1);
    });

    it("reports COD performance with the refusal rate and cost", async () => {
      const report = (await get("/v1/reports/cod-performance?sinceDays=30")).json();

      expect(report.sent).toBeGreaterThan(0);
      expect(report.delivered + report.refused + report.undeliverable).toBe(report.sent);
      // G5's metric: "COD refusal rate under 8%", in basis points so it stays
      // integer-exact like every other rate here.
      expect(report.refusalRateBp).toBeGreaterThanOrEqual(0);
      expect(report.refusalRateBp).toBeLessThanOrEqual(10_000);
      expect(report.costOfRefusalMinor).toBeGreaterThan(0);
      expect(Array.isArray(report.byArea)).toBe(true);
    });

    it("keeps the cost report away from a cashier", async () => {
      await post("/v1/users", {
        email: `pos@${slug}.test`, password: "employee-pass-123",
        fullName: "Cashier", role: "cashier",
      });
      const cashierToken = (
        await app.inject({
          method: "POST", url: "/v1/auth/login",
          payload: { slug, email: `pos@${slug}.test`, password: "employee-pass-123" },
        })
      ).json().accessToken;

      const res = await app.inject({
        method: "GET",
        url: "/v1/reports/cod-performance",
        headers: { authorization: `Bearer ${cashierToken}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("the gateway path is unchanged", () => {
    it("still charges the whole total up front", async () => {
      const res = await placeOrder({});
      expect(res.statusCode).toBe(201);
      const body = res.json();

      expect(body.paymentMethod).toBe("card");
      expect(body.amountDueNowMinor).toBe(CART_TOTAL_MINOR);
      const payments = await paymentsFor(body.orderId);
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({ purpose: "sale", amount_minor: CART_TOTAL_MINOR });
    });
  });
});
