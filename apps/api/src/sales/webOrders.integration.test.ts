/**
 * Public storefront orders + analytics endpoints (real PostgreSQL).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("web orders and analytics", () => {
  let app: ReturnType<typeof buildPgApp>;
  let token = "";
  let locationId = "";
  let variantId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `web-shop-${suffix}`;

  const authed = () => ({ authorization: `Bearer ${token}` });
  const post = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    const reg = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        tenantName: "Web Shop", slug, fullName: "Owner",
        email: `owner@${slug}.test`, password: "correct-horse-battery",
      },
    });
    token = reg.json().accessToken;
    locationId = (await post("/v1/locations", { kind: "warehouse", name: "WH", code: "W1" })).json().id;
    const productId = (
      await post("/v1/products", { name: "Charger Duo", slug: "charger-duo", tracking: "none" })
    ).json().id;
    variantId = (
      await post(`/v1/products/${productId}/variants`, { sku: "CD-1", priceMinor: 10500, currency: "AED" })
    ).json().id;
    await post("/v1/inventory/movements", {
      id: randomUUID(), movementType: "receipt", variantId, quantity: 10,
      to: { locationId, state: "on_hand" },
      reference: { type: "grn", id: randomUUID() },
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it("serves the public catalog without auth", async () => {
    const res = await app.inject({ url: `/v1/public/${slug}/catalog` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenant).toMatchObject({ slug, currency: "AED" });
    const item = body.items.find((i: { name: string }) => i.name === "Charger Duo");
    expect(item.variants[0]).toMatchObject({ sku: "CD-1", priceMinor: 10500, available: 10 });
  });

  it("unknown slug is 404", async () => {
    const res = await app.inject({ url: "/v1/public/no-such-shop/catalog" });
    expect(res.statusCode).toBe(404);
  });

  it("places a web order: reserves stock, prices server-side, computes VAT", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/public/${slug}/orders`,
      payload: {
        customer: { name: "Aisha", email: "aisha@example.test" },
        lines: [{ variantId, quantity: 2 }],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("pending_payment");
    expect(body.totals.totalMinor).toBe(21000);
    expect(body.totals.taxMinor).toBe(1000); // 210.00 AED incl. → 10.00 VAT

    const avail = await app.inject({
      url: `/v1/inventory/availability/${variantId}/${locationId}`,
      headers: authed(),
    });
    expect(avail.json()).toMatchObject({ onHand: 8, reserved: 2 });

    // public catalog now shows reduced availability
    const cat = await app.inject({ url: `/v1/public/${slug}/catalog` });
    const item = cat.json().items.find((i: { name: string }) => i.name === "Charger Duo");
    expect(item.variants[0].available).toBe(8);
  });

  it("rejects an order the stock cannot cover", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/public/${slug}/orders`,
      payload: {
        customer: { name: "Basim", phone: "+9715000000" },
        lines: [{ variantId, quantity: 50 }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("INSUFFICIENT_STOCK");
  });

  it("requires a contact method", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/public/${slug}/orders`,
      payload: { customer: { name: "Nobody" }, lines: [{ variantId, quantity: 1 }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("analytics summary reflects the activity; AI endpoints answer", async () => {
    const summary = await app.inject({ url: "/v1/analytics/summary", headers: authed() });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().today.revenueMinor).toBeGreaterThanOrEqual(21000);
    expect(summary.json().onHandUnits).toBeGreaterThan(0);

    const reorder = await app.inject({
      url: "/v1/ai/reorder-suggestions?windowDays=28&leadTimeDays=7",
      headers: authed(),
    });
    expect(reorder.statusCode).toBe(200);
    expect(Array.isArray(reorder.json().items)).toBe(true);

    const dead = await app.inject({ url: "/v1/ai/dead-stock?thresholdDays=30", headers: authed() });
    expect(dead.statusCode).toBe(200);

    const exceptions = await app.inject({ url: "/v1/reports/exceptions", headers: authed() });
    expect(exceptions.statusCode).toBe(200);
    expect(exceptions.json()).toHaveProperty("refunds");
  });
});
