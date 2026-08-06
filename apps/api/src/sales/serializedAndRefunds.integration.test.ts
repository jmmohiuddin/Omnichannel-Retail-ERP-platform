/**
 * Serialized (IMEI) sale path + refund approval workflow, on real PostgreSQL.
 * Skipped without ADMIN_DATABASE_URL / DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

// Valid-Luhn IMEIs (GSMA example + derivatives with recomputed check digits).
const IMEI_A = "490154203237518";
const IMEI_B = "352099001761481";
const IMEI_C = "990000862471854";

describe.skipIf(!run)("serialized sales and refunds", () => {
  let app: ReturnType<typeof buildPgApp>;
  let ownerToken = "";
  let managerToken = "";
  let cashierToken = "";
  let locationId = "";
  let deviceId = "";
  let phoneVariantId = "";
  let unitA = "";
  let saleId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `imei-shop-${suffix}`;

  const authed = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (token: string, url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: authed(token), payload: payload as never });

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
        tenantName: "IMEI Shop", slug, fullName: "Owner",
        email: `owner@${slug}.test`, password: "correct-horse-battery",
      },
    });
    ownerToken = reg.json().accessToken;

    // Employees
    for (const [role, email] of [["manager", "mgr"], ["cashier", "pos"]] as const) {
      const res = await post(ownerToken, "/v1/users", {
        email: `${email}@${slug}.test`, password: "employee-pass-123",
        fullName: role, role,
      });
      expect(res.statusCode).toBe(201);
      const login = await app.inject({
        method: "POST", url: "/v1/auth/login",
        payload: { slug, email: `${email}@${slug}.test`, password: "employee-pass-123" },
      });
      if (role === "manager") managerToken = login.json().accessToken;
      else cashierToken = login.json().accessToken;
    }

    locationId = (await post(ownerToken, "/v1/locations", { kind: "store", name: "Shop", code: "S1" })).json().id;
    deviceId = (await post(ownerToken, "/v1/devices", { kind: "pos_register", name: "R1", locationId })).json().id;
    const productId = (
      await post(ownerToken, "/v1/products", { name: "Phone Z", slug: "phone-z", tracking: "serialized" })
    ).json().id;
    phoneVariantId = (
      await post(ownerToken, `/v1/products/${productId}/variants`, { sku: "PZ-1", priceMinor: 210000, currency: "AED" })
    ).json().id;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it("receives serialized units by IMEI and rejects duplicates", async () => {
    const res = await post(ownerToken, "/v1/inventory/receipts", {
      locationId,
      lines: [{
        variantId: phoneVariantId,
        units: [{ imei1: IMEI_A, unitCostMinor: 150000 }, { imei1: IMEI_B }],
      }],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().unitIds).toHaveLength(2);
    unitA = res.json().unitIds[0];

    const avail = await app.inject({
      url: `/v1/inventory/availability/${phoneVariantId}/${locationId}`,
      headers: authed(ownerToken),
    });
    expect(avail.json().onHand).toBe(2);

    // Same IMEI again — DB partial unique index says no.
    const dup = await post(ownerToken, "/v1/inventory/receipts", {
      locationId,
      lines: [{ variantId: phoneVariantId, units: [{ imei1: IMEI_A }] }],
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("DUPLICATE_IMEI");

    // Invalid Luhn rejected before touching the DB.
    const bad = await post(ownerToken, "/v1/inventory/receipts", {
      locationId,
      lines: [{ variantId: phoneVariantId, units: [{ imei1: "490154203237519" }] }],
    });
    expect(bad.statusCode).toBe(400);
  });

  it("resolves a unit by scanning either IMEI", async () => {
    const res = await app.inject({
      url: `/v1/stock-units?imei=${IMEI_A}`,
      headers: authed(cashierToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: unitA, sku: "PZ-1", state: "in_stock" });
  });

  it("refuses to sell a serialized variant without a scanned unit", async () => {
    const res = await post(cashierToken, "/v1/pos/sales", {
      id: randomUUID(), deviceId, locationId,
      lines: [{ variantId: phoneVariantId, quantity: 1, unitPriceMinor: 210000 }],
      payments: [{ method: "cash", amountMinor: 210000 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("SERIALIZED_REQUIRED");
  });

  it("sells the exact scanned unit and prevents double-selling it", async () => {
    saleId = randomUUID();
    const res = await post(cashierToken, "/v1/pos/sales", {
      id: saleId, deviceId, locationId,
      lines: [{ variantId: phoneVariantId, quantity: 1, unitPriceMinor: 210000, stockUnitId: unitA }],
      payments: [{ method: "card", amountMinor: 210000 }],
    });
    expect(res.statusCode).toBe(201);

    const unit = await app.inject({
      url: `/v1/stock-units?imei=${IMEI_A}`,
      headers: authed(cashierToken),
    });
    expect(unit.json().state).toBe("sold");

    const again = await post(cashierToken, "/v1/pos/sales", {
      id: randomUUID(), deviceId, locationId,
      lines: [{ variantId: phoneVariantId, quantity: 1, unitPriceMinor: 210000, stockUnitId: unitA }],
      payments: [{ method: "cash", amountMinor: 210000 }],
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("UNIT_UNAVAILABLE");

    const avail = await app.inject({
      url: `/v1/inventory/availability/${phoneVariantId}/${locationId}`,
      headers: authed(ownerToken),
    });
    expect(avail.json().onHand).toBe(1);
  });

  it("refund request goes to pending approval; cashier cannot decide; requester cannot self-approve", async () => {
    const req = await post(cashierToken, `/v1/orders/${saleId}/refunds`, {
      amountMinor: 210000, reason: "Customer returned the phone", method: "card",
      restock: [{ variantId: phoneVariantId, quantity: 1, stockUnitId: unitA }],
    });
    expect(req.statusCode).toBe(201);
    const { approvalId, status } = req.json();
    expect(status).toBe("pending");

    const pending = await app.inject({ url: "/v1/approvals", headers: authed(managerToken) });
    expect(pending.json().items.some((a: { id: string }) => a.id === approvalId)).toBe(true);

    const byCashier = await post(cashierToken, `/v1/approvals/${approvalId}/decision`, { approve: true });
    expect(byCashier.statusCode).toBe(403);
    expect(byCashier.json().error).toBe("FORBIDDEN_ROLE");

    // Owner requests one themselves, then tries to approve it: blocked.
    const own = await post(ownerToken, `/v1/orders/${saleId}/refunds`, {
      amountMinor: 1, reason: "self-approval probe", method: "cash",
    });
    const selfDecide = await post(ownerToken, `/v1/approvals/${own.json().approvalId}/decision`, { approve: true });
    expect(selfDecide.statusCode).toBe(403);
    expect(selfDecide.json().error).toBe("SELF_APPROVAL");

    // Manager approves the real one → refund processes atomically.
    const decide = await post(managerToken, `/v1/approvals/${approvalId}/decision`, { approve: true });
    expect(decide.statusCode).toBe(200);
    expect(decide.json().status).toBe("approved");

    // Deciding twice is a conflict.
    const twice = await post(managerToken, `/v1/approvals/${approvalId}/decision`, { approve: true });
    expect(twice.statusCode).toBe(409);
  });

  it("processed refund restocked the unit as returned_pending and updated the order", async () => {
    const unit = await app.inject({
      url: `/v1/stock-units?imei=${IMEI_A}`,
      headers: authed(managerToken),
    });
    expect(unit.json().state).toBe("returned_pending");

    const avail = await app.inject({
      url: `/v1/inventory/availability/${phoneVariantId}/${locationId}`,
      headers: authed(ownerToken),
    });
    expect(avail.json().returnedPending).toBe(1);
    expect(avail.json().onHand).toBe(1); // returned unit is NOT sellable yet

    const receipt = await app.inject({
      url: `/v1/orders/${saleId}/receipt`,
      headers: authed(ownerToken),
    });
    const payments = receipt.json().payments as { method: string; amountMinor: number }[];
    expect(payments.some((p) => p.amountMinor === -210000)).toBe(true);
  });

  it("refund exceeding the order total is rejected", async () => {
    const res = await post(cashierToken, `/v1/orders/${saleId}/refunds`, {
      amountMinor: 999999, reason: "too much", method: "cash",
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("AMOUNT_EXCEEDS_ORDER");
  });
});
