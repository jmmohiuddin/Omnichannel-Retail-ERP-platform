import { randomUUID } from "node:crypto";
import { LedgerError } from "@omniretail/domain";
import type { Db } from "../db.js";
import { PgInventoryService, translatePgError } from "./pgInventory.js";

export class OpsError extends Error {
  constructor(
    readonly code:
      | "SESSION_OPEN"
      | "SESSION_NOT_FOUND"
      | "TRANSFER_NOT_FOUND"
      | "COUNT_NOT_FOUND"
      | "BAD_STATE",
    message: string,
  ) {
    super(message);
    this.name = "OpsError";
  }
}

/**
 * Store operations: cash sessions (blind reconciliation, FP-005), inter-location
 * transfers, and cycle counts whose corrections are approval-gated (FP-002).
 */
export class OpsService {
  constructor(
    private readonly db: Db,
    private readonly inventory: PgInventoryService,
    private readonly audit: import("../audit/auditService.js").AuditService,
  ) {}

  // ---- cash sessions -------------------------------------------------------

  async openCashSession(
    tenantId: string,
    userId: string,
    input: { deviceId: string; openingFloatMinor: number },
  ): Promise<{ sessionId: string }> {
    return this.db.withTenant(tenantId, async (c) => {
      const open = await c.query(
        "SELECT id FROM cash_session WHERE device_id = $1 AND status = 'open'",
        [input.deviceId],
      );
      if (open.rows[0]) {
        throw new OpsError("SESSION_OPEN", "device already has an open cash session");
      }
      const sessionId = randomUUID();
      await c.query(
        `INSERT INTO cash_session (id, tenant_id, device_id, opened_by, opening_float_minor)
         VALUES ($1,$2,$3,$4,$5)`,
        [sessionId, tenantId, input.deviceId, userId, input.openingFloatMinor],
      );
      return { sessionId };
    });
  }

  /**
   * Blind close: the cashier declares the drawer count WITHOUT seeing the
   * expected figure; the system computes expectation from the ledger of cash
   * payments in the session and stores the variance for manager review.
   */
  async closeCashSession(
    tenantId: string,
    userId: string,
    sessionId: string,
    declaredMinor: number,
  ): Promise<{ expectedMinor: number; declaredMinor: number; varianceMinor: number }> {
    return this.db.withTenant(tenantId, async (c) => {
      const session = await c.query<{ status: string; opening_float_minor: string }>(
        "SELECT status, opening_float_minor FROM cash_session WHERE id = $1 FOR UPDATE",
        [sessionId],
      );
      const head = session.rows[0];
      if (!head) throw new OpsError("SESSION_NOT_FOUND", "cash session not found");
      if (head.status !== "open") throw new OpsError("BAD_STATE", "session already closed");

      const sums = await c.query<{ cash: string | null }>(
        `SELECT sum(amount_minor) AS cash FROM payment
          WHERE cash_session_id = $1 AND method = 'cash'
            AND status IN ('captured','refunded')`,
        [sessionId],
      );
      const expectedMinor = Number(head.opening_float_minor) + Number(sums.rows[0]?.cash ?? 0);
      const varianceMinor = declaredMinor - expectedMinor;
      await c.query(
        `UPDATE cash_session
            SET status = 'closed', closed_by = $2, closed_at = now(),
                declared_close_minor = $3, expected_close_minor = $4, variance_minor = $5
          WHERE id = $1`,
        [sessionId, userId, declaredMinor, expectedMinor, varianceMinor],
      );
      if (varianceMinor !== 0) {
        await c.query(
          `INSERT INTO outbox (id, tenant_id, aggregate, event_type, payload)
           VALUES ($1,$2,$3,'cash_session.variance',$4)`,
          [randomUUID(), tenantId, `cash_session:${sessionId}`,
           JSON.stringify({ sessionId, varianceMinor })],
        );
      }
      await this.audit.recordWith(c, tenantId, {
        actorUserId: userId,
        action: "cash_session.closed",
        entityType: "cash_session",
        entityId: sessionId,
        after: { expectedMinor, declaredMinor, varianceMinor },
      });
      return { expectedMinor, declaredMinor, varianceMinor };
    });
  }

  // ---- transfers -----------------------------------------------------------

  async dispatchTransfer(
    tenantId: string,
    userId: string,
    input: {
      fromLocationId: string;
      toLocationId: string;
      lines: { variantId: string; quantity: number }[];
      note?: string;
    },
  ): Promise<{ transferId: string }> {
    try {
      return await this.db.withTenant(tenantId, async (c) => {
        const transferId = randomUUID();
        await c.query(
          `INSERT INTO stock_transfer
             (id, tenant_id, from_location_id, to_location_id, status, created_by,
              dispatched_at, note)
           VALUES ($1,$2,$3,$4,'dispatched',$5, now(), $6)`,
          [transferId, tenantId, input.fromLocationId, input.toLocationId, userId,
           input.note ?? null],
        );
        for (const line of input.lines) {
          await this.inventory.postMovementWith(c, tenantId, {
            id: randomUUID(),
            movementType: "transfer_out",
            variantId: line.variantId,
            quantity: line.quantity,
            from: { locationId: input.fromLocationId, state: "on_hand" },
            to: { locationId: input.toLocationId, state: "in_transit" },
            actorUserId: userId,
            reference: { type: "transfer", id: transferId },
            occurredAt: new Date(),
          });
        }
        return { transferId };
      });
    } catch (err) {
      throw translatePgError(err);
    }
  }

  async receiveTransfer(
    tenantId: string,
    userId: string,
    transferId: string,
  ): Promise<{ status: string }> {
    try {
      return await this.db.withTenant(tenantId, async (c) => {
        const transfer = await c.query<{ status: string; to_location_id: string }>(
          "SELECT status, to_location_id FROM stock_transfer WHERE id = $1 FOR UPDATE",
          [transferId],
        );
        const head = transfer.rows[0];
        if (!head) throw new OpsError("TRANSFER_NOT_FOUND", "transfer not found");
        if (head.status !== "dispatched") throw new OpsError("BAD_STATE", `transfer is ${head.status}`);

        const { rows: moved } = await c.query<{ variant_id: string; quantity: string }>(
          `SELECT variant_id, sum(quantity) AS quantity FROM stock_movement
            WHERE reference_type = 'transfer' AND reference_id = $1
              AND movement_type = 'transfer_out'
            GROUP BY variant_id`,
          [transferId],
        );
        for (const line of moved) {
          await this.inventory.postMovementWith(c, tenantId, {
            id: randomUUID(),
            movementType: "transfer_in",
            variantId: line.variant_id,
            quantity: Number(line.quantity),
            from: { locationId: head.to_location_id, state: "in_transit" },
            to: { locationId: head.to_location_id, state: "on_hand" },
            actorUserId: userId,
            reference: { type: "transfer", id: transferId },
            occurredAt: new Date(),
          });
        }
        await c.query(
          "UPDATE stock_transfer SET status = 'received', received_at = now() WHERE id = $1",
          [transferId],
        );
        return { status: "received" };
      });
    } catch (err) {
      throw translatePgError(err);
    }
  }

  // ---- cycle counts --------------------------------------------------------

  /** Creates the count and snapshots expected quantities server-side. The
   * response deliberately excludes expectations — counts are blind (FP-006). */
  async createCount(
    tenantId: string,
    userId: string,
    input: { locationId: string; variantIds: string[] },
  ): Promise<{ countId: string; variantIds: string[] }> {
    return this.db.withTenant(tenantId, async (c) => {
      const countId = randomUUID();
      await c.query(
        `INSERT INTO stock_count (id, tenant_id, location_id, kind, status, created_by)
         VALUES ($1,$2,$3,'cycle','open',$4)`,
        [countId, tenantId, input.locationId, userId],
      );
      for (const variantId of input.variantIds) {
        await c.query(
          `INSERT INTO stock_count_line (count_id, tenant_id, variant_id, expected_qty)
           VALUES ($1,$2,$3, coalesce((SELECT quantity FROM stock_level
              WHERE location_id = $4 AND variant_id = $3 AND state = 'on_hand'), 0))`,
          [countId, tenantId, variantId, input.locationId],
        );
      }
      return { countId, variantIds: input.variantIds };
    });
  }

  async recordCounts(
    tenantId: string,
    userId: string,
    countId: string,
    counts: { variantId: string; countedQty: number }[],
  ): Promise<{ recorded: number }> {
    return this.db.withTenant(tenantId, async (c) => {
      const count = await c.query<{ status: string }>(
        "SELECT status FROM stock_count WHERE id = $1",
        [countId],
      );
      if (!count.rows[0]) throw new OpsError("COUNT_NOT_FOUND", "count not found");
      if (count.rows[0].status !== "open") throw new OpsError("BAD_STATE", "count not open");
      let recorded = 0;
      for (const item of counts) {
        const res = await c.query(
          `UPDATE stock_count_line
              SET counted_qty = $3, counted_by = $4, counted_at = now()
            WHERE count_id = $1 AND variant_id = $2`,
          [countId, item.variantId, item.countedQty, userId],
        );
        recorded += res.rowCount ?? 0;
      }
      return { recorded };
    });
  }

  /**
   * Close counting: compute variances. Zero-variance counts post immediately;
   * any variance parks the count in 'review' behind a manager approval whose
   * decision posts approval-stamped count_correction movements.
   */
  async submitCount(
    tenantId: string,
    userId: string,
    countId: string,
  ): Promise<{ status: string; variances: { variantId: string; delta: number }[]; approvalId?: string }> {
    return this.db.withTenant(tenantId, async (c) => {
      const count = await c.query<{ status: string; location_id: string }>(
        "SELECT status, location_id FROM stock_count WHERE id = $1 FOR UPDATE",
        [countId],
      );
      const head = count.rows[0];
      if (!head) throw new OpsError("COUNT_NOT_FOUND", "count not found");
      if (head.status !== "open") throw new OpsError("BAD_STATE", "count not open");

      const { rows: lines } = await c.query<{
        variant_id: string; expected_qty: string; counted_qty: string | null;
      }>(
        "SELECT variant_id, expected_qty, counted_qty FROM stock_count_line WHERE count_id = $1",
        [countId],
      );
      const uncounted = lines.filter((l) => l.counted_qty === null);
      if (uncounted.length > 0) {
        throw new LedgerError("INVALID_SHAPE", `${uncounted.length} line(s) not yet counted`);
      }
      const variances = lines
        .map((l) => ({
          variantId: l.variant_id,
          delta: Number(l.counted_qty) - Number(l.expected_qty),
        }))
        .filter((v) => v.delta !== 0);

      if (variances.length === 0) {
        await c.query(
          "UPDATE stock_count SET status = 'posted', posted_at = now() WHERE id = $1",
          [countId],
        );
        return { status: "posted", variances: [] };
      }

      const approvalId = randomUUID();
      await c.query(
        `INSERT INTO approval (id, tenant_id, kind, requested_by, status, payload, reason)
         VALUES ($1,$2,'stock_count',$3,'pending',$4,$5)`,
        [approvalId, tenantId, userId,
         JSON.stringify({ countId, locationId: head.location_id, variances }),
         `cycle count variance at ${head.location_id}`],
      );
      await c.query("UPDATE stock_count SET status = 'review' WHERE id = $1", [countId]);
      return { status: "review", variances, approvalId };
    });
  }
}
