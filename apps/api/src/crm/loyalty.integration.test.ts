/**
 * Loyalty earn/redeem on real PostgreSQL. Skipped without DB env vars.
 * Defaults: earn 1 pt / AED 10 (1000 fils); 1 pt = 5 fils on redemption.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("loyalty", () => {
  let app: ReturnType<typeof buildPgApp>;
  let token = "";
  let locationId = "";
  let deviceId = "";
  let variantId = "";
  let customerId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `loyal-shop-${suffix}`;

  const authed = () => ({ authorization: `Bearer ${token}` });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });

  const saleBody = (payments: unknown[], qty = 1) => ({
    id: randomUUID(), deviceId, locationId, customerId,
    lines: [{ variantId, quantity: qty, unitPriceMinor: 10500 }],
    payments,
  });

  const balance = async () =>
    (await app.inject({ url: `/v1/customers/${customerId}/loyalty`, headers: authed() })).json();

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    const reg = await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: { tenantName: "Loyal Shop", slug, fullName: "Owner",
                 email: `owner@${slug}.test`, password: "correct-horse-battery" },
    });
    token = reg.json().accessToken;
    locationId = (await post("/v1/locations", { kind: "store", name: "S", code: "S1" })).json().id;
    deviceId = (await post("/v1/devices", { kind: "pos_register", name: "R1", locationId })).json().id;
    const productId = (await post("/v1/products", { name: "Case", slug: "case", tracking: "none" })).json().id;
    variantId = (await post(`/v1/products/${productId}/variants`, {
      sku: "CS-1", priceMinor: 10500, currency: "AED",
    })).json().id;
    await post("/v1/inventory/movements", {
      id: randomUUID(), movementType: "receipt", variantId, quantity: 50,
      to: { locationId, state: "on_hand" },
      reference: { type: "grn", id: randomUUID() },
    });
    const customer = await post("/v1/customers", { fullName: "Fatima", phone: "+9715099999" });
    expect(customer.statusCode).toBe(201);
    customerId = customer.json().id;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it("customer search finds the new customer", async () => {
    const res = await app.inject({ url: "/v1/customers?query=fatima", headers: authed() });
    expect(res.json().items[0]).toMatchObject({ fullName: "Fatima", loyaltyPoints: 0 });
  });

  it("a sale with an attached customer earns points on the paid amount", async () => {
    // AED 105.00 → floor(10500/1000) = 10 points
    const sale = await post("/v1/pos/sales", saleBody([{ method: "cash", amountMinor: 10500 }]));
    expect(sale.statusCode).toBe(201);
    const b = await balance();
    expect(b.points).toBe(10);
    expect(b.valueMinor).toBe(50); // 10 pts × 5 fils
    expect(b.history[0]).toMatchObject({ kind: "earn", points: 10 });
  });

  it("redeems points as a payment method and earns only on the rest", async () => {
    // Pay 50 fils via loyalty (all 10 points) + rest cash.
    const sale = await post("/v1/pos/sales", saleBody([
      { method: "loyalty_points", amountMinor: 50 },
      { method: "cash", amountMinor: 10450 },
    ]));
    expect(sale.statusCode).toBe(201);
    const b = await balance();
    // redeemed 10, then earned floor(10450/1000)=10 → net 10
    expect(b.points).toBe(10);
    const kinds = b.history.map((h: { kind: string }) => h.kind);
    expect(kinds.slice(0, 2)).toEqual(expect.arrayContaining(["earn", "redeem"]));
  });

  it("rejects redemption beyond the balance and rolls back the whole sale", async () => {
    const before = await balance();
    const sale = await post("/v1/pos/sales", saleBody([
      { method: "loyalty_points", amountMinor: 5000 }, // needs 1000 pts
      { method: "cash", amountMinor: 5500 },
    ]));
    expect(sale.statusCode).toBe(422);
    expect(sale.json().error).toBe("INSUFFICIENT_POINTS");
    const after = await balance();
    expect(after.points).toBe(before.points);

    const avail = await app.inject({
      url: `/v1/inventory/availability/${variantId}/${locationId}`,
      headers: authed(),
    });
    expect(avail.json().onHand).toBe(48); // only the two successful sales sold
  });

  it("loyalty payment without an attached customer is rejected", async () => {
    const sale = await post("/v1/pos/sales", {
      ...saleBody([{ method: "loyalty_points", amountMinor: 50 },
                   { method: "cash", amountMinor: 10450 }]),
      customerId: undefined,
    });
    expect(sale.statusCode).toBe(422);
  });

  it("accrual is idempotent under offline replay", async () => {
    const body = saleBody([{ method: "cash", amountMinor: 10500 }]);
    await post("/v1/pos/sales", body);
    const b1 = await balance();
    const replay = await post("/v1/pos/sales", body);
    expect(replay.statusCode).toBe(200); // duplicate
    const b2 = await balance();
    expect(b2.points).toBe(b1.points);
  });
});
