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
      | "SHORT_PICK"
      | "EXCEEDS_ON_HAND"
      | "INSUFFICIENT_BIN_QTY"
      | "CROSS_LOCATION",
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

export interface BinStockLine {
  variantId: string;
  sku: string;
  quantity: number;
}

export interface VariantPlacement {
  /** stock_level.on_hand at the location — the ledger-derived truth. */
  onHand: number;
  /** Sum of bin_stock over the location's bins for this variant. */
  binned: number;
  /** on_hand − binned: stock physically present but not putaway ("floor"). */
  unbinned: number;
  bins: { binId: string; binPath: string; quantity: number }[];
}

export interface ZoneLayout {
  zoneId: string;
  code: string;
  name: string;
  position: number;
  bins: { binId: string; code: string; position: number; skus: string[] }[];
}

/**
 * WMS: bin directory + guided picking + per-bin quantity OVERLAY (022).
 *
 * DESIGN DECISION — bin quantities are an overlay, not a second ledger. The
 * movement ledger and stock_level remain the location-level source of truth
 * for how much stock exists; bin_stock only tracks physical placement WITHIN
 * a location. Invariant, enforced at putaway time under an advisory lock:
 * for any (location, variant), sum(bin_stock.quantity) <= stock_level.on_hand.
 * Bins may UNDER-cover (unputaway stock sits in an implicit "floor" area) but
 * putaway can never OVER-cover on_hand.
 *
 * Completing a pick list does NOT move ledger stock: the existing fulfillment
 * flow (POST /v1/orders/:id/fulfill) consumes the order's active reservations
 * (reserved → sale) in the ledger. The pick list certifies that the goods
 * physically left the shelves — which is exactly why recordPicks also debits
 * the bin_stock overlay.
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

  // ---- bin stock overlay ---------------------------------------------------

  /**
   * Record that `quantity` of a variant was physically placed into a bin.
   * Coverage check: you can never bin more than the location's ledger on_hand
   * minus what is already binned there — bins may under-cover on_hand (the
   * remainder is unputaway "floor" stock) but never over-cover it.
   *
   * Race-safe: an advisory transaction lock on (tenant, location, variant)
   * serializes concurrent putaways so two workers cannot both pass the
   * coverage read and jointly overshoot on_hand.
   */
  async putaway(
    tenantId: string,
    userId: string,
    input: { binId: string; variantId: string; quantity: number },
  ): Promise<{ binId: string; variantId: string; binQuantity: number }> {
    void userId; // attribution reserved for a later bin-audit trail
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new WmsError("BAD_STATE", "quantity must be a positive number");
    }
    return this.db.withTenant(tenantId, async (c) => {
      const bin = await c.query<{ location_id: string }>(
        `SELECT z.location_id
           FROM warehouse_bin b JOIN warehouse_zone z ON z.id = b.zone_id
          WHERE b.id = $1`,
        [input.binId],
      );
      if (!bin.rows[0]) throw new WmsError("BIN_NOT_FOUND", "bin not found");
      const locationId = bin.rows[0].location_id;

      // Serialize the coverage check per (tenant, location, variant); the lock
      // is transaction-scoped and released automatically on commit/rollback.
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2 || ':' || $3, 0))",
        [tenantId, locationId, input.variantId],
      );

      const cov = await c.query<{ on_hand: string; binned: string }>(
        `SELECT coalesce((SELECT sl.quantity FROM stock_level sl
                           WHERE sl.location_id = $1 AND sl.variant_id = $2
                             AND sl.state = 'on_hand'), 0) AS on_hand,
                coalesce((SELECT sum(bs.quantity)
                            FROM bin_stock bs
                            JOIN warehouse_bin b ON b.id = bs.bin_id
                            JOIN warehouse_zone z ON z.id = b.zone_id
                           WHERE z.location_id = $1 AND bs.variant_id = $2), 0) AS binned`,
        [locationId, input.variantId],
      );
      const onHand = Number(cov.rows[0]!.on_hand);
      const binned = Number(cov.rows[0]!.binned);
      if (input.quantity > onHand - binned) {
        throw new WmsError(
          "EXCEEDS_ON_HAND",
          `cannot putaway ${input.quantity}: location on_hand ${onHand}, already binned ${binned}`,
        );
      }

      const { rows } = await c.query<{ quantity: string }>(
        `INSERT INTO bin_stock (tenant_id, bin_id, variant_id, quantity)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, bin_id, variant_id)
         DO UPDATE SET quantity = bin_stock.quantity + EXCLUDED.quantity,
                       updated_at = now()
         RETURNING quantity`,
        [tenantId, input.binId, input.variantId, input.quantity],
      );
      return {
        binId: input.binId,
        variantId: input.variantId,
        binQuantity: Number(rows[0]!.quantity),
      };
    });
  }

  /**
   * Move quantity between two bins. Bins may be in different zones but MUST
   * belong to the same location — a cross-location move is a ledger transfer,
   * not a bin shuffle. Debit-or-fail on the source (the conditional UPDATE is
   * the race arbiter: no advisory lock needed since the location total is
   * unchanged), then credit the destination.
   */
  async moveBin(
    tenantId: string,
    userId: string,
    input: { fromBinId: string; toBinId: string; variantId: string; quantity: number },
  ): Promise<{ moved: number }> {
    void userId; // attribution reserved for a later bin-audit trail
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new WmsError("BAD_STATE", "quantity must be a positive number");
    }
    return this.db.withTenant(tenantId, async (c) => {
      const { rows: bins } = await c.query<{ id: string; location_id: string }>(
        `SELECT b.id, z.location_id
           FROM warehouse_bin b JOIN warehouse_zone z ON z.id = b.zone_id
          WHERE b.id = ANY($1::uuid[])`,
        [[input.fromBinId, input.toBinId]],
      );
      const from = bins.find((b) => b.id === input.fromBinId);
      const to = bins.find((b) => b.id === input.toBinId);
      if (!from) throw new WmsError("BIN_NOT_FOUND", "source bin not found");
      if (!to) throw new WmsError("BIN_NOT_FOUND", "destination bin not found");
      if (from.location_id !== to.location_id) {
        throw new WmsError(
          "CROSS_LOCATION",
          "bins belong to different locations; use a stock transfer, not a bin move",
        );
      }
      if (input.fromBinId === input.toBinId) return { moved: 0 };

      const debit = await c.query(
        `UPDATE bin_stock SET quantity = quantity - $4, updated_at = now()
          WHERE tenant_id = $1 AND bin_id = $2 AND variant_id = $3 AND quantity >= $4`,
        [tenantId, input.fromBinId, input.variantId, input.quantity],
      );
      if ((debit.rowCount ?? 0) === 0) {
        throw new WmsError(
          "INSUFFICIENT_BIN_QTY",
          `source bin does not hold ${input.quantity} of the variant`,
        );
      }
      await c.query(
        `INSERT INTO bin_stock (tenant_id, bin_id, variant_id, quantity)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, bin_id, variant_id)
         DO UPDATE SET quantity = bin_stock.quantity + EXCLUDED.quantity,
                       updated_at = now()`,
        [tenantId, input.toBinId, input.variantId, input.quantity],
      );
      return { moved: input.quantity };
    });
  }

  /** What physically sits in a bin (bin_stock overlay), by SKU. */
  async binContents(tenantId: string, binId: string): Promise<BinStockLine[]> {
    return this.db.withTenant(tenantId, async (c) => {
      const bin = await c.query("SELECT 1 FROM warehouse_bin WHERE id = $1", [binId]);
      if (!bin.rows[0]) throw new WmsError("BIN_NOT_FOUND", "bin not found");
      const { rows } = await c.query<{ variant_id: string; sku: string; quantity: string }>(
        `SELECT bs.variant_id, v.sku, bs.quantity
           FROM bin_stock bs JOIN variant v ON v.id = bs.variant_id
          WHERE bs.bin_id = $1 AND bs.quantity > 0
          ORDER BY v.sku`,
        [binId],
      );
      return rows.map((r) => ({
        variantId: r.variant_id,
        sku: r.sku,
        quantity: Number(r.quantity),
      }));
    });
  }

  /**
   * Where a variant physically sits within a location: bins holding quantity
   * (walking order) plus the unbinned remainder (ledger on_hand − binned) —
   * stock that was received but never putaway, sitting on the implicit floor.
   */
  async variantPlacement(
    tenantId: string,
    locationId: string,
    variantId: string,
  ): Promise<VariantPlacement> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows: bins } = await c.query<{ bin_id: string; bin_path: string; quantity: string }>(
        `SELECT bs.bin_id, z.code || '/' || b.code AS bin_path, bs.quantity
           FROM bin_stock bs
           JOIN warehouse_bin b ON b.id = bs.bin_id
           JOIN warehouse_zone z ON z.id = b.zone_id
          WHERE z.location_id = $1 AND bs.variant_id = $2 AND bs.quantity > 0
          ORDER BY z.position, b.position, z.code, b.code`,
        [locationId, variantId],
      );
      const { rows: level } = await c.query<{ quantity: string }>(
        `SELECT quantity FROM stock_level
          WHERE location_id = $1 AND variant_id = $2 AND state = 'on_hand'`,
        [locationId, variantId],
      );
      const onHand = Number(level[0]?.quantity ?? 0);
      const binned = bins.reduce((sum, b) => sum + Number(b.quantity), 0);
      return {
        onHand,
        binned,
        unbinned: onHand - binned,
        bins: bins.map((b) => ({
          binId: b.bin_id,
          binPath: b.bin_path,
          quantity: Number(b.quantity),
        })),
      };
    });
  }

  // ---- picking -------------------------------------------------------------

  /**
   * One pick list per reserved order. Lines mirror the order's variants and
   * quantities; each line carries a precomputed "ZONE/BIN" suggestion. Bins
   * that actually HOLD quantity (bin_stock > 0) are preferred, in walking
   * order (zone.position then bin.position); when nothing is binned we fall
   * back to the directory assignment (bin_assignment) in the same order.
   * Variants with neither get a NULL bin_path and sort last: the picker
   * handles the known walk first, then hunts the strays.
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
               -- Prefer bins that actually HOLD quantity (bin_stock overlay),
               -- then fall back to the directory assignment; walking order
               -- within each tier.
               SELECT z.code || '/' || b.code AS bin_path
                 FROM warehouse_bin b
                 JOIN warehouse_zone z ON z.id = b.zone_id
                 LEFT JOIN bin_stock bs
                        ON bs.bin_id = b.id AND bs.variant_id = need.variant_id
                       AND bs.quantity > 0
                 LEFT JOIN bin_assignment ba
                        ON ba.bin_id = b.id AND ba.variant_id = need.variant_id
                WHERE z.location_id = $4
                  AND (bs.bin_id IS NOT NULL OR ba.bin_id IS NOT NULL)
                ORDER BY (bs.bin_id IS NULL), z.position, b.position, z.code, b.code
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

  /**
   * Record picked quantities. When a line has a bin_path suggestion, the pick
   * also debits the bin_stock overlay for that bin.
   *
   * POLICY — physical reality wins: the picker took the goods off the shelf
   * whether or not the overlay agrees. If the suggested bin holds less than
   * the picked delta, we decrement what it has (clamped at zero) and treat
   * the remainder as taken from unbinned floor stock — the pick is NEVER
   * blocked and bin_stock NEVER goes negative. Downward corrections
   * (re-recording a smaller picked_qty) do not auto-restock the bin either:
   * goods going back on a shelf are an explicit putaway.
   */
  async recordPicks(
    tenantId: string,
    userId: string,
    pickListId: string,
    picks: { variantId: string; pickedQty: number }[],
  ): Promise<{ recorded: number }> {
    return this.db.withTenant(tenantId, async (c) => {
      const head = await c.query<{ status: string; location_id: string }>(
        "SELECT status, location_id FROM pick_list WHERE id = $1 FOR UPDATE",
        [pickListId],
      );
      if (!head.rows[0]) throw new WmsError("PICK_NOT_FOUND", "pick list not found");
      if (head.rows[0].status !== "open") {
        throw new WmsError("BAD_STATE", `pick list is ${head.rows[0].status}`);
      }
      const locationId = head.rows[0].location_id;
      let recorded = 0;
      for (const pick of picks) {
        // Capture the previous picked_qty so re-records only debit the delta.
        const res = await c.query<{ bin_path: string | null; old_qty: string | null }>(
          `UPDATE pick_list_line l SET picked_qty = $3, picked_by = $4
             FROM (SELECT picked_qty AS old_qty FROM pick_list_line
                    WHERE pick_list_id = $1 AND variant_id = $2 FOR UPDATE) prev
            WHERE l.pick_list_id = $1 AND l.variant_id = $2
            RETURNING l.bin_path, prev.old_qty`,
          [pickListId, pick.variantId, pick.pickedQty, userId],
        );
        const line = res.rows[0];
        if (!line) continue;
        recorded += 1;

        const delta = pick.pickedQty - Number(line.old_qty ?? 0);
        if (line.bin_path !== null && delta > 0) {
          // Resolve the line's suggested bin by its "ZONE/BIN" path at the
          // pick list's location and debit what it has (never below zero).
          await c.query(
            `UPDATE bin_stock bs
                SET quantity = greatest(bs.quantity - $4, 0), updated_at = now()
               FROM warehouse_bin b JOIN warehouse_zone z ON z.id = b.zone_id
              WHERE bs.bin_id = b.id
                AND z.location_id = $1
                AND z.code || '/' || b.code = $2
                AND bs.variant_id = $3`,
            [locationId, line.bin_path, pick.variantId, delta],
          );
        }
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
