/**
 * POS sale integration tests (real PostgreSQL — see pgApp.integration.test.ts
 * for environment requirements; skipped without the DB env vars).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("POS sales", () => {
  let app: ReturnType<typeof buildPgApp>;
  let token = "";
  let locationId = "";
  let deviceId = "";
  let phoneVariantId = "";
  let chargerVariantId = "";
  const suffix = randomUUID().slice(0, 8);

  const authed = () => ({ authorization: `Bearer ${token}` });
  const post = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });

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
        tenantName: "Sale Test Shop", slug: `sale-shop-${suffix}`,
        fullName: "Owner", email: `owner@sale-${suffix}.test`,
        password: "correct-horse-battery",
      },
    });
    token = reg.json().accessToken;

    locationId = (await post("/v1/locations", { kind: "store", name: "Shop", code: "S1" })).json().id;
    deviceId = (await post("/v1/devices", { kind: "pos_register", name: "Register 1", locationId })).json().id;

    const mkVariant = async (name: string, slug: string, sku: string, priceMinor: number, qty: number) => {
      const productId = (await post("/v1/products", { name, slug, tracking: "none" })).json().id;
      const variantId = (
        await post(`/v1/products/${productId}/variants`, { sku, priceMinor, currency: "AED" })
      ).json().id;
      const receipt = await post("/v1/inventory/movements", {
        id: randomUUID(), movementType: "receipt", variantId, quantity: qty,
        to: { locationId, state: "on_hand" },
        reference: { type: "grn", id: randomUUID() },
      });
      expect(receipt.statusCode).toBe(201);
      return variantId;
    };
    phoneVariantId = await mkVariant("Phone Pro", "phone-pro", "PP-1", 419900, 5);
    chargerVariantId = await mkVariant("Charger", "charger", "CH-1", 8900, 10);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  const saleBody = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    deviceId,
    locationId,
    lines: [
      { variantId: phoneVariantId, quantity: 1, unitPriceMinor: 419900 },
      { variantId: chargerVariantId, quantity: 2, unitPriceMinor: 8900 },
    ],
    payments: [{ method: "cash", amountMinor: 419900 + 17800 }],
    ...overrides,
  });

  it("completes a sale: order + payment + ledger + VAT in one transaction", async () => {
    const res = await post("/v1/pos/sales", saleBody());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.orderNo).toBe("INV-000001");
    expect(body.totals.totalMinor).toBe(437700);
    // 5% VAT extracted from inclusive prices: 4199.00→199.95, 178.00→8.48
    expect(body.totals.taxMinor).toBe(19995 + 848);

    const avail = await app.inject({
      url: `/v1/inventory/availability/${phoneVariantId}/${locationId}`,
      headers: authed(),
    });
    expect(avail.json().onHand).toBe(4);

    const receipt = await app.inject({
      url: `/v1/orders/${body.orderId}/receipt`,
      headers: authed(),
    });
    expect(receipt.statusCode).toBe(200);
    const r = receipt.json();
    expect(r.kind).toBe("tax_invoice");
    expect(r.lines).toHaveLength(2);
    expect(r.payments[0]).toMatchObject({ method: "cash", amountMinor: 437700 });
  });

  it("order numbers are sequential and gapless", async () => {
    const res = await post("/v1/pos/sales", saleBody());
    expect(res.statusCode).toBe(201);
    expect(res.json().orderNo).toBe("INV-000002");
  });

  it("payment mismatch rolls back everything including stock", async () => {
    const before = (
      await app.inject({
        url: `/v1/inventory/availability/${chargerVariantId}/${locationId}`,
        headers: authed(),
      })
    ).json().onHand;

    const res = await post("/v1/pos/sales", saleBody({
      payments: [{ method: "cash", amountMinor: 1 }],
    }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("PAYMENT_MISMATCH");

    const after = (
      await app.inject({
        url: `/v1/inventory/availability/${chargerVariantId}/${locationId}`,
        headers: authed(),
      })
    ).json().onHand;
    expect(after).toBe(before);
  });

  it("overselling rolls the whole sale back", async () => {
    const res = await post("/v1/pos/sales", saleBody({
      lines: [{ variantId: phoneVariantId, quantity: 99, unitPriceMinor: 419900 }],
      payments: [{ method: "cash", amountMinor: 99 * 419900 }],
    }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("INSUFFICIENT_STOCK");
  });

  it("replaying the same sale id is idempotent (offline replay)", async () => {
    const body = saleBody();
    const first = await post("/v1/pos/sales", body);
    expect(first.statusCode).toBe(201);
    const orderNo = first.json().orderNo;

    const replay = await post("/v1/pos/sales", body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ duplicate: true, orderNo });

    // stock was only decremented once
    const avail = await app.inject({
      url: `/v1/inventory/availability/${phoneVariantId}/${locationId}`,
      headers: authed(),
    });
    // 5 initial − sale1 − sale4(this one) = 2 remaining (sale2 also took one)
    expect(avail.json().onHand).toBe(2);
  });

  it("rejects an unknown variant", async () => {
    const res = await post("/v1/pos/sales", saleBody({
      lines: [{ variantId: randomUUID(), quantity: 1, unitPriceMinor: 100 }],
      payments: [{ method: "cash", amountMinor: 100 }],
    }));
    expect(res.statusCode).toBe(404);
  });
});
