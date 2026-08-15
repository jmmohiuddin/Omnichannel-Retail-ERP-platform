import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { PgInventoryService, translatePgError } from "../inventory/pgInventory.js";

export class RefundError extends Error {
  constructor(
    readonly code:
      | "ORDER_NOT_FOUND"
      /** Refund would exceed the payments actually captured on the order. */
      | "AMOUNT_EXCEEDS_CAPTURE"
      /** Refund tender was never captured on this order, and is not store credit. */
      | "TENDER_NOT_ON_ORDER"
      | "APPROVAL_NOT_FOUND"
      | "ALREADY_DECIDED"
      | "SELF_APPROVAL"
      | "FORBIDDEN_ROLE",
    message: string,
  ) {
    super(message);
    this.name = "RefundError";
  }
}

export interface RestockLine {
  variantId: string;
  quantity: number;
  stockUnitId?: string;
}

const APPROVER_ROLES = new Set(["owner", "manager"]);

/**
 * Refunds are two-step by design (FP-004): the requester and the approver are
 * different authenticated humans. The approval row's CHECK constraint forbids
 * self-approval even if application code regresses. Processing (money leg +
 * restock movements + order status) happens atomically at approval time.
 */
export class RefundService {
  constructor(
    private readonly db: Db,
    private readonly inventory: PgInventoryService,
    private readonly audit: import("../audit/auditService.js").AuditService,
    private readonly creditNotes: import("../einvoice/creditNoteService.js").CreditNoteService,
  ) {}

  async requestRefund(
    tenantId: string,
    actorUserId: string,
    orderId: string,
    input: {
      amountMinor: number;
      reason: string;
      /** Must be a tender captured on the order, or `store_credit` (R6.4). */
      method: "cash" | "card" | "store_credit";
      restock?: RestockLine[];
    },
  ): Promise<{ refundId: string; approvalId: string; status: string }> {
    return this.db.withTenant(tenantId, async (c) => {
      // `FOR UPDATE` serialises concurrent refund requests on this order, so two
      // requests cannot each read the same outstanding total and both pass.
      // The 026 trigger enforces the same invariant regardless; this exists to
      // fail with a message a human can act on rather than a raw check violation.
      const order = await c.query<{
        location_id: string;
        captured: string | null;
        outstanding: string | null;
        methods: string[] | null;
      }>(
        `SELECT o.location_id,
                (SELECT sum(p.amount_minor) FROM payment p
                  WHERE p.order_id = o.id AND p.status = 'captured'
                    AND p.amount_minor > 0)                          AS captured,
                (SELECT sum(r.amount_minor) FROM refund r
                  WHERE r.order_id = o.id AND r.status <> 'rejected') AS outstanding,
                (SELECT array_agg(DISTINCT p.method) FROM payment p
                  WHERE p.order_id = o.id AND p.status = 'captured'
                    AND p.amount_minor > 0)                          AS methods
           FROM sales_order o WHERE o.id = $1
           FOR UPDATE OF o`,
        [orderId],
      );
      const head = order.rows[0];
      if (!head) throw new RefundError("ORDER_NOT_FOUND", "order not found");

      // Against money actually taken, not money merely ordered. An unpaid order
      // has nothing to refund.
      const captured = Number(head.captured ?? 0);
      const outstanding = Number(head.outstanding ?? 0);
      if (input.amountMinor + outstanding > captured) {
        throw new RefundError(
          "AMOUNT_EXCEEDS_CAPTURE",
          `refund would exceed captured payments (captured ${captured}, ` +
            `already claimed ${outstanding}, requested ${input.amountMinor})`,
        );
      }

      // R6.4: refund to the original tender. Store credit is the sanctioned
      // fallback when the original tender cannot be reversed; anything else
      // would let a card sale be paid out of the drawer as cash.
      const capturedMethods = head.methods ?? [];
      if (input.method !== "store_credit" && !capturedMethods.includes(input.method)) {
        throw new RefundError(
          "TENDER_NOT_ON_ORDER",
          `cannot refund by ${input.method}: the order was paid by ` +
            `${capturedMethods.join(", ") || "no captured tender"}`,
        );
      }

      const approvalId = randomUUID();
      await c.query(
        `INSERT INTO approval (id, tenant_id, kind, requested_by, status, payload, reason)
         VALUES ($1,$2,'refund',$3,'pending',$4,$5)`,
        [approvalId, tenantId, actorUserId,
         JSON.stringify({
           orderId,
           amountMinor: input.amountMinor,
           method: input.method,
           locationId: head.location_id,
           restock: input.restock ?? [],
         }),
         input.reason],
      );
      const refundId = randomUUID();
      await c.query(
        `INSERT INTO refund (id, tenant_id, order_id, amount_minor, reason, requested_by,
                             approval_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')`,
        [refundId, tenantId, orderId, input.amountMinor, input.reason, actorUserId, approvalId],
      );
      return { refundId, approvalId, status: "pending" };
    });
  }

  async listPendingApprovals(tenantId: string): Promise<unknown[]> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query(
        `SELECT a.id, a.kind, a.reason, a.payload, a.requested_at,
                u.full_name AS "requestedBy"
           FROM approval a JOIN app_user u ON u.id = a.requested_by
          WHERE a.status = 'pending' ORDER BY a.requested_at`,
      );
      return rows;
    });
  }

  async decide(
    tenantId: string,
    approver: { userId: string; roles: string[] },
    approvalId: string,
    approve: boolean,
  ): Promise<{ status: string }> {
    if (!approver.roles.some((r) => APPROVER_ROLES.has(r))) {
      throw new RefundError("FORBIDDEN_ROLE", "only managers and owners may decide approvals");
    }
    try {
      return await this.db.withTenant(tenantId, async (c) => {
        const found = await c.query<{
          kind: string; status: string; requested_by: string; payload: {
            orderId: string; amountMinor: number; method: string; locationId: string;
            restock: RestockLine[];
          };
        }>(
          "SELECT kind, status, requested_by, payload FROM approval WHERE id = $1 FOR UPDATE",
          [approvalId],
        );
        const approval = found.rows[0];
        if (!approval) throw new RefundError("APPROVAL_NOT_FOUND", "approval not found");
        if (approval.status !== "pending") {
          throw new RefundError("ALREADY_DECIDED", `approval is ${approval.status}`);
        }
        if (approval.requested_by === approver.userId) {
          // The DB CHECK would reject this too; fail with a clear message first.
          throw new RefundError("SELF_APPROVAL", "requester cannot approve their own request");
        }

        await c.query(
          `UPDATE approval SET status = $2, approved_by = $3, decided_at = now()
            WHERE id = $1`,
          [approvalId, approve ? "approved" : "rejected", approver.userId],
        );
        await this.audit.recordWith(c, tenantId, {
          actorUserId: approver.userId,
          action: "approval.decided",
          entityType: "approval",
          entityId: approvalId,
          after: { approve, kind: approval.kind, requestedBy: approval.requested_by },
        });

        if (!approve) {
          await c.query(
            "UPDATE refund SET status = 'rejected' WHERE approval_id = $1",
            [approvalId],
          );
          return { status: "rejected" };
        }

        if (approval.kind === "refund") {
          await this.processRefund(c, tenantId, approver.userId, approvalId, approval.payload);
        } else if (approval.kind === "stock_count") {
          await this.processStockCount(
            c, tenantId, approver.userId, approvalId,
            approval.payload as unknown as {
              countId: string; locationId: string;
              variances: { variantId: string; delta: number }[];
            },
          );
        }
        return { status: "approved" };
      });
    } catch (err) {
      throw translatePgError(err);
    }
  }

  /** Approved cycle-count variance → approval-stamped ledger corrections. */
  private async processStockCount(
    c: import("pg").PoolClient,
    tenantId: string,
    approverUserId: string,
    approvalId: string,
    payload: { countId: string; locationId: string; variances: { variantId: string; delta: number }[] },
  ): Promise<void> {
    for (const v of payload.variances) {
      const bucket = { locationId: payload.locationId, state: "on_hand" as const };
      await this.inventory.postMovementWith(c, tenantId, {
        id: randomUUID(),
        movementType: "count_correction",
        variantId: v.variantId,
        quantity: Math.abs(v.delta),
        ...(v.delta > 0 ? { to: bucket } : { from: bucket }),
        actorUserId: approverUserId,
        reference: { type: "count", id: payload.countId },
        approvalId,
        occurredAt: new Date(),
      });
    }
    await c.query(
      "UPDATE stock_count SET status = 'posted', posted_at = now() WHERE id = $1",
      [payload.countId],
    );
  }

  private async processRefund(
    c: import("pg").PoolClient,
    tenantId: string,
    approverUserId: string,
    approvalId: string,
    payload: { orderId: string; amountMinor: number; method: string; locationId: string; restock: RestockLine[] },
  ): Promise<void> {
    await c.query(
      "UPDATE refund SET status = 'processed', processed_at = now() WHERE approval_id = $1",
      [approvalId],
    );
    // Money leg: negative payment row against the order.
    await c.query(
      `INSERT INTO payment (id, tenant_id, order_id, method, amount_minor, currency,
                            status, received_by)
       SELECT $1, $2, o.id, $3, $4, o.currency, 'refunded', $5
         FROM sales_order o WHERE o.id = $6`,
      [randomUUID(), tenantId, payload.method, -payload.amountMinor, approverUserId, payload.orderId],
    );

    // Stock legs: returned goods re-enter the ledger under the same approval.
    for (const line of payload.restock) {
      const serialized = Boolean(line.stockUnitId);
      if (serialized) {
        await c.query(
          `UPDATE stock_unit SET state = 'returned_pending', updated_at = now()
            WHERE id = $1 AND state = 'sold'`,
          [line.stockUnitId],
        );
      }
      await this.inventory.postMovementWith(c, tenantId, {
        id: randomUUID(),
        movementType: "return_in",
        variantId: line.variantId,
        ...(line.stockUnitId ? { stockUnitId: line.stockUnitId } : {}),
        quantity: line.quantity,
        to: {
          locationId: payload.locationId,
          state: serialized ? "returned_pending" : "on_hand",
        },
        actorUserId: approverUserId,
        reference: { type: "refund", id: approvalId },
        approvalId,
        occurredAt: new Date(),
      });
    }

    // Order status reflects cumulative refunds.
    await c.query(
      `UPDATE sales_order o SET status = CASE
         WHEN (SELECT coalesce(sum(r.amount_minor),0) FROM refund r
                WHERE r.order_id = o.id AND r.status = 'processed') >= o.total_minor
         THEN 'refunded' ELSE 'partially_refunded' END
       WHERE o.id = $1`,
      [payload.orderId],
    );

    // The tax leg (R7.8). A refund reverses money and stock; only a credit
    // note reverses the OUTPUT VAT. Issued in this same transaction so the
    // two can never diverge — a refund that committed without its credit note
    // would leave VAT collected on a sale that was given back, with nothing
    // in the system to notice.
    //
    // Lines are taken from the restock list where present so the credit
    // mirrors the goods actually returned. A money-only refund (goodwill, a
    // price correction) credits the invoice as a whole.
    const { rows: refundRow } = await c.query<{ id: string }>(
      "SELECT id FROM refund WHERE approval_id = $1",
      [approvalId],
    );
    const creditLines = await this.creditNoteLinesFor(c, payload.orderId, payload.restock);
    await this.creditNotes.issueWith(c, tenantId, approverUserId, {
      orderId: payload.orderId,
      reason: `refund ${approvalId}`,
      ...(refundRow[0]?.id ? { refundId: refundRow[0].id } : {}),
      ...(creditLines.length > 0 ? { lines: creditLines } : {}),
    });

    await c.query(
      `INSERT INTO outbox (id, tenant_id, aggregate, event_type, payload)
       VALUES ($1,$2,$3,'refund.approved',$4)`,
      [randomUUID(), tenantId, `order:${payload.orderId}`,
       JSON.stringify({ orderId: payload.orderId, amountMinor: payload.amountMinor })],
    );
  }

  /**
   * Map restocked goods back to the invoice lines they came from, so the
   * credit note credits the same lines — and therefore inherits the same tax
   * category and rate — rather than crediting the invoice generically.
   */
  private async creditNoteLinesFor(
    c: import("pg").PoolClient,
    orderId: string,
    restock: RestockLine[],
  ): Promise<Array<{ orderLineId: string; quantity: number }>> {
    if (restock.length === 0) return [];
    const { rows } = await c.query<{ id: string; variant_id: string; stock_unit_id: string | null }>(
      "SELECT id, variant_id, stock_unit_id FROM sales_order_line WHERE order_id = $1",
      [orderId],
    );
    const out: Array<{ orderLineId: string; quantity: number }> = [];
    const used = new Set<string>();
    for (const line of restock) {
      // A serialized return names its exact unit, so match on that first; a
      // non-serialized return matches the first unused line for its variant.
      const match =
        (line.stockUnitId && rows.find((r) => r.stock_unit_id === line.stockUnitId)) ||
        rows.find((r) => r.variant_id === line.variantId && !used.has(r.id));
      if (!match) continue;
      used.add(match.id);
      out.push({ orderLineId: match.id, quantity: line.quantity });
    }
    return out;
  }
}
