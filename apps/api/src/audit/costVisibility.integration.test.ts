/**
 * Cost and margin visibility by role (real PostgreSQL).
 *
 * The threat model treats a cashier as a semi-trusted insider: they may look up
 * a unit by IMEI to answer a warranty question, but must never learn what the
 * shop paid for it. Four routes returned cost with no role check at all — these
 * tests pin each one, and pin the redaction/refusal split so a future route is
 * forced to choose deliberately.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

const IMEI = "356938035643809";
const UNIT_COST_MINOR = 388000;

describe.skipIf(!run)("cost visibility is gated by role", () => {
  let app: ReturnType<typeof buildPgApp>;
  let ownerToken = "";
  let cashierToken = "";
  let locationId = "";
  let unitId = "";
  let poId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `cost-shop-${suffix}`;

  const authed = (t: string) => ({ authorization: `Bearer ${t}` });
  const get = (t: string, url: string) =>
    app.inject({ method: "GET", url, headers: authed(t) });
  const post = (t: string, url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(t), payload: payload as never });

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
        tenantName: "Cost Shop",
        slug,
        fullName: "Owner",
        email: `owner@${slug}.test`,
        password: "correct-horse-battery",
      },
    });
    ownerToken = reg.json().accessToken;

    await post(ownerToken, "/v1/users", {
      email: `pos@${slug}.test`,
      password: "employee-pass-123",
      fullName: "Cashier",
      role: "cashier",
    });
    cashierToken = (
      await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { slug, email: `pos@${slug}.test`, password: "employee-pass-123" },
      })
    ).json().accessToken;

    locationId = (
      await post(ownerToken, "/v1/locations", { kind: "warehouse", name: "Naif", code: "NAIF" })
    ).json().id;

    const supplierId = (
      await post(ownerToken, "/v1/suppliers", { name: "Gulf Mobile Distribution" })
    ).json().supplierId;

    const productId = (
      await post(ownerToken, "/v1/products", {
        name: "iPhone 15 Pro",
        slug: `iphone-15-pro-${suffix}`,
        tracking: "serialized",
      })
    ).json().id;
    const variantId = (
      await post(ownerToken, `/v1/products/${productId}/variants`, {
        sku: `IP15P-${suffix}`,
        priceMinor: 429900,
        currency: "AED",
        costMinor: UNIT_COST_MINOR,
      })
    ).json().id;

    poId = (
      await post(ownerToken, "/v1/purchase-orders", {
        supplierId,
        locationId,
        lines: [{ variantId, orderedQty: 1, unitCostMinor: UNIT_COST_MINOR }],
      })
    ).json().poId;

    await post(ownerToken, `/v1/purchase-orders/${poId}/receive`, {
      lines: [{ variantId, units: [{ imei1: IMEI }] }],
    });

    unitId = (await get(ownerToken, `/v1/stock-units?imei=${IMEI}`)).json().id;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  describe("unit history — redacted, because warranty lookup must still work", () => {
    it("lets a cashier read the unit but withholds its cost", async () => {
      const res = await get(cashierToken, `/v1/stock-units/${unitId}/history`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // The lookup itself must succeed — this is the warranty path (R2.6).
      expect(body.imei1).toBe(IMEI);
      expect(body.movements).toBeDefined();
      // ...but the cost must not be there in any form.
      expect(body.unitCostMinor).toBeUndefined();
      expect(Object.keys(body)).not.toContain("unitCostMinor");
      expect(JSON.stringify(body)).not.toContain(String(UNIT_COST_MINOR));
    });

    it("shows cost to an owner", async () => {
      const body = (await get(ownerToken, `/v1/stock-units/${unitId}/history`)).json();
      // Money is BIGINT, which pg serialises as a string rather than risking
      // precision loss through a JS number.
      expect(Number(body.unitCostMinor)).toBe(UNIT_COST_MINOR);
    });
  });

  describe("purchase order detail — refused, it is cost end to end", () => {
    it("refuses a cashier", async () => {
      const res = await get(cashierToken, `/v1/purchase-orders/${poId}`);
      expect(res.statusCode).toBe(403);
    });

    it("allows an owner", async () => {
      expect((await get(ownerToken, `/v1/purchase-orders/${poId}`)).statusCode).toBe(200);
    });
  });

  describe("dead stock — refused, it is a capital-at-risk report", () => {
    it("refuses a cashier", async () => {
      const res = await get(cashierToken, "/v1/ai/dead-stock");
      expect(res.statusCode).toBe(403);
    });

    it("allows an owner", async () => {
      expect((await get(ownerToken, "/v1/ai/dead-stock")).statusCode).toBe(200);
    });
  });

  describe("dashboard summary — redacted, staff may see the rest", () => {
    it("withholds stock value at cost from a cashier", async () => {
      const res = await get(cashierToken, "/v1/analytics/summary");
      expect(res.statusCode).toBe(200);
      expect(res.json().stockValueMinor).toBeUndefined();
    });

    it("shows stock value to an owner", async () => {
      const body = (await get(ownerToken, "/v1/analytics/summary")).json();
      expect(body.stockValueMinor).toBeDefined();
    });
  });
});
