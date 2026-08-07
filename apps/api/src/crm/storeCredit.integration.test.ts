/**
 * Store credit ledger on real PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";
import { Db } from "../db.js";
import { StoreCreditError, StoreCreditService } from "./storeCreditService.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("store credit", () => {
  let app: ReturnType<typeof buildPgApp>;
  let db: Db;
  let credit: StoreCreditService;
  let token = "";
  let tenantId = "";
  let userId = "";
  let customerId = "";
  let orderId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `credit-shop-${suffix}`;

  const authed = () => ({ authorization: `Bearer ${token}` });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    db = new Db(APP_URL!);
    credit = new StoreCreditService(db);

    const reg = await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: { tenantName: "Credit Shop", slug, fullName: "Owner",
                 email: `owner@${slug}.test`, password: "correct-horse-battery" },
    });
    token = reg.json().accessToken;
    tenantId = reg.json().tenantId;
    userId = reg.json().userId;
    const cust = await post("/v1/customers", { fullName: "Karim", phone: "+9715012" });
    customerId = cust.json().id;
    // A completed sale to hang redemption off — plain quantity, cash-paid.
    const locationId = (await post("/v1/locations", { kind: "store", name: "S", code: "S1" })).json().id;
    const deviceId = (await post("/v1/devices", { kind: "pos_register", name: "R", locationId })).json().id;
    const productId = (await post("/v1/products", { name: "Cable", slug: "cbl", tracking: "none" })).json().id;
    const variantId = (await post(`/v1/products/${productId}/variants`,
      { sku: "CBL-1", priceMinor: 5000, currency: "AED" })).json().id;
    await post("/v1/inventory/movements", {
      id: randomUUID(), movementType: "receipt", variantId, quantity: 5,
      to: { locationId, state: "on_hand" }, reference: { type: "grn", id: randomUUID() },
    });
    const sale = await post("/v1/pos/sales", {
      id: randomUUID(), deviceId, locationId,
      lines: [{ variantId, quantity: 1, unitPriceMinor: 5000 }],
      payments: [{ method: "cash", amountMinor: 5000 }],
    });
    orderId = sale.json().orderId;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  it("issue creates an account and credits the balance", async () => {
    const res = await credit.issue(tenantId, userId, {
      customerId, amountMinor: 15000, reason: "goodwill: late order",
    });
    expect(res.balanceMinor).toBe(15000);

    const b = await credit.balance(tenantId, customerId);
    expect(b.balanceMinor).toBe(15000);
    expect(b.currency).toBe("AED");
    expect(b.transactions[0]).toMatchObject({ kind: "issue", amountMinor: 15000 });
  });

  it("issue is additive — a second issue adds to the balance", async () => {
    await credit.issue(tenantId, userId, {
      customerId, amountMinor: 5000, reason: "refund preference",
    });
    const b = await credit.balance(tenantId, customerId);
    expect(b.balanceMinor).toBe(20000);
  });

  it("redeemWith debits inside the caller's transaction and is idempotent", async () => {
    await db.withTenant(tenantId, async (c) => {
      const first = await credit.redeemWith(c, tenantId, customerId, orderId, 5000);
      expect(first).toMatchObject({ redeemedMinor: 5000, remainingMinor: 15000 });
      // Replay in the same transaction → same result, no double-debit.
      const replay = await credit.redeemWith(c, tenantId, customerId, orderId, 5000);
      expect(replay.redeemedMinor).toBe(5000);
    });
    const b = await credit.balance(tenantId, customerId);
    expect(b.balanceMinor).toBe(15000);
  });

  it("insufficient balance is rejected without touching the account", async () => {
    await expect(
      db.withTenant(tenantId, (c) =>
        credit.redeemWith(c, tenantId, customerId, randomUUID(), 100_000),
      ),
    ).rejects.toBeInstanceOf(StoreCreditError);
    const b = await credit.balance(tenantId, customerId);
    expect(b.balanceMinor).toBe(15000);
  });

  it("bad amounts are rejected", async () => {
    await expect(
      credit.issue(tenantId, userId, { customerId, amountMinor: 0, reason: "x" }),
    ).rejects.toMatchObject({ code: "BAD_AMOUNT" });
    await expect(
      db.withTenant(tenantId, (c) =>
        credit.redeemWith(c, tenantId, customerId, randomUUID(), -1),
      ),
    ).rejects.toMatchObject({ code: "BAD_AMOUNT" });
  });

  it("unknown customer at issue is rejected before ledger write", async () => {
    await expect(
      credit.issue(tenantId, userId, {
        customerId: randomUUID(), amountMinor: 100, reason: "x",
      }),
    ).rejects.toMatchObject({ code: "CUSTOMER_NOT_FOUND" });
  });

  it("balance for an unknown customer returns zero", async () => {
    const b = await credit.balance(tenantId, randomUUID());
    expect(b.balanceMinor).toBe(0);
    expect(b.transactions).toHaveLength(0);
  });
});
