/**
 * Purchasing v1 on real PostgreSQL: suppliers, gapless PO numbering, and
 * receiving against a PO (plain quantities and serialized IMEI units) through
 * the existing ReceivingService/ledger. Skipped without DB env vars.
 *
 * Provisioning happens over HTTP against buildPgApp (like ops.integration.test);
 * the PurchasingService itself is exercised directly with a Db on DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";
import { Db } from "../db.js";
import { PgInventoryService } from "../inventory/pgInventory.js";
import { ReceivingService } from "../inventory/receivingService.js";
import { PurchasingService } from "./purchasingService.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

// Luhn-valid test IMEIs (unique per tenant; each run registers a fresh tenant).
const IMEI_A = "490154203237518";
const IMEI_B = "352099001761481";

describe.skipIf(!run)("purchasing", () => {
  let app: ReturnType<typeof buildPgApp>;
  let db: Db;
  let purchasing: PurchasingService;
  let ownerToken = "";
  let tenantId = "";
  let userId = "";
  let warehouseId = "";
  let phoneVariantId = "";  // tracking: serialized
  let cableVariantId = "";  // tracking: none
  let supplierId = "";
  let poId = "";            // PO-000001: 2 phones + 10 cables
  const suffix = randomUUID().slice(0, 8);
  const slug = `po-shop-${suffix}`;

  const authed = () => ({ authorization: `Bearer ${ownerToken}` });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });

  const onHand = async (variantId: string) =>
    (await app.inject({
      url: `/v1/inventory/availability/${variantId}/${warehouseId}`,
      headers: authed(),
    })).json().onHand as number;

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    const reg = await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: { tenantName: "PO Shop", slug, fullName: "Owner",
                 email: `owner@${slug}.test`, password: "correct-horse-battery" },
    });
    ownerToken = reg.json().accessToken;

    warehouseId = (await post("/v1/locations", { kind: "warehouse", name: "WH", code: "WH" })).json().id;
    const phoneProductId = (await post("/v1/products", {
      name: "Phone X", slug: "phone-x", tracking: "serialized",
    })).json().id;
    phoneVariantId = (await post(`/v1/products/${phoneProductId}/variants`, {
      sku: "PHX-256", priceMinor: 329900, currency: "AED",
    })).json().id;
    const cableProductId = (await post("/v1/products", {
      name: "Cable", slug: "cable", tracking: "none",
    })).json().id;
    cableVariantId = (await post(`/v1/products/${cableProductId}/variants`, {
      sku: "CB-1", priceMinor: 2100, currency: "AED",
    })).json().id;

    db = new Db(APP_URL!);
    purchasing = new PurchasingService(db, new ReceivingService(db, new PgInventoryService(db)));
    tenantId = await db.withPlatform(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM tenant WHERE slug = $1", [slug],
      );
      return rows[0]!.id;
    });
    userId = await db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM app_user WHERE email = $1", [`owner@${slug}.test`],
      );
      return rows[0]!.id;
    });
  }, 30_000);

  afterAll(async () => {
    await db?.close();
    await app?.close();
  });

  it("creates and lists suppliers", async () => {
    supplierId = (await purchasing.createSupplier(tenantId, {
      name: "Dubai Devices FZE",
      contact: { email: "sales@dxbdevices.test" },
      paymentTerms: "NET30",
    })).supplierId;
    const suppliers = await purchasing.listSuppliers(tenantId);
    expect(suppliers).toHaveLength(1);
    expect(suppliers[0]).toMatchObject({
      id: supplierId, name: "Dubai Devices FZE", paymentTerms: "NET30", isActive: true,
    });
  });

  it("assigns gapless per-tenant PO numbers", async () => {
    const po1 = await purchasing.createPurchaseOrder(tenantId, userId, {
      supplierId, locationId: warehouseId,
      lines: [
        { variantId: phoneVariantId, orderedQty: 2, unitCostMinor: 250000 },
        { variantId: cableVariantId, orderedQty: 10, unitCostMinor: 1500 },
      ],
    });
    expect(po1.poNo).toBe("PO-000001");
    poId = po1.poId;

    const po2 = await purchasing.createPurchaseOrder(tenantId, userId, {
      supplierId, locationId: warehouseId, note: "restock",
      lines: [{ variantId: cableVariantId, orderedQty: 5, unitCostMinor: 1400 }],
    });
    expect(po2.poNo).toBe("PO-000002");

    const view = await purchasing.getPurchaseOrder(tenantId, poId);
    expect(view.status).toBe("placed");
    expect(view.placedAt).toBeTruthy();
    expect(view.currency).toBe("AED");
    expect(view.lines).toHaveLength(2);
  });

  it("rejects a PO with an unknown variant or supplier, and an empty PO", async () => {
    await expect(
      purchasing.createPurchaseOrder(tenantId, userId, {
        supplierId, locationId: warehouseId,
        lines: [{ variantId: randomUUID(), orderedQty: 1, unitCostMinor: 100 }],
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_VARIANT" });
    await expect(
      purchasing.createPurchaseOrder(tenantId, userId, {
        supplierId: randomUUID(), locationId: warehouseId,
        lines: [{ variantId: cableVariantId, orderedQty: 1, unitCostMinor: 100 }],
      }),
    ).rejects.toMatchObject({ code: "SUPPLIER_NOT_FOUND" });
    await expect(
      purchasing.createPurchaseOrder(tenantId, userId, {
        supplierId, locationId: warehouseId, lines: [],
      }),
    ).rejects.toMatchObject({ code: "EMPTY_PO" });
  });

  it("rejects receiving a variant that is not on the PO", async () => {
    await expect(
      purchasing.receiveAgainstPo(tenantId, userId, poId, {
        lines: [{ variantId: randomUUID(), quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_VARIANT" });
    await expect(
      purchasing.receiveAgainstPo(tenantId, userId, randomUUID(), {
        lines: [{ variantId: cableVariantId, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: "PO_NOT_FOUND" });
  });

  it("receives a plain quantity: stock rises, line progresses, PO is partially_received", async () => {
    expect(await onHand(cableVariantId)).toBe(0);
    const result = await purchasing.receiveAgainstPo(tenantId, userId, poId, {
      lines: [{ variantId: cableVariantId, quantity: 6 }],
    });
    expect(result.grnId).toBeTruthy();
    expect(result.status).toBe("partially_received");
    expect(await onHand(cableVariantId)).toBe(6);

    const view = await purchasing.getPurchaseOrder(tenantId, poId);
    expect(view.status).toBe("partially_received");
    const cableLine = view.lines.find((l) => l.variantId === cableVariantId);
    expect(cableLine).toMatchObject({ orderedQty: 10, receivedQty: 6 });
  });

  it("rejects over-receipt beyond the ordered quantity", async () => {
    await expect(
      purchasing.receiveAgainstPo(tenantId, userId, poId, {
        lines: [{ variantId: cableVariantId, quantity: 5 }], // 6 + 5 > 10
      }),
    ).rejects.toMatchObject({ code: "OVER_RECEIPT" });
    expect(await onHand(cableVariantId)).toBe(6); // nothing moved

    await expect(
      purchasing.receiveAgainstPo(tenantId, userId, poId, {
        lines: [{ variantId: phoneVariantId, units: [
          { imei1: IMEI_A }, { imei1: IMEI_B }, { imei1: "990000862471854" },
        ] }],
      }),
    ).rejects.toMatchObject({ code: "OVER_RECEIPT" }); // 3 units > 2 ordered
  });

  it("receives serialized units by IMEI: stock_units carry the PO id and unit costs", async () => {
    const result = await purchasing.receiveAgainstPo(tenantId, userId, poId, {
      lines: [{ variantId: phoneVariantId, units: [
        { imei1: IMEI_A, unitCostMinor: 240000 }, // explicit landed cost
        { imei1: IMEI_B },                        // defaults to the PO line cost
      ] }],
    });
    expect(result.unitIds).toHaveLength(2);
    expect(result.status).toBe("partially_received"); // cables still short
    expect(await onHand(phoneVariantId)).toBe(2);

    const units = await db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{
        imei1: string; purchase_order_id: string; unit_cost_minor: string; state: string;
      }>(
        `SELECT imei1, purchase_order_id, unit_cost_minor, state
           FROM stock_unit WHERE id = ANY($1::uuid[]) ORDER BY imei1`,
        [result.unitIds],
      );
      return rows;
    });
    expect(units).toEqual([
      expect.objectContaining({ imei1: IMEI_B, purchase_order_id: poId,
                                unit_cost_minor: "250000", state: "in_stock" }),
      expect.objectContaining({ imei1: IMEI_A, purchase_order_id: poId,
                                unit_cost_minor: "240000", state: "in_stock" }),
    ]);

    const view = await purchasing.getPurchaseOrder(tenantId, poId);
    expect(view.lines.find((l) => l.variantId === phoneVariantId))
      .toMatchObject({ orderedQty: 2, receivedQty: 2 });
  });

  it("flips to received when every line is complete, then refuses further receipts", async () => {
    const result = await purchasing.receiveAgainstPo(tenantId, userId, poId, {
      lines: [{ variantId: cableVariantId, quantity: 4 }],
    });
    expect(result.status).toBe("received");
    expect(await onHand(cableVariantId)).toBe(10);

    const view = await purchasing.getPurchaseOrder(tenantId, poId);
    expect(view.status).toBe("received");
    expect(view.lines.every((l) => l.receivedQty === l.orderedQty)).toBe(true);

    await expect(
      purchasing.receiveAgainstPo(tenantId, userId, poId, {
        lines: [{ variantId: cableVariantId, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: "BAD_STATE" });
  });

  it("updates variant.cost_minor to the PO line cost (last-cost policy)", async () => {
    const costs = await db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ id: string; cost_minor: string }>(
        "SELECT id, cost_minor FROM variant WHERE id = ANY($1::uuid[])",
        [[phoneVariantId, cableVariantId]],
      );
      return new Map(rows.map((r) => [r.id, r.cost_minor]));
    });
    expect(costs.get(phoneVariantId)).toBe("250000");
    expect(costs.get(cableVariantId)).toBe("1500");
  });

  it("receipts against the PO are in the ledger, referenced by the PO number", async () => {
    const feed = await app.inject({
      url: "/v1/inventory/movements?limit=500", headers: authed(),
    });
    const receipts = feed.json().items.filter(
      (m: { movementType: string; note?: string }) =>
        m.movementType === "receipt" && m.note === "PO-000001",
    );
    // 2 serialized quantity-1 movements + 2 bulk cable movements (6 and 4)
    expect(receipts).toHaveLength(4);
    const total = receipts.reduce((s: number, m: { quantity: number }) => s + Number(m.quantity), 0);
    expect(total).toBe(12); // 2 phones + 10 cables
  });
});
