/**
 * v1 WMS on real PostgreSQL: bin directory (zones/bins/assignments), guided
 * pick lists for reserved web orders, short-pick enforcement, and hand-off to
 * the existing fulfillment flow. Skipped without DB env vars.
 *
 * Provisioning happens over HTTP against buildPgApp (like ops.integration.test);
 * the WmsService itself is exercised directly with a Db on DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";
import { Db } from "../db.js";
import { WmsService } from "./wmsService.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("wms", () => {
  let app: ReturnType<typeof buildPgApp>;
  let db: Db;
  let wms: WmsService;
  let ownerToken = "";
  let tenantId = "";
  let userId = "";
  let warehouseId = "";
  let variantA = ""; // assigned to two bins — first in walking order wins
  let variantB = ""; // assigned to the first bin of the first zone
  let variantC = ""; // never assigned — bin_path stays NULL
  let coldBin01 = "";
  let coldBin02 = "";
  let dryBin07 = "";
  let orderId = "";
  let pickListId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `wms-shop-${suffix}`;

  const authed = () => ({ authorization: `Bearer ${ownerToken}` });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });

  const placeWebOrder = async (lines: { variantId: string; quantity: number }[]) => {
    const res = await app.inject({
      method: "POST", url: `/v1/public/${slug}/orders`,
      payload: { customer: { name: "Picker Test", email: `buyer@${slug}.test` }, lines },
    });
    expect(res.statusCode).toBe(201);
    return res.json().orderId as string;
  };

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    const reg = await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: { tenantName: "WMS Shop", slug, fullName: "Owner",
                 email: `owner@${slug}.test`, password: "correct-horse-battery" },
    });
    ownerToken = reg.json().accessToken;

    warehouseId = (await post("/v1/locations", { kind: "warehouse", name: "WH", code: "WH" })).json().id;
    const productId = (await post("/v1/products", { name: "Widget", slug: "widget", tracking: "none" })).json().id;
    const mkVariant = async (sku: string) =>
      (await post(`/v1/products/${productId}/variants`, { sku, priceMinor: 1000, currency: "AED" })).json().id;
    variantA = await mkVariant("WMS-A");
    variantB = await mkVariant("WMS-B");
    variantC = await mkVariant("WMS-C");
    for (const variantId of [variantA, variantB, variantC]) {
      await post("/v1/inventory/movements", {
        id: randomUUID(), movementType: "receipt", variantId, quantity: 20,
        to: { locationId: warehouseId, state: "on_hand" },
        reference: { type: "grn", id: randomUUID() },
      });
    }

    db = new Db(APP_URL!);
    wms = new WmsService(db);
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

  it("builds the layout: zones/bins in walking order, assignment is idempotent", async () => {
    const cold = await wms.createZone(tenantId, {
      locationId: warehouseId, code: "COLD", name: "Cold room", position: 1,
    });
    const dry = await wms.createZone(tenantId, {
      locationId: warehouseId, code: "DRY", name: "Dry storage", position: 2,
    });
    coldBin01 = (await wms.createBin(tenantId, { zoneId: cold.zoneId, code: "01", position: 1 })).binId;
    coldBin02 = (await wms.createBin(tenantId, { zoneId: cold.zoneId, code: "02", position: 2 })).binId;
    dryBin07 = (await wms.createBin(tenantId, { zoneId: dry.zoneId, code: "07", position: 1 })).binId;

    expect(await wms.assignBin(tenantId, { binId: coldBin01, variantId: variantB })).toEqual({ assigned: true });
    // A lives in two bins; COLD/02 comes first in walking order (zone position 1 < 2).
    await wms.assignBin(tenantId, { binId: dryBin07, variantId: variantA });
    await wms.assignBin(tenantId, { binId: coldBin02, variantId: variantA });
    // Idempotent upsert: repeating an assignment is a no-op, not an error.
    expect(await wms.assignBin(tenantId, { binId: coldBin02, variantId: variantA })).toEqual({ assigned: false });

    const layout = await wms.locationLayout(tenantId, warehouseId);
    expect(layout.map((z) => z.code)).toEqual(["COLD", "DRY"]);
    expect(layout[0]!.bins.map((b) => b.code)).toEqual(["01", "02"]);
    expect(layout[0]!.bins[0]!.skus).toEqual(["WMS-B"]);
    expect(layout[0]!.bins[1]!.skus).toEqual(["WMS-A"]);
    expect(layout[1]!.bins).toEqual([
      expect.objectContaining({ code: "07", skus: ["WMS-A"] }),
    ]);
  });

  it("rejects bins in unknown zones and assignments to unknown bins", async () => {
    await expect(
      wms.createBin(tenantId, { zoneId: randomUUID(), code: "XX" }),
    ).rejects.toMatchObject({ name: "WmsError", code: "ZONE_NOT_FOUND" });
    await expect(
      wms.assignBin(tenantId, { binId: randomUUID(), variantId: variantA }),
    ).rejects.toMatchObject({ name: "WmsError", code: "BIN_NOT_FOUND" });
  });

  it("createPickList walks bins in order and leaves unassigned variants NULL last", async () => {
    orderId = await placeWebOrder([
      { variantId: variantA, quantity: 2 },
      { variantId: variantB, quantity: 1 },
      { variantId: variantC, quantity: 3 },
    ]);
    const pick = await wms.createPickList(tenantId, userId, orderId);
    pickListId = pick.pickListId;
    expect(pick.orderId).toBe(orderId);
    expect(pick.locationId).toBe(warehouseId);
    // Walking order: COLD/01 → COLD/02 → unassigned strays at the end.
    expect(pick.lines).toEqual([
      expect.objectContaining({ sku: "WMS-B", quantity: 1, binPath: "COLD/01", pickedQty: null }),
      expect.objectContaining({ sku: "WMS-A", quantity: 2, binPath: "COLD/02", pickedQty: null }),
      expect.objectContaining({ sku: "WMS-C", quantity: 3, binPath: null, pickedQty: null }),
    ]);
  });

  it("one pick list per order: a second create is rejected", async () => {
    await expect(
      wms.createPickList(tenantId, userId, orderId),
    ).rejects.toMatchObject({ name: "WmsError", code: "ALREADY_EXISTS" });
  });

  it("rejects unknown orders, cancelled orders, and orders without active reservations", async () => {
    await expect(
      wms.createPickList(tenantId, userId, randomUUID()),
    ).rejects.toMatchObject({ name: "WmsError", code: "ORDER_NOT_FOUND" });

    const cancelled = await placeWebOrder([{ variantId: variantC, quantity: 1 }]);
    expect((await post(`/v1/orders/${cancelled}/cancel`, { reason: "test" })).statusCode).toBe(200);
    await expect(
      wms.createPickList(tenantId, userId, cancelled),
    ).rejects.toMatchObject({ name: "WmsError", code: "BAD_STATE" });

    // Still pending, but its reservations have lapsed: no pick list either.
    const lapsed = await placeWebOrder([{ variantId: variantC, quantity: 1 }]);
    await db.withTenant(tenantId, (c) =>
      c.query(
        `UPDATE stock_reservation SET status = 'expired'
          WHERE reference_type = 'order' AND reference_id = $1`,
        [lapsed],
      ),
    );
    await expect(
      wms.createPickList(tenantId, userId, lapsed),
    ).rejects.toMatchObject({ name: "WmsError", code: "BAD_STATE" });
  });

  it("completePickList refuses short picks, naming the short variants", async () => {
    await expect(
      wms.recordPicks(tenantId, userId, randomUUID(), []),
    ).rejects.toMatchObject({ name: "WmsError", code: "PICK_NOT_FOUND" });

    const rec = await wms.recordPicks(tenantId, userId, pickListId, [
      { variantId: variantB, pickedQty: 1 },
      { variantId: variantA, pickedQty: 2 },
    ]);
    expect(rec).toEqual({ recorded: 2 });

    await expect(
      wms.completePickList(tenantId, userId, pickListId),
    ).rejects.toMatchObject({
      name: "WmsError", code: "SHORT_PICK",
      message: expect.stringContaining("WMS-C"),
    });
  });

  it("completes once every line is fully picked, then locks the list", async () => {
    await wms.recordPicks(tenantId, userId, pickListId, [{ variantId: variantC, pickedQty: 3 }]);
    expect(await wms.completePickList(tenantId, userId, pickListId)).toEqual({ status: "completed" });

    const view = await wms.getPickList(tenantId, pickListId);
    expect(view.status).toBe("completed");
    for (const line of view.lines) expect(line.pickedQty).toBe(line.quantity);

    await expect(
      wms.recordPicks(tenantId, userId, pickListId, [{ variantId: variantC, pickedQty: 4 }]),
    ).rejects.toMatchObject({ name: "WmsError", code: "BAD_STATE" });
    await expect(
      wms.completePickList(tenantId, userId, pickListId),
    ).rejects.toMatchObject({ name: "WmsError", code: "BAD_STATE" });
  });

  it("picked order still fulfills over HTTP — fulfillment consumes the reservations", async () => {
    const fulfil = await post(`/v1/orders/${orderId}/fulfill`, {});
    expect(fulfil.statusCode).toBe(200);

    const statuses = await db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ status: string }>(
        `SELECT status FROM stock_reservation
          WHERE reference_type = 'order' AND reference_id = $1`,
        [orderId],
      );
      return rows.map((r) => r.status);
    });
    expect(statuses.length).toBe(3);
    expect(new Set(statuses)).toEqual(new Set(["consumed"]));

    expect((await post(`/v1/orders/${orderId}/fulfill`, {})).statusCode).toBe(409);
  });

  // -------------------------------------------------------------------------
  // bin_stock overlay (022): per-bin quantities WITHIN a location, layered on
  // top of the ledger-derived stock_level. Runs after the v1 directory tests;
  // uses fresh zones/bins/variants so their numbers stay self-contained.
  // -------------------------------------------------------------------------
  describe("bin stock overlay", () => {
    let bulkB1 = "";   // zone BULK (position 3), bin 1
    let bulkB2 = "";   // zone BULK, bin 2
    let overflowO1 = ""; // zone OVERFLOW (position 4), bin 1
    let otherLocBin = ""; // a bin at a DIFFERENT location
    let variantP = ""; // putaway/move subject: 10 on_hand at the warehouse
    let variantQ = ""; // pick subject: 5 on_hand at the warehouse

    const receive = (variantId: string, quantity: number) =>
      post("/v1/inventory/movements", {
        id: randomUUID(), movementType: "receipt", variantId, quantity,
        to: { locationId: warehouseId, state: "on_hand" },
        reference: { type: "grn", id: randomUUID() },
      });

    beforeAll(async () => {
      const bulk = await wms.createZone(tenantId, {
        locationId: warehouseId, code: "BULK", name: "Bulk racking", position: 3,
      });
      const overflow = await wms.createZone(tenantId, {
        locationId: warehouseId, code: "OVERFLOW", name: "Overflow", position: 4,
      });
      bulkB1 = (await wms.createBin(tenantId, { zoneId: bulk.zoneId, code: "B1", position: 1 })).binId;
      bulkB2 = (await wms.createBin(tenantId, { zoneId: bulk.zoneId, code: "B2", position: 2 })).binId;
      overflowO1 = (await wms.createBin(tenantId, { zoneId: overflow.zoneId, code: "O1", position: 1 })).binId;

      const otherLocId = (await post("/v1/locations", { kind: "warehouse", name: "WH2", code: "WH2" })).json().id;
      const otherZone = await wms.createZone(tenantId, {
        locationId: otherLocId, code: "REM", name: "Remote", position: 1,
      });
      otherLocBin = (await wms.createBin(tenantId, { zoneId: otherZone.zoneId, code: "R1" })).binId;

      const productId = (await post("/v1/products", {
        name: "Binned widget", slug: `binned-widget-${suffix}`, tracking: "none",
      })).json().id;
      const mkVariant = async (sku: string) =>
        (await post(`/v1/products/${productId}/variants`, { sku, priceMinor: 1500, currency: "AED" })).json().id;
      variantP = await mkVariant("WMS-P");
      variantQ = await mkVariant("WMS-Q");
      expect((await receive(variantP, 10)).statusCode).toBe(201);
      expect((await receive(variantQ, 5)).statusCode).toBe(201);
    }, 30_000);

    it("putaway within on_hand credits the bin; placement shows the floor remainder", async () => {
      expect(await wms.putaway(tenantId, userId, {
        binId: bulkB2, variantId: variantP, quantity: 6,
      })).toEqual({ binId: bulkB2, variantId: variantP, binQuantity: 6 });

      const placement = await wms.variantPlacement(tenantId, warehouseId, variantP);
      expect(placement).toEqual({
        onHand: 10, binned: 6, unbinned: 4,
        bins: [{ binId: bulkB2, binPath: "BULK/B2", quantity: 6 }],
      });
      expect(await wms.binContents(tenantId, bulkB2)).toEqual([
        { variantId: variantP, sku: "WMS-P", quantity: 6 },
      ]);
    });

    it("EXCEEDS_ON_HAND: cannot bin beyond location on_hand minus already-binned", async () => {
      // on_hand 10, binned 6 → only 4 left to putaway anywhere at this location.
      await expect(
        wms.putaway(tenantId, userId, { binId: bulkB1, variantId: variantP, quantity: 5 }),
      ).rejects.toMatchObject({ name: "WmsError", code: "EXCEEDS_ON_HAND" });

      // Exactly the remainder is fine (upsert accumulates per bin)…
      expect((await wms.putaway(tenantId, userId, {
        binId: bulkB1, variantId: variantP, quantity: 4,
      })).binQuantity).toBe(4);
      // …after which even the smallest putaway over-covers.
      await expect(
        wms.putaway(tenantId, userId, { binId: overflowO1, variantId: variantP, quantity: 0.001 }),
      ).rejects.toMatchObject({ name: "WmsError", code: "EXCEEDS_ON_HAND" });

      await expect(
        wms.putaway(tenantId, userId, { binId: randomUUID(), variantId: variantP, quantity: 1 }),
      ).rejects.toMatchObject({ name: "WmsError", code: "BIN_NOT_FOUND" });
    });

    it("moveBin shifts quantity between bins across zones of the same location", async () => {
      expect(await wms.moveBin(tenantId, userId, {
        fromBinId: bulkB1, toBinId: overflowO1, variantId: variantP, quantity: 3,
      })).toEqual({ moved: 3 });

      expect(await wms.binContents(tenantId, bulkB1)).toEqual([
        { variantId: variantP, sku: "WMS-P", quantity: 1 },
      ]);
      expect(await wms.binContents(tenantId, overflowO1)).toEqual([
        { variantId: variantP, sku: "WMS-P", quantity: 3 },
      ]);
      // Location total unchanged: still 10 binned, nothing on the floor.
      const placement = await wms.variantPlacement(tenantId, warehouseId, variantP);
      expect(placement.binned).toBe(10);
      expect(placement.unbinned).toBe(0);
    });

    it("CROSS_LOCATION: bins of different locations cannot exchange bin stock", async () => {
      await expect(
        wms.moveBin(tenantId, userId, {
          fromBinId: bulkB2, toBinId: otherLocBin, variantId: variantP, quantity: 1,
        }),
      ).rejects.toMatchObject({ name: "WmsError", code: "CROSS_LOCATION" });
    });

    it("INSUFFICIENT_BIN_QTY: debit-or-fail on the source bin", async () => {
      // bulkB1 holds 1 of P — asking for more fails without touching either bin.
      await expect(
        wms.moveBin(tenantId, userId, {
          fromBinId: bulkB1, toBinId: bulkB2, variantId: variantP, quantity: 99,
        }),
      ).rejects.toMatchObject({ name: "WmsError", code: "INSUFFICIENT_BIN_QTY" });
      // A variant the source bin has never held fails the same way.
      await expect(
        wms.moveBin(tenantId, userId, {
          fromBinId: bulkB1, toBinId: bulkB2, variantId: variantQ, quantity: 1,
        }),
      ).rejects.toMatchObject({ name: "WmsError", code: "INSUFFICIENT_BIN_QTY" });
      expect(await wms.binContents(tenantId, bulkB1)).toEqual([
        { variantId: variantP, sku: "WMS-P", quantity: 1 },
      ]);
    });

    it("createPickList prefers a stocked bin over the directory; recordPicks debits it", async () => {
      // Directory says BULK/B1 (earlier in the walk) but the stock physically
      // sits in OVERFLOW/O1 — the stocked bin must win the suggestion.
      await wms.assignBin(tenantId, { binId: bulkB1, variantId: variantQ });
      await wms.putaway(tenantId, userId, { binId: overflowO1, variantId: variantQ, quantity: 3 });

      const qOrder = await placeWebOrder([{ variantId: variantQ, quantity: 2 }]);
      const pick = await wms.createPickList(tenantId, userId, qOrder);
      expect(pick.locationId).toBe(warehouseId);
      expect(pick.lines).toEqual([
        expect.objectContaining({ sku: "WMS-Q", quantity: 2, binPath: "OVERFLOW/O1" }),
      ]);

      await wms.recordPicks(tenantId, userId, pick.pickListId, [
        { variantId: variantQ, pickedQty: 2 },
      ]);
      expect(await wms.binContents(tenantId, overflowO1)).toEqual([
        { variantId: variantP, sku: "WMS-P", quantity: 3 },
        { variantId: variantQ, sku: "WMS-Q", quantity: 1 },
      ]);
      expect(await wms.completePickList(tenantId, userId, pick.pickListId)).toEqual({ status: "completed" });
    });

    it("variantPlacement reconciles binned + unbinned after the pick", async () => {
      // Q: received 5, putaway 3 (floor 2). The order reserved 2 (on_hand 5→3)
      // and the pick debited the bin by 2 (3→1): on_hand 3 = binned 1 + floor 2.
      const placement = await wms.variantPlacement(tenantId, warehouseId, variantQ);
      expect(placement).toEqual({
        onHand: 3, binned: 1, unbinned: 2,
        bins: [{ binId: overflowO1, binPath: "OVERFLOW/O1", quantity: 1 }],
      });
    });
  });
});
