import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { PgInventoryService, translatePgError } from "../inventory/pgInventory.js";

export class RefundError extends Error {
  constructor(
    readonly code:
      | "ORDER_NOT_FOUND"
      | "AMOUNT_EXCEEDS_ORDER"
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
  ) {}

  async requestRefund(
    tenantId: string,
    actorUserId: string,
    orderId: string,
    input: { amountMinor: number; reason: string; method: "cash" | "card"; restock?: RestockLine[] },
  ): Promise<{ refundId: string; approvalId: string; status: string }> {
    return this.db.withTenant(tenantId, async (c) => {
      const order = await c.query<{ total_minor: string; refunded: string | null; location_id: string }>(
        `SELECT o.total_minor, o.location_id,
                (SELECT sum(r.amount_minor) FROM refund r
                  WHERE r.order_id = o.id AND r.status IN ('approved','processed')) AS refunded
           FROM sales_order o WHERE o.id = $1`,
        [orderId],
      );
      const head = order.rows[0];
      if (!head) throw new RefundError("ORDER_NOT_FOUND", "order not found");
      const alreadyRefunded = Number(head.refunded ?? 0);
      if (input.amountMinor + alreadyRefunded > Number(head.total_minor)) {
        throw new RefundError(
          "AMOUNT_EXCEEDS_ORDER",
          `refund would exceed order total (already refunded ${alreadyRefunded})`,
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

        if (!approve) {
          await c.query(
            "UPDATE refund SET status = 'rejected' WHERE approval_id = $1",
            [approvalId],
          );
          return { status: "rejected" };
        }

        if (approval.kind === "refund") {
          await this.processRefund(c, tenantId, approver.userId, approvalId, approval.payload);
        }
        return { status: "approved" };
      });
    } catch (err) {
      throw translatePgError(err);
    }
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

    await c.query(
      `INSERT INTO outbox (id, tenant_id, aggregate, event_type, payload)
       VALUES ($1,$2,$3,'refund.approved',$4)`,
      [randomUUID(), tenantId, `order:${payload.orderId}`,
       JSON.stringify({ orderId: payload.orderId, amountMinor: payload.amountMinor })],
    );
  }
}
