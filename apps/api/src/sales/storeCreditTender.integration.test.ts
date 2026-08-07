/**
 * Store credit as a POS tender: issue → split payment (credit + cash) → balance.
 * Same discipline as the gift-card tender test — an insufficient debit must
 * roll back the whole sale, stock included.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("store credit tender", () => {
  let app: ReturnType<typeof buildPgApp>;
  let ownerToken = "";
  let managerToken = "";
  let cashierToken = "";
  let locationId = "";
  let deviceId = "";
  let variantId = "";
  let customerId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `sc-shop-${suffix}`;

  const authed = (t: string) => ({ authorization: `Bearer ${t}` });
  const post = (t: string, url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(t), payload: payload as never });

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    const reg = await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: { tenantName: "SC Shop", slug, fullName: "Owner",
                 email: `owner@${slug}.test`, password: "correct-horse-battery" },
    });
    ownerToken = reg.json().accessToken;
    for (const [role, u] of [["manager", "mgr"], ["cashier", "pos"]] as const) {
      await post(ownerToken, "/v1/users", {
        email: `${u}@${slug}.test`, password: "employee-pass-123", fullName: role, role,
      });
      const t = (await app.inject({
        method: "POST", url: "/v1/auth/login",
        payload: { slug, email: `${u}@${slug}.test`, password: "employee-pass-123" },
      })).json().accessToken;
      if (role === "manager") managerToken = t; else cashierToken = t;
    }
    locationId = (await post(ownerToken, "/v1/locations",
      { kind: "store", name: "S", code: "S1" })).json().id;
    deviceId = (await post(ownerToken, "/v1/devices",
      { kind: "pos_register", name: "R1", locationId })).json().id;
    const productId = (await post(ownerToken, "/v1/products",
      { name: "Lamp", slug: "lamp", tracking: "none" })).json().id;
    variantId = (await post(ownerToken, `/v1/products/${productId}/variants`,
      { sku: "LM-1", priceMinor: 10500, currency: "AED" })).json().id;
    await post(ownerToken, "/v1/inventory/movements", {
      id: randomUUID(), movementType: "receipt", variantId, quantity: 10,
      to: { locationId, state: "on_hand" }, reference: { type: "grn", id: randomUUID() },
    });
    customerId = (await post(ownerToken, "/v1/customers",
      { fullName: "Repeat Customer", phone: "+9715099888" })).json().id;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it("cashier cannot issue store credit; manager can", async () => {
    const blocked = await post(cashierToken, `/v1/customers/${customerId}/store-credit`, {
      amountMinor: 5000, reason: "goodwill",
    });
    expect(blocked.statusCode).toBe(403);

    const ok = await post(managerToken, `/v1/customers/${customerId}/store-credit`, {
      amountMinor: 5000, reason: "goodwill: delayed order",
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().balanceMinor).toBe(5000);
  });

  it("split-pays a sale with store credit + cash", async () => {
    const sale = await post(cashierToken, "/v1/pos/sales", {
      id: randomUUID(), deviceId, locationId, customerId,
      lines: [{ variantId, quantity: 1, unitPriceMinor: 10500 }],
      payments: [
        { method: "store_credit", amountMinor: 5000 },
        { method: "cash", amountMinor: 5500 },
      ],
    });
    expect(sale.statusCode).toBe(201);
    const bal = (await app.inject({
      url: `/v1/customers/${customerId}/store-credit`, headers: authed(managerToken),
    })).json();
    expect(bal.balanceMinor).toBe(0);
  });

  it("overspending store credit rolls back the whole sale including stock", async () => {
    // Give a small balance so we can prove the failure path.
    await post(managerToken, `/v1/customers/${customerId}/store-credit`,
      { amountMinor: 1000, reason: "seed for failure test" });
    const before = (await app.inject({
      url: `/v1/inventory/availability/${variantId}/${locationId}`,
      headers: authed(ownerToken),
    })).json().onHand;

    const sale = await post(cashierToken, "/v1/pos/sales", {
      id: randomUUID(), deviceId, locationId, customerId,
      lines: [{ variantId, quantity: 1, unitPriceMinor: 10500 }],
      payments: [{ method: "store_credit", amountMinor: 10500 }],
    });
    expect(sale.statusCode).toBe(422);
    expect(sale.json().error).toBe("INSUFFICIENT_BALANCE");

    const after = (await app.inject({
      url: `/v1/inventory/availability/${variantId}/${locationId}`,
      headers: authed(ownerToken),
    })).json().onHand;
    expect(after).toBe(before);
    // Balance untouched.
    const bal = (await app.inject({
      url: `/v1/customers/${customerId}/store-credit`, headers: authed(managerToken),
    })).json();
    expect(bal.balanceMinor).toBe(1000);
  });

  it("store_credit without an attached customer is rejected", async () => {
    const sale = await post(cashierToken, "/v1/pos/sales", {
      id: randomUUID(), deviceId, locationId,
      lines: [{ variantId, quantity: 1, unitPriceMinor: 10500 }],
      payments: [{ method: "store_credit", amountMinor: 10500 }],
    });
    expect(sale.statusCode).toBe(422);
    expect(sale.json().error).toBe("PAYMENT_MISMATCH");
  });

  it("deep health passes and rate limiter emits headers", async () => {
    const health = await app.inject({ url: "/health/deep" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "healthy" });
    expect(health.json().checks.dbRole.ok).toBe(true);
    expect(health.json().checks.migrations.ok).toBe(true);

    // Rate limit headers on a normal auth'd request.
    const res = await app.inject({ url: "/v1/orders", headers: authed(ownerToken) });
    expect(res.headers["x-ratelimit-limit"]).toBeTruthy();
    expect(res.headers["x-ratelimit-remaining"]).toBeTruthy();
  });
});
