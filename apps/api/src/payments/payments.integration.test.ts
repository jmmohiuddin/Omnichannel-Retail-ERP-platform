/**
 * Payment capture flow on real PostgreSQL with the mock gateway:
 * order → intent → signed webhook → captured payment + confirmed order.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";
import { MockGateway } from "./gatewayPort.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

const SECRET = "integration-webhook-secret-123";

describe.skipIf(!run)("payment capture", () => {
  let app: ReturnType<typeof buildPgApp>;
  let token = "";
  let locationId = "";
  let variantId = "";
  let orderId = "";
  let gatewayRef = "";
  const signer = new MockGateway(SECRET);
  const suffix = randomUUID().slice(0, 8);
  const slug = `pay-shop-${suffix}`;

  const authed = () => ({ authorization: `Bearer ${token}` });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });

  const webhook = (body: Record<string, unknown>, signature?: string) => {
    const raw = JSON.stringify(body);
    return app.inject({
      method: "POST",
      url: "/v1/webhooks/payments/mock",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature ?? signer.sign(raw),
      },
      payload: raw,
    });
  };

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
      paymentWebhookSecret: SECRET,
    });
    const reg = await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: { tenantName: "Pay Shop", slug, fullName: "Owner",
                 email: `owner@${slug}.test`, password: "correct-horse-battery" },
    });
    token = reg.json().accessToken;
    locationId = (await post("/v1/locations", { kind: "warehouse", name: "W", code: "W1" })).json().id;
    const productId = (await post("/v1/products", { name: "Buds", slug: "buds", tracking: "none" })).json().id;
    variantId = (await post(`/v1/products/${productId}/variants`, {
      sku: "BD-1", priceMinor: 21000, currency: "AED",
    })).json().id;
    await post("/v1/inventory/movements", {
      id: randomUUID(), movementType: "receipt", variantId, quantity: 10,
      to: { locationId, state: "on_hand" },
      reference: { type: "grn", id: randomUUID() },
    });
    const order = await app.inject({
      method: "POST", url: `/v1/public/${slug}/orders`,
      payload: { customer: { name: "Payer", email: "p@x.test" }, lines: [{ variantId, quantity: 1 }] },
    });
    orderId = order.json().orderId;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it("creates a payment intent with a hosted-checkout redirect", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/public/${slug}/orders/${orderId}/pay`,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    gatewayRef = res.json().gatewayRef;
    expect(gatewayRef).toMatch(/^mock_/);
    expect(res.json().redirectUrl).toContain(gatewayRef);

    // Only one live intent per order.
    const dupe = await app.inject({
      method: "POST",
      url: `/v1/public/${slug}/orders/${orderId}/pay`,
      payload: {},
    });
    expect(dupe.statusCode).toBe(409);
  });

  it("rejects webhooks with a bad signature", async () => {
    const res = await webhook(
      { id: `evt-${suffix}-bad`, type: "payment.succeeded", gatewayRef },
      "deadbeef".repeat(8),
    );
    expect(res.statusCode).toBe(401);

    const order = await app.inject({ url: "/v1/orders?status=pending", headers: authed() });
    expect(order.json().items.some((o: { id: string }) => o.id === orderId)).toBe(true);
  });

  it("a signed success webhook captures payment and confirms the order", async () => {
    const res = await webhook({ id: `evt-${suffix}-1`, type: "payment.succeeded", gatewayRef });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toBe("captured");

    const confirmed = await app.inject({ url: "/v1/orders?status=confirmed", headers: authed() });
    expect(confirmed.json().items.some((o: { id: string }) => o.id === orderId)).toBe(true);

    const receipt = await app.inject({ url: `/v1/orders/${orderId}/receipt`, headers: authed() });
    const payments = receipt.json().payments as { method: string; amountMinor: number }[];
    expect(payments[0]).toMatchObject({ method: "gateway", amountMinor: 21000 });
  });

  it("replayed webhook deliveries are idempotent", async () => {
    const res = await webhook({ id: `evt-${suffix}-1`, type: "payment.succeeded", gatewayRef });
    expect(res.statusCode).toBe(200);
    expect(res.json().duplicate).toBe(true);
  });

  it("a paid (confirmed) order can be fulfilled", async () => {
    const res = await post(`/v1/orders/${orderId}/fulfill`, {});
    expect(res.statusCode).toBe(200);
    const avail = await app.inject({
      url: `/v1/inventory/availability/${variantId}/${locationId}`,
      headers: authed(),
    });
    expect(avail.json()).toMatchObject({ onHand: 9, reserved: 0 });
  });

  it("failure webhooks mark the intent failed without touching the order", async () => {
    // New order + intent
    const order2 = await app.inject({
      method: "POST", url: `/v1/public/${slug}/orders`,
      payload: { customer: { name: "Payer2", email: "p2@x.test" }, lines: [{ variantId, quantity: 1 }] },
    });
    const o2 = order2.json().orderId;
    const intent = await app.inject({
      method: "POST", url: `/v1/public/${slug}/orders/${o2}/pay`, payload: {},
    });
    const ref2 = intent.json().gatewayRef;

    const res = await webhook({ id: `evt-${suffix}-2`, type: "payment.failed", gatewayRef: ref2 });
    expect(res.json().result).toBe("failed");

    const pending = await app.inject({ url: "/v1/orders?status=pending", headers: authed() });
    expect(pending.json().items.some((o: { id: string }) => o.id === o2)).toBe(true);
  });

  it("webhooks for unknown refs are acknowledged without effect", async () => {
    const res = await webhook({ id: `evt-${suffix}-3`, type: "payment.succeeded", gatewayRef: "mock_nope" });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toBe("intent_not_found");
  });
});
