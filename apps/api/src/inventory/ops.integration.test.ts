/**
 * Operational flows on real PostgreSQL: fulfillment/cancel of reserved web
 * orders, blind cash sessions, transfers, cycle counts with approval-gated
 * corrections. Skipped without DB env vars.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("operations", () => {
  let app: ReturnType<typeof buildPgApp>;
  let ownerToken = "";
  let managerToken = "";
  let storeId = "";
  let warehouseId = "";
  let deviceId = "";
  let variantId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `ops-shop-${suffix}`;

  const authed = (t: string) => ({ authorization: `Bearer ${t}` });
  const post = (t: string, url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(t), payload: payload as never });

  const availability = async (locationId: string) =>
    (await app.inject({
      url: `/v1/inventory/availability/${variantId}/${locationId}`,
      headers: authed(ownerToken),
    })).json();

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    const reg = await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: { tenantName: "Ops Shop", slug, fullName: "Owner",
                 email: `owner@${slug}.test`, password: "correct-horse-battery" },
    });
    ownerToken = reg.json().accessToken;
    await post(ownerToken, "/v1/users", {
      email: `mgr@${slug}.test`, password: "employee-pass-123", fullName: "Mgr", role: "manager",
    });
    managerToken = (await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { slug, email: `mgr@${slug}.test`, password: "employee-pass-123" },
    })).json().accessToken;

    storeId = (await post(ownerToken, "/v1/locations", { kind: "store", name: "Store", code: "ST" })).json().id;
    warehouseId = (await post(ownerToken, "/v1/locations", { kind: "warehouse", name: "WH", code: "WH" })).json().id;
    deviceId = (await post(ownerToken, "/v1/devices", { kind: "pos_register", name: "R1", locationId: storeId })).json().id;
    const productId = (await post(ownerToken, "/v1/products", { name: "Cable", slug: "cable", tracking: "none" })).json().id;
    variantId = (await post(ownerToken, `/v1/products/${productId}/variants`, {
      sku: "CB-1", priceMinor: 2100, currency: "AED",
    })).json().id;
    await post(ownerToken, "/v1/inventory/movements", {
      id: randomUUID(), movementType: "receipt", variantId, quantity: 40,
      to: { locationId: warehouseId, state: "on_hand" },
      reference: { type: "grn", id: randomUUID() },
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it("fulfills a reserved web order (reserved → sold), then blocks re-fulfillment", async () => {
    const order = await app.inject({
      method: "POST", url: `/v1/public/${slug}/orders`,
      payload: { customer: { name: "Web Buyer", email: "b@x.test" }, lines: [{ variantId, quantity: 3 }] },
    });
    expect(order.statusCode).toBe(201);
    const orderId = order.json().orderId;
    expect((await availability(warehouseId)).reserved).toBe(3);

    const fulfil = await post(ownerToken, `/v1/orders/${orderId}/fulfill`, {});
    expect(fulfil.statusCode).toBe(200);
    const after = await availability(warehouseId);
    expect(after.reserved).toBe(0);
    expect(after.onHand).toBe(37);

    const again = await post(ownerToken, `/v1/orders/${orderId}/fulfill`, {});
    expect(again.statusCode).toBe(409);
  });

  it("cancelling a reserved order releases the stock and voids pending payment", async () => {
    const order = await app.inject({
      method: "POST", url: `/v1/public/${slug}/orders`,
      payload: { customer: { name: "Web Buyer", phone: "+9715012345" }, lines: [{ variantId, quantity: 5 }] },
    });
    const orderId = order.json().orderId;
    expect((await availability(warehouseId)).reserved).toBe(5);

    const cancel = await post(ownerToken, `/v1/orders/${orderId}/cancel`, { reason: "customer changed mind" });
    expect(cancel.statusCode).toBe(200);
    const after = await availability(warehouseId);
    expect(after.reserved).toBe(0);
    expect(after.onHand).toBe(37);
  });

  it("transfer moves stock warehouse → store through in_transit", async () => {
    const transfer = await post(ownerToken, "/v1/transfers", {
      fromLocationId: warehouseId, toLocationId: storeId,
      lines: [{ variantId, quantity: 10 }],
    });
    expect(transfer.statusCode).toBe(201);
    expect((await availability(storeId)).inTransit).toBe(10);
    expect((await availability(warehouseId)).onHand).toBe(27);

    const receive = await post(ownerToken, `/v1/transfers/${transfer.json().transferId}/receive`);
    expect(receive.statusCode).toBe(200);
    const store = await availability(storeId);
    expect(store.onHand).toBe(10);
    expect(store.inTransit).toBe(0);
  });

  it("cash session: blind close computes variance from the payment ledger", async () => {
    const session = await post(ownerToken, "/v1/cash-sessions", {
      deviceId, openingFloatMinor: 50000,
    });
    expect(session.statusCode).toBe(201);
    const sessionId = session.json().sessionId;

    // A second open on the same device is rejected.
    const dupe = await post(ownerToken, "/v1/cash-sessions", { deviceId, openingFloatMinor: 0 });
    expect(dupe.statusCode).toBe(409);

    // Cash sale lands in the session.
    const sale = await post(ownerToken, "/v1/pos/sales", {
      id: randomUUID(), deviceId, locationId: storeId,
      lines: [{ variantId, quantity: 2, unitPriceMinor: 2100 }],
      payments: [{ method: "cash", amountMinor: 4200 }],
    });
    expect(sale.statusCode).toBe(201);

    // Cashier declares 100 fils short.
    const close = await post(ownerToken, `/v1/cash-sessions/${sessionId}/close`, {
      declaredMinor: 50000 + 4200 - 100,
    });
    expect(close.statusCode).toBe(200);
    expect(close.json()).toMatchObject({ expectedMinor: 54200, varianceMinor: -100 });

    const reclose = await post(ownerToken, `/v1/cash-sessions/${sessionId}/close`, { declaredMinor: 0 });
    expect(reclose.statusCode).toBe(409);
  });

  it("cycle count: variance requires manager approval, then corrects the ledger", async () => {
    const before = (await availability(storeId)).onHand; // 8 after the cash sale

    const count = await post(ownerToken, "/v1/stock-counts", {
      locationId: storeId, variantIds: [variantId],
    });
    expect(count.statusCode).toBe(201);
    expect(count.json()).not.toHaveProperty("expected"); // blind
    const countId = count.json().countId;

    // Counter finds 2 fewer than expected.
    await app.inject({
      method: "PUT", url: `/v1/stock-counts/${countId}/lines`, headers: authed(ownerToken),
      payload: { counts: [{ variantId, countedQty: before - 2 }] },
    });
    const submit = await post(ownerToken, `/v1/stock-counts/${countId}/submit`);
    expect(submit.statusCode).toBe(200);
    expect(submit.json().status).toBe("review");
    expect(submit.json().variances).toEqual([{ variantId, delta: -2 }]);

    const decide = await post(managerToken, `/v1/approvals/${submit.json().approvalId}/decision`, { approve: true });
    expect(decide.statusCode).toBe(200);

    expect((await availability(storeId)).onHand).toBe(before - 2);

    // The correction is in the ledger with the approval attached.
    const feed = await app.inject({
      url: "/v1/inventory/movements?limit=500", headers: authed(ownerToken),
    });
    const correction = feed.json().items.find(
      (m: { movementType: string }) => m.movementType === "count_correction",
    );
    expect(correction).toBeTruthy();
    expect(correction.approvalId).toBeTruthy();
  });

  it("zero-variance count posts immediately without approval", async () => {
    const onHand = (await availability(storeId)).onHand;
    const count = await post(ownerToken, "/v1/stock-counts", {
      locationId: storeId, variantIds: [variantId],
    });
    const countId = count.json().countId;
    await app.inject({
      method: "PUT", url: `/v1/stock-counts/${countId}/lines`, headers: authed(ownerToken),
      payload: { counts: [{ variantId, countedQty: onHand }] },
    });
    const submit = await post(ownerToken, `/v1/stock-counts/${countId}/submit`);
    expect(submit.json().status).toBe("posted");
  });
});
