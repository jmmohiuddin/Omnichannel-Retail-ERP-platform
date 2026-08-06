import { randomUUID } from "node:crypto";
import type pg from "pg";
import { isPgError, type Db } from "../db.js";

export class WmsError extends Error {
  constructor(
    readonly code:
      | "ORDER_NOT_FOUND"
      | "BAD_STATE"
      | "PICK_NOT_FOUND"
      | "ALREADY_EXISTS"
      | "ZONE_NOT_FOUND"
      | "BIN_NOT_FOUND"
      | "SHORT_PICK",
    message: string,
  ) {
    super(message);
    this.name = "WmsError";
  }
}

export interface PickListLine {
  variantId: string;
  sku: string;
  quantity: number;
  binPath: string | null;
  pickedQty: number | null;
}

export interface ZoneLayout {
  zoneId: string;
  code: string;
  name: string;
  position: number;
  bins: { binId: string; code: string; position: number; skus: string[] }[];
}

/**
 * v1 WMS: bin directory + guided picking.
 *
 * Deliberately NOT quantity-per-bin — stock quantities remain in stock_level,
 * maintained by the inventory ledger. Bins are a directory telling pickers
 * WHERE TO WALK for a variant; assignments and picks never write quantities.
 *
 * Completing a pick list does NOT move stock either: the existing fulfillment
 * flow (POST /v1/orders/:id/fulfill) consumes the order's active reservations
 * (reserved → sale) in the ledger. The pick list only certifies that the goods
 * physically left the shelves in the right amounts.
 */
export class WmsService {
  constructor(private readonly db: Db) {}

  // ---- layout --------------------------------------------------------------

  async createZone(
    tenantId: string,
    input: { locationId: string; code: string; name: string; position?: number },
  ): Promise<{ zoneId: string }> {
    return this.db.withTenant(tenantId, async (c) => {
      const zoneId = randomUUID();
      await c.query(
        `INSERT INTO warehouse_zone (id, tenant_id, location_id, code, name, position)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [zoneId, tenantId, input.locationId, input.code, input.name, input.position ?? 0],
      );
      return { zoneId };
    });
  }

  async createBin(
    tenantId: string,
    input: { zoneId: string; code: string; position?: number },
  ): Promise<{ binId: string }> {
    return this.db.withTenant(tenantId, async (c) => {
      const zone = await c.query("SELECT 1 FROM warehouse_zone WHERE id = $1", [input.zoneId]);
      if (!zone.rows[0]) throw new WmsError("ZONE_NOT_FOUND", "zone not found");
      const binId = randomUUID();
      await c.query(
        `INSERT INTO warehouse_bin (id, tenant_id, zone_id, code, position)
         VALUES ($1,$2,$3,$4,$5)`,
        [binId, tenantId, input.zoneId, input.code, input.position ?? 0],
      );
      return { binId };
    });
  }

  /** Idempotent: assigning the same variant to the same bin twice is a no-op. */
  async assignBin(
    tenantId: string,
    input: { binId: string; variantId: string },
  ): Promise<{ assigned: boolean }> {
    return this.db.withTenant(tenantId, async (c) => {
      const bin = await c.query("SELECT 1 FROM warehouse_bin WHERE id = $1", [input.binId]);
      if (!bin.rows[0]) throw new WmsError("BIN_NOT_FOUND", "bin not found");
      const res = await c.query(
        `INSERT INTO bin_assignment (tenant_id, bin_id, variant_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, bin_id, variant_id) DO NOTHING`,
        [tenantId, input.binId, input.variantId],
      );
      return { assigned: (res.rowCount ?? 0) > 0 };
    });
  }

  /** Zones (walking order) with their bins and the SKUs assigned to each bin. */
  async locationLayout(tenantId: string, locationId: string): Promise<ZoneLayout[]> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{
        zone_id: string; zone_code: string; zone_name: string; zone_position: number;
        bins: ZoneLayout["bins"];
      }>(
        `SELECT z.id AS zone_id, z.code AS zone_code, z.name AS zone_name,
                z.position AS zone_position,
                coalesce(json_agg(json_build_object(
                  'binId', b.id, 'code', b.code, 'position', b.position,
                  'skus', coalesce(bs.skus, '[]'::json)
                ) ORDER BY b.position, b.code) FILTER (WHERE b.id IS NOT NULL), '[]') AS bins
           FROM warehouse_zone z
           LEFT JOIN warehouse_bin b ON b.zone_id = z.id
           LEFT JOIN LATERAL (
             SELECT json_agg(v.sku ORDER BY v.sku) AS skus
               FROM bin_assignment ba JOIN variant v ON v.id = ba.variant_id
              WHERE ba.bin_id = b.id
           ) bs ON true
          WHERE z.location_id = $1
          GROUP BY z.id
          ORDER BY z.position, z.code`,
        [locationId],
      );
      return rows.map((r) => ({
        zoneId: r.zone_id,
        code: r.zone_code,
        name: r.zone_name,
        position: r.zone_position,
        bins: r.bins,
      }));
    });
  }

  // ---- picking -------------------------------------------------------------

  /**
   * One pick list per reserved order. Lines mirror the order's variants and
   * quantities; each line carries a precomputed "ZONE/BIN" suggestion — the
   * first matching bin assignment in walking order (zone.position then
   * bin.position). Variants with no assignment get a NULL bin_path and sort
   * last: the picker handles the known walk first, then hunts the strays.
   */
  async createPickList(
    tenantId: string,
    userId: string,
    orderId: string,
  ): Promise<{ pickListId: string; orderId: string; locationId: string; lines: PickListLine[] }> {
    try {
      return await this.db.withTenant(tenantId, async (c) => {
        const order = await c.query<{ status: string; location_id: string | null }>(
          "SELECT status, location_id FROM sales_order WHERE id = $1 FOR UPDATE",
          [orderId],
        );
        const head = order.rows[0];
        if (!head) throw new WmsError("ORDER_NOT_FOUND", "order not found");
        if (!["pending", "confirmed"].includes(head.status) || !head.location_id) {
          throw new WmsError("BAD_STATE", `order is ${head.status}`);
        }
        const reserved = await c.query(
          `SELECT 1 FROM stock_reservation
            WHERE reference_type = 'order' AND reference_id = $1 AND status = 'active'
            LIMIT 1`,
          [orderId],
        );
        if (!reserved.rows[0]) {
          throw new WmsError("BAD_STATE", "order has no active stock reservations");
        }
        const existing = await c.query(
          "SELECT 1 FROM pick_list WHERE order_id = $1",
          [orderId],
        );
        if (existing.rows[0]) {
          throw new WmsError("ALREADY_EXISTS", "order already has a pick list");
        }

        const pickListId = randomUUID();
        await c.query(
          `INSERT INTO pick_list (id, tenant_id, order_id, location_id, status, created_by)
           VALUES ($1,$2,$3,$4,'open',$5)`,
          [pickListId, tenantId, orderId, head.location_id, userId],
        );
        await c.query(
          `INSERT INTO pick_list_line (pick_list_id, tenant_id, variant_id, quantity, bin_path)
           SELECT $1, $2, need.variant_id, need.quantity, bp.bin_path
             FROM (SELECT variant_id, sum(quantity) AS quantity
                     FROM sales_order_line WHERE order_id = $3
                    GROUP BY variant_id) need
             LEFT JOIN LATERAL (
               SELECT z.code || '/' || b.code AS bin_path
                 FROM bin_assignment ba
                 JOIN warehouse_bin b ON b.id = ba.bin_id
                 JOIN warehouse_zone z ON z.id = b.zone_id
                WHERE ba.variant_id = need.variant_id AND z.location_id = $4
                ORDER BY z.position, b.position, z.code, b.code
                LIMIT 1
             ) bp ON true`,
          [pickListId, tenantId, orderId, head.location_id],
        );
        const lines = await this.readLines(c, pickListId);
        return { pickListId, orderId, locationId: head.location_id, lines };
      });
    } catch (err) {
      // Concurrent createPickList for the same order: the (tenant_id, order_id)
      // unique constraint is the arbiter.
      if (isPgError(err) && err.code === "23505") {
        throw new WmsError("ALREADY_EXISTS", "order already has a pick list");
      }
      throw err;
    }
  }

  async getPickList(
    tenantId: string,
    pickListId: string,
  ): Promise<{ pickListId: string; orderId: string; locationId: string; status: string; lines: PickListLine[] }> {
    return this.db.withTenant(tenantId, async (c) => {
      const head = await c.query<{ order_id: string; location_id: string; status: string }>(
        "SELECT order_id, location_id, status FROM pick_list WHERE id = $1",
        [pickListId],
      );
      const row = head.rows[0];
      if (!row) throw new WmsError("PICK_NOT_FOUND", "pick list not found");
      const lines = await this.readLines(c, pickListId);
      return {
        pickListId,
        orderId: row.order_id,
        locationId: row.location_id,
        status: row.status,
        lines,
      };
    });
  }

  async recordPicks(
    tenantId: string,
    userId: string,
    pickListId: string,
    picks: { variantId: string; pickedQty: number }[],
  ): Promise<{ recorded: number }> {
    return this.db.withTenant(tenantId, async (c) => {
      const head = await c.query<{ status: string }>(
        "SELECT status FROM pick_list WHERE id = $1 FOR UPDATE",
        [pickListId],
      );
      if (!head.rows[0]) throw new WmsError("PICK_NOT_FOUND", "pick list not found");
      if (head.rows[0].status !== "open") {
        throw new WmsError("BAD_STATE", `pick list is ${head.rows[0].status}`);
      }
      let recorded = 0;
      for (const pick of picks) {
        const res = await c.query(
          `UPDATE pick_list_line SET picked_qty = $3, picked_by = $4
            WHERE pick_list_id = $1 AND variant_id = $2`,
          [pickListId, pick.variantId, pick.pickedQty, userId],
        );
        recorded += res.rowCount ?? 0;
      }
      return { recorded };
    });
  }

  /**
   * Every line must be fully picked (picked_qty = quantity). Short picks throw
   * SHORT_PICK listing the short variants — the operator resolves the shortage
   * and either re-picks (recordPicks again) or cancels the order.
   *
   * Completion does NOT move stock: fulfillment (POST /v1/orders/:id/fulfill,
   * existing flow) consumes the order's reservations in the inventory ledger.
   */
  async completePickList(
    tenantId: string,
    userId: string,
    pickListId: string,
  ): Promise<{ status: string }> {
    return this.db.withTenant(tenantId, async (c) => {
      const head = await c.query<{ status: string }>(
        "SELECT status FROM pick_list WHERE id = $1 FOR UPDATE",
        [pickListId],
      );
      if (!head.rows[0]) throw new WmsError("PICK_NOT_FOUND", "pick list not found");
      if (head.rows[0].status !== "open") {
        throw new WmsError("BAD_STATE", `pick list is ${head.rows[0].status}`);
      }
      const { rows: short } = await c.query<{ sku: string; quantity: string; picked_qty: string | null }>(
        `SELECT v.sku, l.quantity, l.picked_qty
           FROM pick_list_line l JOIN variant v ON v.id = l.variant_id
          WHERE l.pick_list_id = $1
            AND (l.picked_qty IS NULL OR l.picked_qty <> l.quantity)
          ORDER BY v.sku`,
        [pickListId],
      );
      if (short.length > 0) {
        const detail = short
          .map((s) => `${s.sku} (picked ${s.picked_qty ?? 0} of ${Number(s.quantity)})`)
          .join(", ");
        throw new WmsError("SHORT_PICK", `short-picked lines: ${detail}`);
      }
      await c.query(
        "UPDATE pick_list SET status = 'completed', completed_at = now() WHERE id = $1",
        [pickListId],
      );
      return { status: "completed" };
    });
  }

  // ---- helpers -------------------------------------------------------------

  /** Lines in walking order: bin_path NULLS LAST, then sku. */
  private async readLines(c: pg.PoolClient, pickListId: string): Promise<PickListLine[]> {
    const { rows } = await c.query<{
      variant_id: string; sku: string; quantity: string;
      bin_path: string | null; picked_qty: string | null;
    }>(
      `SELECT l.variant_id, v.sku, l.quantity, l.bin_path, l.picked_qty
         FROM pick_list_line l JOIN variant v ON v.id = l.variant_id
        WHERE l.pick_list_id = $1
        ORDER BY l.bin_path NULLS LAST, v.sku`,
      [pickListId],
    );
    return rows.map((r) => ({
      variantId: r.variant_id,
      sku: r.sku,
      quantity: Number(r.quantity),
      binPath: r.bin_path,
      pickedQty: r.picked_qty === null ? null : Number(r.picked_qty),
    }));
  }
}
