import { randomUUID } from "node:crypto";
import { LedgerError, assertTransition } from "@omniretail/domain";
import type { Db } from "../db.js";
import { PgInventoryService, translatePgError } from "./pgInventory.js";

/**
 * Serialized-unit lifecycle beyond sale: repair round-trips and the full
 * per-unit history (the phone's biography — receiving, sale, returns,
 * repairs — every step a ledger movement).
 */
export class UnitService {
  constructor(
    private readonly db: Db,
    private readonly inventory: PgInventoryService,
  ) {}

  private async loadUnit(c: import("pg").PoolClient, unitId: string) {
    const { rows } = await c.query<{
      id: string; variant_id: string; state: string; location_id: string | null;
    }>(
      "SELECT id, variant_id, state, location_id FROM stock_unit WHERE id = $1 FOR UPDATE",
      [unitId],
    );
    if (!rows[0]) throw new LedgerError("SERIALIZED_RULE", `unknown unit ${unitId}`);
    return rows[0];
  }

  /** Send an in-stock unit to repair: unit → in_repair, bucket on_hand → damaged. */
  /**
   * Send a unit out for repair.
   *
   * `occurredAt` exists because repairs are logged after the fact — a handset
   * handed over on Saturday gets recorded on Monday — and because R10.7
   * computes the warranty extension from this timestamp, so a wrong one
   * shortens the customer's cover. Defaults to now.
   */
  async repairOut(
    tenantId: string,
    actorUserId: string,
    unitId: string,
    note?: string,
    occurredAt?: Date,
  ) {
    try {
      return await this.db.withTenant(tenantId, async (c) => {
        const unit = await this.loadUnit(c, unitId);
        assertTransition(unitId, unit.state as never, "in_repair");
        if (!unit.location_id) {
          throw new LedgerError("SERIALIZED_RULE", "unit has no location");
        }
        await this.inventory.postMovementWith(c, tenantId, {
          id: randomUUID(),
          movementType: "repair_out",
          variantId: unit.variant_id,
          stockUnitId: unitId,
          quantity: 1,
          from: { locationId: unit.location_id, state: "on_hand" },
          to: { locationId: unit.location_id, state: "damaged" },
          actorUserId,
          reference: { type: "repair", id: unitId },
          occurredAt: occurredAt ?? new Date(),
          ...(note ? { note } : {}),
        });
        await c.query(
          "UPDATE stock_unit SET state = 'in_repair', updated_at = now() WHERE id = $1",
          [unitId],
        );
        return { state: "in_repair" };
      });
    } catch (err) {
      throw translatePgError(err);
    }
  }

  /** Return a repaired unit to stock: unit → in_stock, bucket damaged → on_hand. */
  async repairIn(tenantId: string, actorUserId: string, unitId: string, note?: string) {
    try {
      return await this.db.withTenant(tenantId, async (c) => {
        const unit = await this.loadUnit(c, unitId);
        assertTransition(unitId, unit.state as never, "in_stock");
        if (unit.state !== "in_repair") {
          throw new LedgerError("INVALID_TRANSITION", `unit is ${unit.state}, not in_repair`);
        }
        if (!unit.location_id) {
          throw new LedgerError("SERIALIZED_RULE", "unit has no location");
        }
        await this.inventory.postMovementWith(c, tenantId, {
          id: randomUUID(),
          movementType: "repair_in",
          variantId: unit.variant_id,
          stockUnitId: unitId,
          quantity: 1,
          from: { locationId: unit.location_id, state: "damaged" },
          to: { locationId: unit.location_id, state: "on_hand" },
          actorUserId,
          reference: { type: "repair", id: unitId },
          occurredAt: new Date(),
          ...(note ? { note } : {}),
        });
        // R10.7 — the warranty clock extends by downtime.
        //
        // Cabinet Decision 66/2023 Art. 19: warranty runs from receipt of the
        // good and is extended by any period the customer could not use it.
        // Leaving `warranty_until` static silently shortens every repaired
        // unit's cover by exactly the time it spent with us, which is the
        // customer's loss and the shop's liability.
        //
        // The downtime is read from the ledger rather than from a new column:
        // `stock_movement` is append-only and already records when this unit
        // went out for repair, so it is the authoritative — and untamperable
        // — source. If no repair_out is found the warranty is left alone
        // rather than guessed at.
        const { rows: outAt } = await c.query<{ occurred_at: Date }>(
          `SELECT occurred_at FROM stock_movement
            WHERE stock_unit_id = $1 AND movement_type = 'repair_out'
            ORDER BY occurred_at DESC LIMIT 1`,
          [unitId],
        );
        const repairStartedAt = outAt[0]?.occurred_at;

        await c.query(
          `UPDATE stock_unit
              SET state = 'in_stock',
                  updated_at = now(),
                  warranty_until = CASE
                    WHEN warranty_until IS NULL OR $2::timestamptz IS NULL
                      THEN warranty_until
                    -- Whole days, rounded to nearest, with a floor of 1: a
                    -- 14-day repair extends cover by 14 days, and a unit in
                    -- and out the same day still cost the customer a day's
                    -- use, so downtime never rounds away to nothing.
                    ELSE warranty_until
                         + make_interval(days => GREATEST(
                             1, ROUND(EXTRACT(EPOCH FROM (now() - $2::timestamptz)) / 86400)::int))
                  END
            WHERE id = $1
            RETURNING warranty_until`,
          [unitId, repairStartedAt ?? null],
        );
        return { state: "in_stock" };
      });
    } catch (err) {
      throw translatePgError(err);
    }
  }

  /** The unit's biography: identity, warranty, sale, and every ledger movement. */
  async history(tenantId: string, unitId: string): Promise<Record<string, unknown> | undefined> {
    return this.db.withTenant(tenantId, async (c) => {
      const unit = await c.query(
        `SELECT su.id, su.imei1, su.imei2, su.serial_no AS "serialNo", su.state,
                su.warranty_until AS "warrantyUntil", su.unit_cost_minor AS "unitCostMinor",
                su.purchase_order_id AS "purchaseOrderId",
                v.sku, p.name AS "productName",
                o.order_no AS "soldOrderNo", o.placed_at AS "soldAt",
                cu.full_name AS "soldTo"
           FROM stock_unit su
           JOIN variant v ON v.id = su.variant_id
           JOIN product p ON p.id = v.product_id
           LEFT JOIN sales_order o ON o.id = su.sold_order_id
           LEFT JOIN customer cu ON cu.id = o.customer_id
          WHERE su.id = $1`,
        [unitId],
      );
      const head = unit.rows[0];
      if (!head) return undefined;
      const { rows: movements } = await c.query(
        `SELECT m.seq, m.occurred_at AS "occurredAt", m.movement_type AS "movementType",
                m.from_state AS "fromState", m.to_state AS "toState",
                m.note, u.full_name AS "actor"
           FROM stock_movement m LEFT JOIN app_user u ON u.id = m.actor_user_id
          WHERE m.stock_unit_id = $1 ORDER BY m.seq`,
        [unitId],
      );
      return { ...head, movements };
    });
  }
}
