/**
 * A refund can never exceed what was captured (real PostgreSQL).
 *
 * The previous guard compared against `sales_order.total_minor` — the amount
 * ordered, not the amount paid — and counted only refunds already approved or
 * processed. Three money-loss paths followed, each pinned below:
 *
 *   - refunding an order that was never paid,
 *   - stacking concurrent *pending* requests that each passed the check,
 *   - refunding a card sale as cash out of the drawer.
 *
 * The bound is enforced by a database trigger (026), so these assert the
 * invariant holds even when the application check is bypassed entirely.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { Db } from "../db.js";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("refunds are bounded by captured payments", () => {
  let app: ReturnType<typeof buildPgApp>;
  let db: Db;
  let ownerToken = "";
  let tenantId = "";
  let userId = "";
  let locationId = "";
  let deviceId = "";
  let variantId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `refund-shop-${suffix}`;

  const authed = (t: string) => ({ authorization: `Bearer ${t}` });
  const post = (t: string, url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(t), payload: payload as never });

  /** A completed cash sale of `amountMinor`, returning its order id. */
  async function cashSale(amountMinor: number): Promise<string> {
    const res = await post(ownerToken, "/v1/pos/sales", {
      id: randomUUID(),
      deviceId,
      locationId,
      lines: [{ variantId, quantity: 1, unitPriceMinor: amountMinor }],
      payments: [{ method: "cash", amountMinor }],
    });
    expect(res.statusCode).toBe(201);
    return res.json().orderId;
  }

  /** Insert a refund row directly, bypassing the service guard entirely. */
  const rawRefund = (orderId: string, amountMinor: number, status = "pending") =>
    db.withTenant(tenantId, (c) =>
      c.query(
        `INSERT INTO refund (id, tenant_id, order_id, amount_minor, reason, requested_by, status)
         VALUES ($1,$2,$3,$4,'test',$5,$6)`,
        [randomUUID(), tenantId, orderId, amountMinor, userId, status],
      ),
    );

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    db = new Db(APP_URL!);

    ownerToken = (
      await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        payload: {
          tenantName: "Refund Shop",
          slug,
          fullName: "Owner",
          email: `owner@${slug}.test`,
          password: "correct-horse-battery",
        },
      })
    ).json().accessToken;

    locationId = (
      await post(ownerToken, "/v1/locations", { kind: "store", name: "Naif", code: "NAIF" })
    ).json().id;
    deviceId = (
      await post(ownerToken, "/v1/devices", { kind: "pos_register", name: "Till 1", locationId })
    ).json().id;
    // A register must have an open till before it can take cash (R3.10):
    // cash outside a session escapes the blind-close reconciliation.
    await post(ownerToken, "/v1/cash-sessions", { deviceId, openingFloatMinor: 0 });

    const productId = (
      await post(ownerToken, "/v1/products", {
        name: "Cable",
        slug: `cable-${suffix}`,
        tracking: "none",
      })
    ).json().id;
    variantId = (
      await post(ownerToken, `/v1/products/${productId}/variants`, {
        sku: `CB-${suffix}`,
        priceMinor: 10000,
        currency: "AED",
      })
    ).json().id;

    // Stock to sell — every case below rings a real sale so the captured
    // payment rows the invariant reads are genuine, not hand-inserted.
    await post(ownerToken, "/v1/inventory/receipts", {
      locationId,
      lines: [{ variantId, quantity: 50 }],
    });

    tenantId = await db.withPlatform(async (c) => {
      const { rows } = await c.query<{ id: string }>("SELECT id FROM tenant WHERE slug = $1", [slug]);
      return rows[0]!.id;
    });
    userId = await db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>("SELECT id FROM app_user WHERE email = $1", [
        `owner@${slug}.test`,
      ]);
      return rows[0]!.id;
    });
  }, 30_000);

  afterAll(async () => {
    await db?.close();
    await app?.close();
  });

  it("refuses a refund larger than the captured amount", async () => {
    const orderId = await cashSale(10000);
    const res = await post(ownerToken, `/v1/orders/${orderId}/refunds`, {
      amountMinor: 10001,
      reason: "over-refund attempt",
      method: "cash",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.payload).toContain("EXCEEDS");
  });

  it("allows a refund up to exactly the captured amount", async () => {
    const orderId = await cashSale(10000);
    const res = await post(ownerToken, `/v1/orders/${orderId}/refunds`, {
      amountMinor: 10000,
      reason: "full refund",
      method: "cash",
    });
    expect(res.statusCode).toBe(201);
  });

  it("counts pending requests, so concurrent claims cannot stack", async () => {
    // Regression: the old guard counted only 'approved'/'processed', so N
    // pending full refunds all passed and could then all be approved.
    const orderId = await cashSale(10000);
    const first = await post(ownerToken, `/v1/orders/${orderId}/refunds`, {
      amountMinor: 6000,
      reason: "partial one",
      method: "cash",
    });
    expect(first.statusCode).toBe(201);

    const second = await post(ownerToken, `/v1/orders/${orderId}/refunds`, {
      amountMinor: 6000, // 6000 + 6000 > 10000
      reason: "partial two",
      method: "cash",
    });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
    expect(second.payload).toContain("EXCEEDS");
  });

  it("refuses a tender that was never captured on the order", async () => {
    // Regression: `method` was taken verbatim from the requester, so a card
    // sale could be refunded as cash out of the drawer.
    const orderId = await cashSale(10000);
    const res = await post(ownerToken, `/v1/orders/${orderId}/refunds`, {
      amountMinor: 5000,
      reason: "wrong tender",
      method: "card",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.payload).toContain("TENDER_NOT_ON_ORDER");
  });

  it("permits store credit as the sanctioned fallback tender", async () => {
    const orderId = await cashSale(10000);
    const res = await post(ownerToken, `/v1/orders/${orderId}/refunds`, {
      amountMinor: 5000,
      reason: "credit note",
      method: "store_credit",
    });
    expect(res.statusCode).toBe(201);
  });

  describe("the database enforces the bound, not just the service", () => {
    it("rejects a direct over-refund insert that bypasses the guard", async () => {
      const orderId = await cashSale(10000);
      await expect(rawRefund(orderId, 10001)).rejects.toThrow(/exceeds captured payments/i);
    });

    it("rejects an insert against an order with no captured payment at all", async () => {
      // The old check compared against `total_minor`, so an unpaid order was
      // fully refundable. Build an order with no payment row.
      const orderId = await db.withTenant(tenantId, async (c) => {
        const id = randomUUID();
        const { rows } = await c.query<{ id: string }>("SELECT id FROM channel LIMIT 1");
        await c.query(
          `INSERT INTO sales_order (id, tenant_id, channel_id, order_no, status, currency,
                                    subtotal_minor, discount_minor, tax_minor, total_minor,
                                    location_id, cashier_user_id, device_id, placed_at)
           VALUES ($1,$2,$3,$4,'confirmed','AED',10000,0,0,10000,$5,$6,$7, now())`,
          [id, tenantId, rows[0]!.id, `UNPAID-${suffix}`, locationId, userId, deviceId],
        );
        return id;
      });
      await expect(rawRefund(orderId, 1)).rejects.toThrow(/exceeds captured payments/i);
    });

    it("still allows a rejected refund row, which moves no money", async () => {
      const orderId = await cashSale(10000);
      await expect(rawRefund(orderId, 999999, "rejected")).resolves.toBeDefined();
    });
  });
});
