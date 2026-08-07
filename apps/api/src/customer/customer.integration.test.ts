/**
 * Storefront customer accounts — magic-link auth + session-scoped self-view of
 * orders and serialized devices (real PostgreSQL — skipped without the DB env
 * vars, same discipline as pgApp.integration.test.ts).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

// Valid-Luhn IMEI (GSMA test example).
const IMEI_A = "490154203237518";

describe.skipIf(!run)("customer accounts (magic link)", () => {
  let app: ReturnType<typeof buildPgApp>;
  let ownerToken = "";
  let cashierToken = "";
  let locationId = "";
  let deviceId = "";
  let phoneVariantId = "";
  let unitA = "";
  const suffix = randomUUID().slice(0, 8);
  const slugA = `cust-shop-a-${suffix}`;
  const slugB = `cust-shop-b-${suffix}`;
  const shopperEmail = `shopper-${suffix}@example.test`;
  const otherEmail = `other-${suffix}@example.test`;

  const authed = (token: string) => ({ authorization: `Bearer ${token}` });
  const shopperAuth = (token: string) => ({ authorization: `CustomerSession ${token}` });
  const post = (token: string, url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: authed(token), payload: payload as never });

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });

    // Two tenants so we can prove sessions are tenant-scoped.
    const regA = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        tenantName: "Cust Shop A", slug: slugA, fullName: "Owner",
        email: `owner@${slugA}.test`, password: "correct-horse-battery",
      },
    });
    ownerToken = regA.json().accessToken;

    await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        tenantName: "Cust Shop B", slug: slugB, fullName: "Owner",
        email: `owner@${slugB}.test`, password: "correct-horse-battery",
      },
    });

    // A cashier who can ring up the serialized sale.
    await post(ownerToken, "/v1/users", {
      email: `cashier@${slugA}.test`, password: "employee-pass-123",
      fullName: "Cashier", role: "cashier",
    });
    const cashierLogin = await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { slug: slugA, email: `cashier@${slugA}.test`, password: "employee-pass-123" },
    });
    cashierToken = cashierLogin.json().accessToken;

    locationId = (
      await post(ownerToken, "/v1/locations", { kind: "store", name: "Shop", code: "S1" })
    ).json().id;
    deviceId = (
      await post(ownerToken, "/v1/devices", { kind: "pos_register", name: "R1", locationId })
    ).json().id;
    const productId = (
      await post(ownerToken, "/v1/products", {
        name: "Phone Y", slug: "phone-y", tracking: "serialized",
      })
    ).json().id;
    phoneVariantId = (
      await post(ownerToken, `/v1/products/${productId}/variants`, {
        sku: "PY-1", priceMinor: 210000, currency: "AED", warrantyMonths: 12,
      })
    ).json().id;

    // Receive one IMEI unit so it can be sold to the shopper.
    const recv = await post(ownerToken, "/v1/inventory/receipts", {
      locationId,
      lines: [{ variantId: phoneVariantId, units: [{ imei1: IMEI_A }] }],
    });
    unitA = recv.json().unitIds[0];
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it("request-link returns devToken in dev mode", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/public/${slugA}/customer/request-link`,
      payload: { email: shopperEmail },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().devToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it("verify-link mints a session and creates the customer on first sign-in", async () => {
    const link = await app.inject({
      method: "POST",
      url: `/v1/public/${slugA}/customer/request-link`,
      payload: { email: shopperEmail },
    });
    const { devToken } = link.json();

    const verify = await app.inject({
      method: "POST",
      url: `/v1/public/${slugA}/customer/verify-link`,
      payload: { email: shopperEmail, token: devToken },
    });
    expect(verify.statusCode).toBe(200);
    const body = verify.json();
    expect(body.sessionToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body.customer.email).toBe(shopperEmail);
    expect(typeof body.customer.id).toBe("string");

    // The session is immediately usable against the shopper-scoped area.
    const orders = await app.inject({
      url: `/v1/public/${slugA}/customer/orders`,
      headers: shopperAuth(body.sessionToken),
    });
    expect(orders.statusCode).toBe(200);
    expect(orders.json().items).toEqual([]);
  });

  it("wrong token is rejected", async () => {
    const link = await app.inject({
      method: "POST",
      url: `/v1/public/${slugA}/customer/request-link`,
      payload: { email: shopperEmail },
    });
    const { devToken } = link.json();
    // Flip a character so the sha256 differs.
    const bad = devToken.slice(0, -1) + (devToken.endsWith("A") ? "B" : "A");
    const verify = await app.inject({
      method: "POST",
      url: `/v1/public/${slugA}/customer/verify-link`,
      payload: { email: shopperEmail, token: bad },
    });
    expect(verify.statusCode).toBe(401);
    expect(verify.json().error).toBe("INVALID_LINK");
  });

  it("consumed magic link cannot be replayed", async () => {
    const link = await app.inject({
      method: "POST",
      url: `/v1/public/${slugA}/customer/request-link`,
      payload: { email: shopperEmail },
    });
    const { devToken } = link.json();

    const first = await app.inject({
      method: "POST",
      url: `/v1/public/${slugA}/customer/verify-link`,
      payload: { email: shopperEmail, token: devToken },
    });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: `/v1/public/${slugA}/customer/verify-link`,
      payload: { email: shopperEmail, token: devToken },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe("LINK_CONSUMED");
  });

  it("expired magic link is rejected", async () => {
    // Insert a magic link directly with a past expiry (through the app so RLS
    // is respected). We do this by making a request and then aging the row.
    const link = await app.inject({
      method: "POST",
      url: `/v1/public/${slugA}/customer/request-link`,
      payload: { email: otherEmail },
    });
    const { devToken } = link.json();
    // Age it out in-DB. We use an admin connection because RLS is bound to a
    // tenant; the raw admin URL bypasses it (schema owner role).
    const admin = new pg.Client({ connectionString: ADMIN_URL! });
    await admin.connect();
    try {
      await admin.query(
        `UPDATE customer_magic_link
            SET expires_at = now() - interval '1 minute'
          WHERE email = $1 AND consumed_at IS NULL`,
        [otherEmail],
      );
    } finally {
      await admin.end();
    }

    const verify = await app.inject({
      method: "POST",
      url: `/v1/public/${slugA}/customer/verify-link`,
      payload: { email: otherEmail, token: devToken },
    });
    expect(verify.statusCode).toBe(401);
    expect(verify.json().error).toBe("LINK_EXPIRED");
  });

  it("shopper-scoped /orders returns only the caller's orders", async () => {
    // Fresh session for the primary shopper.
    const link = await app.inject({
      method: "POST",
      url: `/v1/public/${slugA}/customer/request-link`,
      payload: { email: shopperEmail },
    });
    const verify = await app.inject({
      method: "POST",
      url: `/v1/public/${slugA}/customer/verify-link`,
      payload: { email: shopperEmail, token: link.json().devToken },
    });
    const sessionToken: string = verify.json().sessionToken;
    const shopperId: string = verify.json().customer.id;

    // Ring up a POS sale attributed to this customer, moving the IMEI unit.
    const saleId = randomUUID();
    const sale = await post(cashierToken, "/v1/pos/sales", {
      id: saleId, deviceId, locationId, customerId: shopperId,
      lines: [{
        variantId: phoneVariantId, quantity: 1, unitPriceMinor: 210000, stockUnitId: unitA,
      }],
      payments: [{ method: "cash", amountMinor: 210000 }],
    });
    expect(sale.statusCode).toBe(201);

    const orders = await app.inject({
      url: `/v1/public/${slugA}/customer/orders`,
      headers: shopperAuth(sessionToken),
    });
    expect(orders.statusCode).toBe(200);
    const items = orders.json().items as Array<{ id: string; orderNo: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.orderNo).toBe(sale.json().orderNo);
  });

  it("shopper-scoped /units returns only the caller's serialized purchases", async () => {
    const link = await app.inject({
      method: "POST",
      url: `/v1/public/${slugA}/customer/request-link`,
      payload: { email: shopperEmail },
    });
    const verify = await app.inject({
      method: "POST",
      url: `/v1/public/${slugA}/customer/verify-link`,
      payload: { email: shopperEmail, token: link.json().devToken },
    });
    const sessionToken: string = verify.json().sessionToken;

    const units = await app.inject({
      url: `/v1/public/${slugA}/customer/units`,
      headers: shopperAuth(sessionToken),
    });
    expect(units.statusCode).toBe(200);
    const items = units.json().items as Array<{
      imei1: string; sku: string; productName: string; warrantyUntil: string | null;
    }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ imei1: IMEI_A, sku: "PY-1", productName: "Phone Y" });
    // warrantyUntil should have been stamped on sale (warrantyMonths = 12).
    expect(items[0]!.warrantyUntil).toBeTruthy();
  });

  it("unauthenticated request to a shopper endpoint is 401", async () => {
    const res = await app.inject({
      url: `/v1/public/${slugA}/customer/orders`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("UNAUTHENTICATED");
  });

  it("Bearer employee token is rejected on shopper endpoints", async () => {
    // Employees use `Bearer`; shoppers use `CustomerSession`. Presenting the
    // wrong scheme must never resolve to a customer.
    const res = await app.inject({
      url: `/v1/public/${slugA}/customer/orders`,
      headers: authed(ownerToken),
    });
    expect(res.statusCode).toBe(401);
  });

  it("shopper session from tenant A cannot read tenant B", async () => {
    const link = await app.inject({
      method: "POST",
      url: `/v1/public/${slugA}/customer/request-link`,
      payload: { email: shopperEmail },
    });
    const verify = await app.inject({
      method: "POST",
      url: `/v1/public/${slugA}/customer/verify-link`,
      payload: { email: shopperEmail, token: link.json().devToken },
    });
    const sessionToken: string = verify.json().sessionToken;

    const crossTenant = await app.inject({
      url: `/v1/public/${slugB}/customer/orders`,
      headers: shopperAuth(sessionToken),
    });
    expect(crossTenant.statusCode).toBe(401);
  });
});
