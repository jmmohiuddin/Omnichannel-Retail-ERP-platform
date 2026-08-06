/**
 * POS price enforcement, discount approval band, warranty stamping, and the
 * repair lifecycle (real PostgreSQL).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

const IMEI = "490154203237518";

describe.skipIf(!run)("price controls, warranty, repairs", () => {
  let app: ReturnType<typeof buildPgApp>;
  let cashierToken = "";
  let managerToken = "";
  let locationId = "";
  let deviceId = "";
  let plainVariantId = "";
  let phoneVariantId = "";
  let unitId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `ctrl-shop-${suffix}`;

  const authed = (t: string) => ({ authorization: `Bearer ${t}` });
  const post = (t: string, url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(t), payload: payload as never });

  const sale = (lines: unknown[], amountMinor: number) =>
    post(cashierToken, "/v1/pos/sales", {
      id: randomUUID(), deviceId, locationId, lines,
      payments: [{ method: "cash", amountMinor }],
    });

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    const reg = await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: { tenantName: "Ctrl Shop", slug, fullName: "Owner",
                 email: `owner@${slug}.test`, password: "correct-horse-battery" },
    });
    const ownerToken = reg.json().accessToken;
    for (const [role, email] of [["manager", "mgr"], ["cashier", "pos"]] as const) {
      await post(ownerToken, "/v1/users", {
        email: `${email}@${slug}.test`, password: "employee-pass-123", fullName: role, role,
      });
      const login = await app.inject({
        method: "POST", url: "/v1/auth/login",
        payload: { slug, email: `${email}@${slug}.test`, password: "employee-pass-123" },
      });
      if (role === "manager") managerToken = login.json().accessToken;
      else cashierToken = login.json().accessToken;
    }
    locationId = (await post(ownerToken, "/v1/locations", { kind: "store", name: "S", code: "S1" })).json().id;
    deviceId = (await post(ownerToken, "/v1/devices", { kind: "pos_register", name: "R1", locationId })).json().id;

    const plainProduct = (await post(ownerToken, "/v1/products",
      { name: "Cover", slug: "cover", tracking: "none" })).json().id;
    plainVariantId = (await post(ownerToken, `/v1/products/${plainProduct}/variants`,
      { sku: "CV-1", priceMinor: 10000, currency: "AED" })).json().id;

    const phoneProduct = (await post(ownerToken, "/v1/products",
      { name: "Phone W", slug: "phone-w", tracking: "serialized" })).json().id;
    phoneVariantId = (await post(ownerToken, `/v1/products/${phoneProduct}/variants`,
      { sku: "PW-1", priceMinor: 105000, currency: "AED", warrantyMonths: 12 })).json().id;

    await post(ownerToken, "/v1/inventory/movements", {
      id: randomUUID(), movementType: "receipt", variantId: plainVariantId, quantity: 20,
      to: { locationId, state: "on_hand" }, reference: { type: "grn", id: randomUUID() },
    });
    const receipt = await post(ownerToken, "/v1/inventory/receipts", {
      locationId, lines: [{ variantId: phoneVariantId, units: [{ imei1: IMEI }] }],
    });
    unitId = receipt.json().unitIds[0];
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it("rejects a typed-over unit price (server owns pricing)", async () => {
    const res = await sale(
      [{ variantId: plainVariantId, quantity: 1, unitPriceMinor: 100 }], 100,
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("PRICE_MISMATCH");
  });

  it("allows discounts inside the cashier band (5%)", async () => {
    const res = await sale(
      [{ variantId: plainVariantId, quantity: 1, unitPriceMinor: 10000, discountMinor: 400 }],
      9600,
    );
    expect(res.statusCode).toBe(201);
  });

  it("blocks over-band discounts without an approved manager approval, allows with one", async () => {
    const blocked = await sale(
      [{ variantId: plainVariantId, quantity: 1, unitPriceMinor: 10000, discountMinor: 2000 }],
      8000,
    );
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("DISCOUNT_APPROVAL_REQUIRED");

    const request = await post(cashierToken, "/v1/pos/discount-approvals", {
      reason: "loyal customer haggling", amountMinor: 2000, variantId: plainVariantId,
    });
    const approvalId = request.json().approvalId;

    // A pending approval is not enough.
    const stillBlocked = await sale(
      [{ variantId: plainVariantId, quantity: 1, unitPriceMinor: 10000,
         discountMinor: 2000, discountApprovalId: approvalId }],
      8000,
    );
    expect(stillBlocked.statusCode).toBe(403);

    const decide = await post(managerToken, `/v1/approvals/${approvalId}/decision`, { approve: true });
    expect(decide.statusCode).toBe(200);

    const allowed = await sale(
      [{ variantId: plainVariantId, quantity: 1, unitPriceMinor: 10000,
         discountMinor: 2000, discountApprovalId: approvalId }],
      8000,
    );
    expect(allowed.statusCode).toBe(201);
  });

  it("stamps warranty from the variant at serialized sale", async () => {
    const res = await sale(
      [{ variantId: phoneVariantId, quantity: 1, unitPriceMinor: 105000, stockUnitId: unitId }],
      105000,
    );
    expect(res.statusCode).toBe(201);
    const history = await app.inject({
      url: `/v1/stock-units/${unitId}/history`, headers: authed(managerToken),
    });
    const body = history.json();
    expect(body.state).toBe("sold");
    const warranty = new Date(body.warrantyUntil);
    const monthsAhead = (warranty.getTime() - Date.now()) / (30 * 86_400_000);
    expect(monthsAhead).toBeGreaterThan(11);
    expect(monthsAhead).toBeLessThan(13);
    expect(body.soldOrderNo).toMatch(/^INV-/);
  });

  it("repair round-trip: out to repair and back, every step in the unit history", async () => {
    // A fresh in-stock unit for repair.
    const receipt = await post(managerToken, "/v1/inventory/receipts", {
      locationId, lines: [{ variantId: phoneVariantId, units: [{ imei1: "352099001761481" }] }],
    });
    const repairUnit = receipt.json().unitIds[0];

    const out = await post(managerToken, `/v1/stock-units/${repairUnit}/repair-out`,
      { note: "screen replacement" });
    expect(out.statusCode).toBe(200);
    expect(out.json().state).toBe("in_repair");

    // Can't send an in-repair unit out again.
    const again = await post(managerToken, `/v1/stock-units/${repairUnit}/repair-out`, {});
    expect(again.statusCode).toBe(400);

    const back = await post(managerToken, `/v1/stock-units/${repairUnit}/repair-in`,
      { note: "screen replaced" });
    expect(back.statusCode).toBe(200);
    expect(back.json().state).toBe("in_stock");

    const history = await app.inject({
      url: `/v1/stock-units/${repairUnit}/history`, headers: authed(managerToken),
    });
    const types = history.json().movements.map((m: { movementType: string }) => m.movementType);
    expect(types).toEqual(["receipt", "repair_out", "repair_in"]);
  });
});
