/**
 * Transferring a serialized unit between branches (real PostgreSQL).
 *
 * Transfers moved quantity only and never touched `stock_unit.location_id`.
 * After transferring a phone the ledger said the stock was at the destination
 * while the unit row still said the origin, so the sale guard
 * (`u.location_id !== input.locationId`) refused it at the destination and the
 * origin had no on-hand stock to sell. The unit became unsellable at both ends
 * and no error was raised until a cashier tried to ring it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

const IMEI = "352099001761481";

describe.skipIf(!run)("serialized stock transfers", () => {
  let app: ReturnType<typeof buildPgApp>;
  let ownerToken = "";
  let fromLocationId = "";
  let toLocationId = "";
  let deviceAtDestination = "";
  let phoneVariantId = "";
  let cableVariantId = "";
  let unitId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `xfer-shop-${suffix}`;

  const authed = () => ({ authorization: `Bearer ${ownerToken}` });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });
  const get = (url: string) => app.inject({ method: "GET", url, headers: authed() });

  const unitState = async () => (await get(`/v1/stock-units?imei=${IMEI}`)).json();

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    ownerToken = (
      await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        payload: {
          tenantName: "Transfer Shop",
          slug,
          fullName: "Owner",
          email: `owner@${slug}.test`,
          password: "correct-horse-battery",
        },
      })
    ).json().accessToken;

    fromLocationId = (await post("/v1/locations", { kind: "store", name: "Deira", code: "DEI" })).json().id;
    toLocationId = (await post("/v1/locations", { kind: "store", name: "Sharjah", code: "SHJ" })).json().id;
    deviceAtDestination = (
      await post("/v1/devices", { kind: "pos_register", name: "SHJ Till", locationId: toLocationId })
    ).json().id;
    // A register must have an open till before it can take cash (R3.10):
    // cash outside a session escapes the blind-close reconciliation.
    await post("/v1/cash-sessions", { deviceId: deviceAtDestination, openingFloatMinor: 0 });

    const phoneProduct = (
      await post("/v1/products", { name: "Phone T", slug: `phone-t-${suffix}`, tracking: "serialized" })
    ).json().id;
    phoneVariantId = (
      await post(`/v1/products/${phoneProduct}/variants`, {
        sku: `PT-${suffix}`, priceMinor: 210000, currency: "AED",
      })
    ).json().id;

    const cableProduct = (
      await post("/v1/products", { name: "Cable T", slug: `cable-t-${suffix}`, tracking: "none" })
    ).json().id;
    cableVariantId = (
      await post(`/v1/products/${cableProduct}/variants`, {
        sku: `CT-${suffix}`, priceMinor: 5000, currency: "AED",
      })
    ).json().id;

    unitId = (
      await post("/v1/inventory/receipts", {
        locationId: fromLocationId,
        lines: [{ variantId: phoneVariantId, units: [{ imei1: IMEI }] }],
      })
    ).json().unitIds[0];
    await post("/v1/inventory/receipts", {
      locationId: fromLocationId,
      lines: [{ variantId: cableVariantId, quantity: 10 }],
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it("refuses a serialized transfer that does not name its units", async () => {
    const res = await post("/v1/transfers", {
      fromLocationId,
      toLocationId,
      lines: [{ variantId: phoneVariantId, quantity: 1 }],
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.payload).toContain("SERIALIZED_RULE");
  });

  it("refuses a unit that is not at the origin", async () => {
    const res = await post("/v1/transfers", {
      fromLocationId: toLocationId, // wrong way round — the unit is at Deira
      toLocationId: fromLocationId,
      lines: [{ variantId: phoneVariantId, quantity: 1, stockUnitIds: [unitId] }],
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.payload).toContain("another location");
  });

  it("moves the unit with the ledger and makes it sellable at the destination", async () => {
    const dispatched = await post("/v1/transfers", {
      fromLocationId,
      toLocationId,
      lines: [
        { variantId: phoneVariantId, quantity: 1, stockUnitIds: [unitId] },
        { variantId: cableVariantId, quantity: 3 }, // non-serialized leg still works
      ],
    });
    expect(dispatched.statusCode).toBe(201);
    const { transferId } = dispatched.json();

    // In transit: the unit follows the ledger to the destination and is
    // sellable at neither end.
    const inTransit = await unitState();
    expect(inTransit.state).toBe("in_transit");
    expect(inTransit.locationId).toBe(toLocationId);

    const tooEarly = await post("/v1/pos/sales", {
      id: randomUUID(),
      deviceId: deviceAtDestination,
      locationId: toLocationId,
      lines: [{ variantId: phoneVariantId, quantity: 1, unitPriceMinor: 210000, stockUnitId: unitId }],
      payments: [{ method: "cash", amountMinor: 210000 }],
    });
    expect(tooEarly.statusCode).toBe(409);

    const received = await post(`/v1/transfers/${transferId}/receive`);
    expect(received.statusCode).toBe(200);

    const landed = await unitState();
    expect(landed.state).toBe("in_stock");
    expect(landed.locationId).toBe(toLocationId);

    // The regression: this sale used to fail with UNIT_UNAVAILABLE forever,
    // because the unit row still named the origin.
    const sale = await post("/v1/pos/sales", {
      id: randomUUID(),
      deviceId: deviceAtDestination,
      locationId: toLocationId,
      lines: [{ variantId: phoneVariantId, quantity: 1, unitPriceMinor: 210000, stockUnitId: unitId }],
      payments: [{ method: "cash", amountMinor: 210000 }],
    });
    expect(sale.statusCode).toBe(201);

    // Non-serialized quantities still reconcile.
    const cableAtDest = await get(`/v1/inventory/availability/${cableVariantId}/${toLocationId}`);
    expect(cableAtDest.json().onHand).toBe(3);
  });
});
