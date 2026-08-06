/**
 * Gift-card ledger on real PostgreSQL. Skipped without DB env vars.
 * Tenant is provisioned over buildPgApp HTTP (same pattern as
 * loyalty.integration.test.ts); the GiftCardService is then driven directly
 * with a Db on DATABASE_URL, and redeemWith runs on raw transaction clients
 * via db.withTenant — exactly how the POS sale flow will call it.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";
import { Db } from "../db.js";
import { GiftCardError, GiftCardService } from "./giftCardService.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

const CODE_RE = /^GC-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

describe.skipIf(!run)("gift cards", () => {
  let app: ReturnType<typeof buildPgApp>;
  let db: Db;
  let admin: pg.Pool;
  let svc: GiftCardService;
  let token = "";
  let tenantId = "";
  let userId = "";
  let locationId = "";
  let deviceId = "";
  let variantId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `gift-shop-${suffix}`;

  // Card driven through tests: issue → partial redeem → exact depletion.
  let cardCode = "";
  let cardId = "";

  const authed = () => ({ authorization: `Bearer ${token}` });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });

  /** Create a real cash sale so redemptions have a sales_order to reference. */
  const makeOrder = async (): Promise<string> => {
    const id = randomUUID();
    const sale = await post("/v1/pos/sales", {
      id, deviceId, locationId,
      lines: [{ variantId, quantity: 1, unitPriceMinor: 10500 }],
      payments: [{ method: "cash", amountMinor: 10500 }],
    });
    expect(sale.statusCode).toBe(201);
    return id;
  };

  const redeem = (code: string, orderId: string, amountMinor: number) =>
    db.withTenant(tenantId, (c) => svc.redeemWith(c, tenantId, code, orderId, amountMinor));

  const expectGiftCardError = async (p: Promise<unknown>, code: GiftCardError["code"]) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GiftCardError);
    expect((err as GiftCardError).code).toBe(code);
  };

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    db = new Db(APP_URL!);
    admin = new pg.Pool({ connectionString: ADMIN_URL!, max: 2 });
    svc = new GiftCardService(db);

    const reg = await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: { tenantName: "Gift Shop", slug, fullName: "Owner",
                 email: `owner@${slug}.test`, password: "correct-horse-battery" },
    });
    expect(reg.statusCode).toBe(201);
    ({ accessToken: token, tenantId, userId } = reg.json());

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
  }, 30_000);

  afterAll(async () => {
    await admin?.end();
    await db?.close();
    await app?.close();
  });

  it("issues a card: GC-XXXX-XXXX-XXXX code, full balance, issue ledger row", async () => {
    const issued = await svc.issue(tenantId, userId, { amountMinor: 10000 }); // AED 100
    cardCode = issued.code;
    cardId = issued.giftCardId;
    expect(issued.code).toMatch(CODE_RE);
    expect(issued.balanceMinor).toBe(10000);
    const b = await svc.balance(tenantId, cardCode);
    expect(b).toMatchObject({
      giftCardId: cardId, status: "active", balanceMinor: 10000,
      initialMinor: 10000, currency: "AED", expired: false,
    });
    expect(b.transactions).toHaveLength(1);
    expect(b.transactions[0]).toMatchObject({ kind: "issue", amountMinor: 10000 });
  });

  it("rejects a non-positive issue amount with BAD_AMOUNT", async () => {
    await expectGiftCardError(svc.issue(tenantId, userId, { amountMinor: 0 }), "BAD_AMOUNT");
    await expectGiftCardError(svc.issue(tenantId, userId, { amountMinor: -500 }), "BAD_AMOUNT");
  });

  it("balance lookup is case-insensitive on the code", async () => {
    const b = await svc.balance(tenantId, cardCode.toLowerCase());
    expect(b.giftCardId).toBe(cardId);
    expect(b.code).toBe(cardCode); // stored upper-case
  });

  it("partial redemption debits the balance and writes a redeem ledger row", async () => {
    const orderId = await makeOrder();
    const r = await redeem(cardCode, orderId, 3500);
    expect(r).toEqual({ redeemedMinor: 3500, remainingMinor: 6500 });
    const b = await svc.balance(tenantId, cardCode);
    expect(b.status).toBe("active");
    expect(b.balanceMinor).toBe(6500);
    expect(b.transactions[0]).toMatchObject({ kind: "redeem", amountMinor: -3500, orderId });
  });

  it("redeeming beyond the balance fails with INSUFFICIENT_BALANCE and changes nothing", async () => {
    await expectGiftCardError(redeem(cardCode, randomUUID(), 6501), "INSUFFICIENT_BALANCE");
    const b = await svc.balance(tenantId, cardCode);
    expect(b.balanceMinor).toBe(6500);
    expect(b.status).toBe("active");
    expect(b.transactions.filter((t) => t.kind === "redeem")).toHaveLength(1);
  });

  it("exact depletion flips the card to 'depleted'", async () => {
    const orderId = await makeOrder();
    const r = await redeem(cardCode, orderId, 6500);
    expect(r).toEqual({ redeemedMinor: 6500, remainingMinor: 0 });
    const b = await svc.balance(tenantId, cardCode);
    expect(b.status).toBe("depleted");
    expect(b.balanceMinor).toBe(0);
  });

  it("redeeming a depleted card fails with CARD_NOT_ACTIVE", async () => {
    await expectGiftCardError(redeem(cardCode, randomUUID(), 100), "CARD_NOT_ACTIVE");
  });

  it("redeeming an expired card fails with CARD_EXPIRED", async () => {
    const issued = await svc.issue(tenantId, userId, { amountMinor: 5000 });
    await admin.query(
      "UPDATE gift_card SET expires_at = CURRENT_DATE - 1 WHERE id = $1",
      [issued.giftCardId],
    );
    await expectGiftCardError(redeem(issued.code, randomUUID(), 1000), "CARD_EXPIRED");
    const b = await svc.balance(tenantId, issued.code);
    expect(b.expired).toBe(true);
    expect(b.balanceMinor).toBe(5000); // untouched
  });

  it("replaying the same (order, card) redemption does not double-debit", async () => {
    const issued = await svc.issue(tenantId, userId, { amountMinor: 8000 });
    const orderId = await makeOrder();
    const first = await redeem(issued.code, orderId, 3000);
    expect(first).toEqual({ redeemedMinor: 3000, remainingMinor: 5000 });
    const replay = await redeem(issued.code, orderId, 3000);
    expect(replay).toEqual({ redeemedMinor: 3000, remainingMinor: 5000 });
    const b = await svc.balance(tenantId, issued.code);
    expect(b.balanceMinor).toBe(5000);
    expect(b.transactions.filter((t) => t.kind === "redeem")).toHaveLength(1);
  });

  it("unknown code fails with CARD_NOT_FOUND", async () => {
    await expectGiftCardError(svc.balance(tenantId, "GC-ZZZZ-ZZZZ-ZZZZ"), "CARD_NOT_FOUND");
    await expectGiftCardError(redeem("GC-ZZZZ-ZZZZ-ZZZZ", randomUUID(), 100), "CARD_NOT_FOUND");
  });

  it("cancel zeroes the balance via a cancel ledger row and blocks redemption", async () => {
    const issued = await svc.issue(tenantId, userId, { amountMinor: 2500 });
    const cancelled = await svc.cancel(tenantId, userId, issued.giftCardId, "customer refunded");
    expect(cancelled).toEqual({ cancelledMinor: 2500 });
    const b = await svc.balance(tenantId, issued.code);
    expect(b.status).toBe("cancelled");
    expect(b.balanceMinor).toBe(0);
    expect(b.transactions[0]).toMatchObject({ kind: "cancel", amountMinor: -2500 });
    await expectGiftCardError(redeem(issued.code, randomUUID(), 100), "CARD_NOT_ACTIVE");
    await expectGiftCardError(
      svc.cancel(tenantId, userId, issued.giftCardId, "again"), "CARD_NOT_ACTIVE");
  });
});
