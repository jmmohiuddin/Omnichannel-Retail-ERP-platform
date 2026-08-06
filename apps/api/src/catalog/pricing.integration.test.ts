/**
 * Price-list resolution, product images, and SEO (real PostgreSQL).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("pricing, images, SEO", () => {
  let app: ReturnType<typeof buildPgApp>;
  let token = "";
  let locationId = "";
  let deviceId = "";
  let productId = "";
  let variantId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `price-shop-${suffix}`;

  const authed = () => ({ authorization: `Bearer ${token}` });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    const reg = await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: { tenantName: "Price Shop", slug, fullName: "Owner",
                 email: `owner@${slug}.test`, password: "correct-horse-battery" },
    });
    token = reg.json().accessToken;
    locationId = (await post("/v1/locations", { kind: "store", name: "S", code: "S1" })).json().id;
    deviceId = (await post("/v1/devices", { kind: "pos_register", name: "R1", locationId })).json().id;
    productId = (await post("/v1/products", { name: "Speaker", slug: "speaker", tracking: "none" })).json().id;
    variantId = (await post(`/v1/products/${productId}/variants`, {
      sku: "SP-1", priceMinor: 20000, currency: "AED",
    })).json().id;
    await post("/v1/inventory/movements", {
      id: randomUUID(), movementType: "receipt", variantId, quantity: 10,
      to: { locationId, state: "on_hand" }, reference: { type: "grn", id: randomUUID() },
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it("an active promo price list changes the effective price everywhere", async () => {
    const list = await post("/v1/price-lists", {
      name: "Eid Promo", kind: "promo", currency: "AED",
      startsAt: new Date(Date.now() - 3600_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(list.statusCode).toBe(201);
    const putItems = await app.inject({
      method: "PUT",
      url: `/v1/price-lists/${list.json().priceListId}/items`,
      headers: authed(),
      payload: { items: [{ variantId, priceMinor: 16000 }] },
    });
    expect(putItems.statusCode).toBe(200);

    // Public catalog shows the promo with the original as strike-through.
    const cat = await app.inject({ url: `/v1/public/${slug}/catalog` });
    const variant = cat.json().items[0].variants[0];
    expect(variant.priceMinor).toBe(16000);
    expect(variant.listPriceMinor).toBe(20000);

    // POS: catalog price is now WRONG; promo price is required.
    const atOldPrice = await post("/v1/pos/sales", {
      id: randomUUID(), deviceId, locationId,
      lines: [{ variantId, quantity: 1, unitPriceMinor: 20000 }],
      payments: [{ method: "cash", amountMinor: 20000 }],
    });
    expect(atOldPrice.statusCode).toBe(422);
    expect(atOldPrice.json().error).toBe("PRICE_MISMATCH");

    const atPromo = await post("/v1/pos/sales", {
      id: randomUUID(), deviceId, locationId,
      lines: [{ variantId, quantity: 1, unitPriceMinor: 16000 }],
      payments: [{ method: "cash", amountMinor: 16000 }],
    });
    expect(atPromo.statusCode).toBe(201);

    // Web orders price at the promo too.
    const order = await app.inject({
      method: "POST", url: `/v1/public/${slug}/orders`,
      payload: { customer: { name: "P", email: "p@x.test" }, lines: [{ variantId, quantity: 1 }] },
    });
    expect(order.json().totals.totalMinor).toBe(16000);
  });

  it("an expired promo has no effect", async () => {
    const list = await post("/v1/price-lists", {
      name: "Old Promo", kind: "promo", currency: "AED",
      startsAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      endsAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    await app.inject({
      method: "PUT",
      url: `/v1/price-lists/${list.json().priceListId}/items`,
      headers: authed(),
      payload: { items: [{ variantId, priceMinor: 100 }] },
    });
    const cat = await app.inject({ url: `/v1/public/${slug}/catalog` });
    expect(cat.json().items[0].variants[0].priceMinor).toBe(16000); // still the live promo
  });

  it("images and SEO round-trip into the public catalog", async () => {
    const img = await post(`/v1/products/${productId}/images`, {
      url: "https://cdn.example.test/speaker.jpg", alt: "Speaker front", position: 0,
    });
    expect(img.statusCode).toBe(201);
    const seo = await app.inject({
      method: "PUT", url: `/v1/products/${productId}/seo`, headers: authed(),
      payload: { title: "Speaker — best price in Dubai", keywords: ["speaker", "dubai"] },
    });
    expect(seo.statusCode).toBe(200);

    const cat = await app.inject({ url: `/v1/public/${slug}/catalog` });
    const item = cat.json().items[0];
    expect(item.images[0]).toMatchObject({ url: "https://cdn.example.test/speaker.jpg" });
    expect(item.seo.title).toContain("Dubai");

    const missing = await app.inject({
      method: "PUT", url: `/v1/products/${randomUUID()}/seo`, headers: authed(),
      payload: { title: "x" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("price list index reports item counts", async () => {
    const res = await app.inject({ url: "/v1/price-lists", headers: authed() });
    const eid = res.json().items.find((l: { name: string }) => l.name === "Eid Promo");
    expect(eid.items).toBe(1);
  });
});
