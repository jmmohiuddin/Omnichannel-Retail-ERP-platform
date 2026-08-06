/**
 * Wholesale price-tier assignment + category management (real PostgreSQL).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("wholesale tiers and categories", () => {
  let app: ReturnType<typeof buildPgApp>;
  let token = "";
  let locationId = "";
  let deviceId = "";
  let productId = "";
  let variantId = "";
  let customerId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `ws-shop-${suffix}`;

  const authed = () => ({ authorization: `Bearer ${token}` });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });

  const sale = (quantity: number, unitPriceMinor: number, withCustomer: boolean) =>
    post("/v1/pos/sales", {
      id: randomUUID(), deviceId, locationId,
      ...(withCustomer ? { customerId } : {}),
      lines: [{ variantId, quantity, unitPriceMinor }],
      payments: [{ method: "cash", amountMinor: Math.round(unitPriceMinor * quantity) }],
    });

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    token = (await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: { tenantName: "WS Shop", slug, fullName: "Owner",
                 email: `owner@${slug}.test`, password: "correct-horse-battery" },
    })).json().accessToken;
    locationId = (await post("/v1/locations", { kind: "store", name: "S", code: "S1" })).json().id;
    deviceId = (await post("/v1/devices", { kind: "pos_register", name: "R1", locationId })).json().id;
    productId = (await post("/v1/products", { name: "Router", slug: "router", tracking: "none" })).json().id;
    variantId = (await post(`/v1/products/${productId}/variants`, {
      sku: "RT-1", priceMinor: 10000, currency: "AED",
    })).json().id;
    await post("/v1/inventory/movements", {
      id: randomUUID(), movementType: "receipt", variantId, quantity: 100,
      to: { locationId, state: "on_hand" }, reference: { type: "grn", id: randomUUID() },
    });
    customerId = (await post("/v1/customers", { fullName: "Bulk Buyer LLC", phone: "+97150111" })).json().id;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it("assigned wholesale list prices the customer's sales by quantity tier", async () => {
    const list = await post("/v1/price-lists", {
      name: "Trade Tier", kind: "wholesale", currency: "AED",
    });
    const priceListId = list.json().priceListId;
    await app.inject({
      method: "PUT", url: `/v1/price-lists/${priceListId}/items`, headers: authed(),
      payload: { items: [
        { variantId, priceMinor: 9000, minQty: 1 },
        { variantId, priceMinor: 8000, minQty: 10 },
      ] },
    });
    const assign = await app.inject({
      method: "PUT", url: `/v1/customers/${customerId}/price-list`, headers: authed(),
      payload: { priceListId },
    });
    expect(assign.statusCode).toBe(200);

    // Walk-in (no customer): retail price still applies.
    expect((await sale(1, 10000, false)).statusCode).toBe(201);

    // Assigned customer at qty 1 → tier 9000 (retail 10000 now rejected).
    expect((await sale(1, 10000, true)).statusCode).toBe(422);
    expect((await sale(1, 9000, true)).statusCode).toBe(201);

    // Qty 10 → deeper tier 8000.
    expect((await sale(10, 9000, true)).statusCode).toBe(422);
    expect((await sale(10, 8000, true)).statusCode).toBe(201);
  });

  it("unassigning restores retail pricing", async () => {
    await app.inject({
      method: "PUT", url: `/v1/customers/${customerId}/price-list`, headers: authed(),
      payload: { priceListId: null },
    });
    expect((await sale(1, 10000, true)).statusCode).toBe(201);
  });

  it("categories: create, assign, filter the public catalog", async () => {
    const cat = await post("/v1/categories", { name: "Networking", slug: "networking" });
    expect(cat.statusCode).toBe(201);
    const other = await post("/v1/categories", { name: "Audio", slug: "audio" });

    const assign = await app.inject({
      method: "PUT", url: `/v1/products/${productId}/category`, headers: authed(),
      payload: { categoryId: cat.json().id },
    });
    expect(assign.statusCode).toBe(200);

    const listed = await app.inject({ url: "/v1/categories", headers: authed() });
    const networking = listed.json().items.find((c: { slug: string }) => c.slug === "networking");
    expect(networking.products).toBe(1);

    const filtered = await app.inject({ url: `/v1/public/${slug}/catalog?category=networking` });
    expect(filtered.json().items).toHaveLength(1);
    expect(filtered.json().items[0].category).toMatchObject({ slug: "networking" });

    const empty = await app.inject({ url: `/v1/public/${slug}/catalog?category=audio` });
    expect(empty.json().items).toHaveLength(0);
    expect(other.statusCode).toBe(201);
  });
});
