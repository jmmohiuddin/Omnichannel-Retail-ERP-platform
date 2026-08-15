import { randomUUID } from "node:crypto";
import { assertTransition, LedgerError } from "@omniretail/domain";
import type { Db } from "../db.js";
import { PgInventoryService, translatePgError } from "./pgInventory.js";

export class OpsError extends Error {
  constructor(
    readonly code:
      | "SESSION_OPEN"
      | "SESSION_NOT_FOUND"
      | "TRANSFER_NOT_FOUND"
      | "COUNT_NOT_FOUND"
      /** A serialized transfer named the wrong units, or units that cannot move. */
      | "SERIALIZED_RULE"
      /** Caller's roles do not permit adjusting stock. */
      | "FORBIDDEN_ROLE"
      /** No approval, the wrong kind of approval, or one not yet approved. */
      | "ADJUSTMENT_NOT_APPROVED"
      /** That approval has already been spent on a movement. */
      | "ADJUSTMENT_ALREADY_POSTED"
      | "BAD_STATE",
    message: string,
  ) {
    super(message);
    this.name = "OpsError";
  }
}

/** R4.1's reason codes. Mirrors the CHECK in 029_adjustment_reasons.sql. */
export const ADJUSTMENT_REASONS = [
  "damage",
  "theft",
  "found",
  "correction",
  "sample",
  "write_off",
] as const;

export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

/** Buckets an adjustment may draw stock out of. */
export const ADJUSTMENT_SOURCE_STATES = ["on_hand", "damaged", "returned_pending"] as const;

export type AdjustmentSourceState = (typeof ADJUSTMENT_SOURCE_STATES)[number];

export interface AdjustmentRequest {
  locationId: string;
  variantId: string;
  /** Units to remove. NUMERIC(14,3) — at most three decimal places. */
  quantity: number;
  reason: AdjustmentReason;
  /** Which bucket the stock leaves. Defaults to sellable stock. */
  fromState?: AdjustmentSourceState;
  note?: string;
}

/** Stock a `found` adjustment would add rather than remove. */
const INCREASE_REASONS = new Set<AdjustmentReason>(["found"]);

/** Adjusting stock is a stock-keeper's job, never a cashier's. */
const ADJUSTER_ROLES = new Set(["owner", "manager", "warehouse"]);

const APPROVAL_KIND = "stock_adjustment";

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
      lines: { variantId: string; quantity: number; stockUnitIds?: string[] }[];
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
          const { rows } = await c.query<{ tracking: string }>(
            `SELECT p.tracking FROM variant v JOIN product p ON p.id = v.product_id
              WHERE v.id = $1`,
            [line.variantId],
          );
          if (!rows[0]) throw new OpsError("BAD_STATE", `variant ${line.variantId} not found`);

          // A serialized variant transfers as named units. Moving quantity alone
          // left `stock_unit.location_id` at the origin while the ledger said
          // the stock was at the destination, so the unit became unsellable at
          // both: the origin had no on_hand stock, and the destination's sale
          // guard rejected it as "at another location".
          if (rows[0].tracking === "serialized") {
            const unitIds = line.stockUnitIds ?? [];
            if (unitIds.length !== line.quantity) {
              throw new OpsError(
                "SERIALIZED_RULE",
                `serialized transfers name each unit: ${line.quantity} expected, ` +
                  `${unitIds.length} given (scan each IMEI)`,
              );
            }
            for (const unitId of unitIds) {
              const unit = await c.query<{ state: string; location_id: string; variant_id: string }>(
                "SELECT state, location_id, variant_id FROM stock_unit WHERE id = $1 FOR UPDATE",
                [unitId],
              );
              const u = unit.rows[0];
              if (!u || u.variant_id !== line.variantId) {
                throw new OpsError("SERIALIZED_RULE", `unit ${unitId} not found for this variant`);
              }
              if (u.state !== "in_stock" || u.location_id !== input.fromLocationId) {
                throw new OpsError(
                  "SERIALIZED_RULE",
                  `unit ${unitId} is ${u.state}` +
                    (u.location_id !== input.fromLocationId ? " at another location" : ""),
                );
              }
              assertTransition(unitId, "in_stock", "in_transit");
              // Location follows the ledger: the quantity is already counted at
              // the destination in `in_transit`, so the unit is too. Neither end
              // can sell it until the destination confirms receipt.
              await c.query(
                `UPDATE stock_unit SET state = 'in_transit', location_id = $2, updated_at = now()
                  WHERE id = $1`,
                [unitId, input.toLocationId],
              );
              await this.inventory.postMovementWith(c, tenantId, {
                id: randomUUID(),
                movementType: "transfer_out",
                variantId: line.variantId,
                stockUnitId: unitId,
                quantity: 1,
                from: { locationId: input.fromLocationId, state: "on_hand" },
                to: { locationId: input.toLocationId, state: "in_transit" },
                actorUserId: userId,
                reference: { type: "transfer", id: transferId },
                occurredAt: new Date(),
              });
            }
            continue;
          }

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

        // Serialized legs land unit by unit, so each unit's own state follows
        // the ledger back to sellable. Derived from the dispatch movements, so
        // the receiver cannot name a unit that was never sent.
        const { rows: movedUnits } = await c.query<{ variant_id: string; stock_unit_id: string }>(
          `SELECT variant_id, stock_unit_id FROM stock_movement
            WHERE reference_type = 'transfer' AND reference_id = $1
              AND movement_type = 'transfer_out' AND stock_unit_id IS NOT NULL`,
          [transferId],
        );
        for (const unit of movedUnits) {
          assertTransition(unit.stock_unit_id, "in_transit", "in_stock");
          await c.query(
            `UPDATE stock_unit SET state = 'in_stock', location_id = $2, updated_at = now()
              WHERE id = $1 AND state = 'in_transit'`,
            [unit.stock_unit_id, head.to_location_id],
          );
          await this.inventory.postMovementWith(c, tenantId, {
            id: randomUUID(),
            movementType: "transfer_in",
            variantId: unit.variant_id,
            stockUnitId: unit.stock_unit_id,
            quantity: 1,
            from: { locationId: head.to_location_id, state: "in_transit" },
            to: { locationId: head.to_location_id, state: "on_hand" },
            actorUserId: userId,
            reference: { type: "transfer", id: transferId },
            occurredAt: new Date(),
          });
        }

        const { rows: moved } = await c.query<{ variant_id: string; quantity: string }>(
          `SELECT variant_id, sum(quantity) AS quantity FROM stock_movement
            WHERE reference_type = 'transfer' AND reference_id = $1
              AND movement_type = 'transfer_out' AND stock_unit_id IS NULL
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

  // ---- ad-hoc stock adjustments (R4.1) -------------------------------------

  /**
   * Step one of two: record what the stock-keeper says happened and why, and
   * park it for a second human. Nothing moves yet.
   *
   * Two-person control (FP-002) mirrors refunds: the requester is written into
   * the approval, `approval`'s CHECK forbids `approved_by = requested_by`, and
   * only owners/managers may decide. The approval carries the reason, variant,
   * quantity and location, and 029's trigger holds the posted movement to
   * exactly those values — so an approved "damage, 2 units" cannot be spent as
   * "theft, 200 units".
   */
  async requestAdjustment(
    tenantId: string,
    actor: { userId: string; roles: string[] },
    input: AdjustmentRequest,
  ): Promise<{ approvalId: string; status: string; reason: AdjustmentReason }> {
    if (!actor.roles.some((r) => ADJUSTER_ROLES.has(r))) {
      throw new OpsError(
        "FORBIDDEN_ROLE",
        "only owners, managers and warehouse staff may adjust stock",
      );
    }
    if (!ADJUSTMENT_REASONS.includes(input.reason)) {
      throw new LedgerError(
        "INVALID_SHAPE",
        `'${input.reason}' is not a stock adjustment reason ` +
          `(one of: ${ADJUSTMENT_REASONS.join(", ")})`,
      );
    }
    // NUMERIC(14,3): a fourth decimal place would be silently rounded by the
    // database, so the approved quantity would stop matching the posted one.
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new LedgerError("INVALID_SHAPE", "adjustment quantity must be a positive number");
    }
    if (Math.round(input.quantity * 1000) !== input.quantity * 1000) {
      throw new LedgerError("INVALID_SHAPE", "adjustment quantity allows at most 3 decimal places");
    }
    const fromState = input.fromState ?? "on_hand";
    if (!ADJUSTMENT_SOURCE_STATES.includes(fromState)) {
      throw new LedgerError(
        "INVALID_SHAPE",
        `stock cannot be adjusted out of '${fromState}'`,
      );
    }
    // `found` credits stock, and MOVEMENT_RULES.adjustment in @omniretail/domain
    // declares a destination bucket forbidden, so the ledger would reject it.
    // Rejected here, at request time, rather than leaving an approval nobody
    // can ever post. Lifting this needs a domain change, not an app one.
    if (INCREASE_REASONS.has(input.reason)) {
      throw new LedgerError(
        "INVALID_SHAPE",
        `reason '${input.reason}' adds stock, which the adjustment movement ` +
          "shape does not allow; post found stock as a cycle count (R4.2)",
      );
    }

    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ tracking: string }>(
        `SELECT p.tracking FROM variant v JOIN product p ON p.id = v.product_id
          WHERE v.id = $1`,
        [input.variantId],
      );
      if (!rows[0]) throw new OpsError("BAD_STATE", `variant ${input.variantId} not found`);
      // A serialized unit leaving stock is a lifecycle change, not just a
      // quantity: in_stock has no legal transition to written_off (it goes via
      // damaged), so the unit and the ledger would disagree. Out of scope here.
      if (rows[0].tracking === "serialized") {
        throw new LedgerError(
          "INVALID_SHAPE",
          "serialized stock is adjusted unit by unit through its own lifecycle, " +
            "not by quantity",
        );
      }

      const approvalId = randomUUID();
      await c.query(
        `INSERT INTO approval (id, tenant_id, kind, requested_by, status, payload, reason)
         VALUES ($1,$2,$3,$4,'pending',$5,$6)`,
        [approvalId, tenantId, APPROVAL_KIND, actor.userId,
         JSON.stringify({
           variantId: input.variantId,
           locationId: input.locationId,
           quantity: input.quantity,
           fromState,
           reason: input.reason,
           note: input.note ?? null,
         }),
         input.reason],
      );
      await this.audit.recordWith(c, tenantId, {
        actorUserId: actor.userId,
        action: "stock_adjustment.requested",
        entityType: "approval",
        entityId: approvalId,
        after: {
          variantId: input.variantId,
          locationId: input.locationId,
          quantity: input.quantity,
          reason: input.reason,
        },
      });
      return { approvalId, status: "pending", reason: input.reason };
    });
  }

  /**
   * Step two: move the stock a manager signed off. The approval is the whole
   * instruction — quantity, variant, location and reason all come from it, so
   * the poster contributes nothing but the act of posting.
   */
  async postAdjustment(
    tenantId: string,
    actor: { userId: string; roles: string[] },
    approvalId: string,
  ): Promise<{
    movementId: string;
    seq: number;
    reason: AdjustmentReason;
    quantity: number;
    variantId: string;
    locationId: string;
  }> {
    if (!actor.roles.some((r) => ADJUSTER_ROLES.has(r))) {
      throw new OpsError(
        "FORBIDDEN_ROLE",
        "only owners, managers and warehouse staff may adjust stock",
      );
    }
    try {
      return await this.db.withTenant(tenantId, async (c) => {
        const found = await c.query<{
          kind: string;
          status: string;
          requested_by: string;
          approved_by: string | null;
          payload: {
            variantId: string;
            locationId: string;
            quantity: number;
            fromState: AdjustmentSourceState;
            reason: AdjustmentReason;
            note: string | null;
          };
        }>(
          `SELECT kind, status, requested_by, approved_by, payload
             FROM approval WHERE id = $1 FOR UPDATE`,
          [approvalId],
        );
        const approval = found.rows[0];
        if (!approval || approval.kind !== APPROVAL_KIND) {
          throw new OpsError(
            "ADJUSTMENT_NOT_APPROVED",
            `no stock adjustment approval ${approvalId}`,
          );
        }
        if (approval.status !== "approved") {
          throw new OpsError(
            "ADJUSTMENT_NOT_APPROVED",
            `adjustment approval ${approvalId} is ${approval.status}`,
          );
        }
        // Both the approval CHECK and RefundService.decide already forbid it;
        // this refuses to *spend* a self-approval that somehow exists.
        if (!approval.approved_by || approval.approved_by === approval.requested_by) {
          throw new OpsError(
            "ADJUSTMENT_NOT_APPROVED",
            `adjustment approval ${approvalId} was not signed off by a second person`,
          );
        }
        // FOR UPDATE above serializes concurrent posts of the same approval;
        // 029's partial unique index is the backstop if this check regresses.
        const spent = await c.query(
          "SELECT 1 FROM stock_movement WHERE approval_id = $1",
          [approvalId],
        );
        if (spent.rowCount) {
          throw new OpsError(
            "ADJUSTMENT_ALREADY_POSTED",
            `adjustment approval ${approvalId} has already been posted`,
          );
        }

        const p = approval.payload;
        const movementId = randomUUID();
        const posted = await this.inventory.postMovementWith(c, tenantId, {
          id: movementId,
          // A write-off is its own movement type in the ledger; every other
          // reason is a plain adjustment.
          movementType: p.reason === "write_off" ? "write_off" : "adjustment",
          variantId: p.variantId,
          quantity: p.quantity,
          from: { locationId: p.locationId, state: p.fromState },
          actorUserId: actor.userId,
          reference: { type: "adjustment", id: approvalId },
          approvalId,
          ...(p.note ? { note: p.note } : {}),
          occurredAt: new Date(),
        });
        await this.audit.recordWith(c, tenantId, {
          actorUserId: actor.userId,
          action: "stock_adjustment.posted",
          entityType: "stock_movement",
          entityId: movementId,
          after: {
            approvalId,
            reason: p.reason,
            quantity: p.quantity,
            variantId: p.variantId,
            locationId: p.locationId,
            approvedBy: approval.approved_by,
          },
        });
        return {
          movementId,
          seq: posted.seq,
          reason: p.reason,
          quantity: p.quantity,
          variantId: p.variantId,
          locationId: p.locationId,
        };
      });
    } catch (err) {
      throw translatePgError(err);
    }
  }
}
