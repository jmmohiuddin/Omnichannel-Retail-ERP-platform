import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import {
  type GatewayWebhookEvent,
  type PaymentGatewayPort,
} from "./gatewayPort.js";

export class PaymentError extends Error {
  constructor(
    readonly code:
      | "ORDER_NOT_FOUND"
      | "BAD_STATE"
      | "UNKNOWN_GATEWAY"
      | "INTENT_EXISTS",
    message: string,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

/**
 * Payment capture over the gateway port. State machine:
 *   order pending → intent created → webhook payment.succeeded →
 *   payment captured + order confirmed (reservation stands, ready to pick).
 * Webhooks are verified against the RAW body and deduplicated by the
 * gateway's delivery id, so at-least-once delivery is safe.
 */
export class PaymentService {
  constructor(
    private readonly db: Db,
    private readonly gateways: Map<string, PaymentGatewayPort>,
  ) {}

  gateway(key: string): PaymentGatewayPort {
    const g = this.gateways.get(key);
    if (!g) throw new PaymentError("UNKNOWN_GATEWAY", `no gateway '${key}' configured`);
    return g;
  }

  async createIntent(
    tenantId: string,
    orderId: string,
    gatewayKey: string,
    /**
     * R5.5: a COD order charges only its advance up front, not the whole
     * total. Defaulting to the order total keeps every existing caller — and
     * every gateway order — behaving exactly as before.
     */
    options: { amountMinor?: number } = {},
  ): Promise<{ intentId: string; gatewayRef: string; redirectUrl?: string }> {
    const gateway = this.gateway(gatewayKey);
    return this.db.withTenant(tenantId, async (c) => {
      const order = await c.query<{
        order_no: string; status: string; total_minor: string; currency: string;
      }>(
        "SELECT order_no, status, total_minor, currency FROM sales_order WHERE id = $1 FOR UPDATE",
        [orderId],
      );
      const head = order.rows[0];
      if (!head) throw new PaymentError("ORDER_NOT_FOUND", "order not found");
      if (head.status !== "pending") {
        throw new PaymentError("BAD_STATE", `order is ${head.status}`);
      }

      // What this intent charges. A COD order collects only its advance now
      // (R5.5); everything else charges the order in full, as before.
      const chargeMinor = options.amountMinor ?? Number(head.total_minor);
      if (chargeMinor <= 0 || chargeMinor > Number(head.total_minor)) {
        throw new PaymentError(
          "BAD_STATE",
          `cannot charge ${chargeMinor} against an order totalling ${head.total_minor}`,
        );
      }

      const intent = await gateway.createIntent({
        orderId,
        orderNo: head.order_no,
        amountMinor: chargeMinor,
        currency: head.currency,
      });
      const intentId = randomUUID();
      try {
        await c.query(
          `INSERT INTO payment_intent
             (id, tenant_id, order_id, gateway, gateway_ref, amount_minor, currency,
              status, redirect_url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'created',$8)`,
          [intentId, tenantId, orderId, gateway.key, intent.gatewayRef,
           chargeMinor, head.currency, intent.redirectUrl ?? null],
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new PaymentError("INTENT_EXISTS", "order already has a live payment intent");
        }
        throw err;
      }
      return {
        intentId,
        gatewayRef: intent.gatewayRef,
        ...(intent.redirectUrl ? { redirectUrl: intent.redirectUrl } : {}),
      };
    });
  }

  /**
   * Handle a verified webhook event. Returns what happened; a replayed
   * delivery returns { duplicate: true } and changes nothing.
   */
  async applyWebhook(
    gatewayKey: string,
    event: GatewayWebhookEvent,
    rawBody: string,
  ): Promise<{ duplicate?: boolean; orderId?: string; result?: string }> {
    // Resolve the intent FIRST. The webhook names no tenant, so this SELECT
    // opts into the transaction-local webhook_lookup policy (016) — the intent
    // row is what resolves gateway_ref → tenant. Read-only, so it is safe to
    // repeat on a retry.
    const found = await this.db.withPlatform(async (c) => {
      await c.query("SELECT set_config('app.webhook_lookup', 'on', true)");
      return c.query<{ id: string; tenant_id: string; order_id: string; status: string }>(
        `SELECT id, tenant_id, order_id, status FROM payment_intent
          WHERE gateway = $1 AND gateway_ref = $2`,
        [gatewayKey, event.gatewayRef],
      );
    });
    const intent = found.rows[0];
    if (!intent) {
      // Deliberately NOT recorded as delivered. A webhook can outrun the
      // transaction that creates its intent; marking it done here would make
      // the gateway's retry a no-op and strand the payment forever. Retrying
      // an unknown event is cheap; losing a captured one is not.
      return { result: "intent_not_found" };
    }

    // Dedupe and effect in ONE transaction. Previously the dedupe row was
    // committed in its own transaction before the effect ran in another, so a
    // failure in between left the delivery marked processed and the payment
    // never applied — the gateway's retry then returned `duplicate: true` and
    // the money was silently lost. Rolling back now discards both together.
    return this.db.withTenant(intent.tenant_id, async (c) => {
      // Take the intent's row lock BEFORE the dedupe insert, and re-read the
      // status from inside this transaction. The status above was read in a
      // different (already committed) transaction, so it is only a hint.
      //
      // That was harmless while webhooks were the sole caller — the dedupe key
      // serialized retries of one delivery. The reconciler (R6.2) makes it
      // reachable: it applies the same effect under a DIFFERENT idempotency key,
      // so a reconciler run racing the webhook it was compensating for would see
      // two callers both read 'created', both pass the dedupe insert, and both
      // run the effect. The UPDATEs below are guarded by their own status
      // predicates, but the outbox INSERT is not — the order would be published
      // as paid twice. The lock makes the loser observe 'succeeded' and stop.
      const locked = await c.query<{ status: string }>(
        "SELECT status FROM payment_intent WHERE id = $1 FOR UPDATE",
        [intent.id],
      );
      const status = locked.rows[0]?.status ?? intent.status;

      const inserted = await c.query(
        `INSERT INTO webhook_delivery (gateway, external_id, payload)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [gatewayKey, event.externalId, rawBody],
      );
      if (inserted.rowCount === 0) return { duplicate: true };

      if (status === "succeeded" || status === "failed") {
        return { orderId: intent.order_id, result: "already_final" };
      }
      if (event.type === "payment.failed") {
        await c.query(
          "UPDATE payment_intent SET status = 'failed', updated_at = now() WHERE id = $1",
          [intent.id],
        );
        return { orderId: intent.order_id, result: "failed" };
      }

      await c.query(
        "UPDATE payment_intent SET status = 'succeeded', updated_at = now() WHERE id = $1",
        [intent.id],
      );
      await c.query(
        `UPDATE payment SET status = 'captured', gateway = $2, gateway_ref = $3
          WHERE order_id = $1 AND method = 'gateway' AND status = 'pending'`,
        [intent.order_id, gatewayKey, event.gatewayRef],
      );
      // R5.5: credit a COD advance BEFORE the status moves. The constraint
      // `sales_order_cod_advance_collected` (migration 035) rejects a
      // confirmed COD order whose advance is still unpaid, so confirming
      // first would fail on the constraint rather than pass through the gate.
      // Summed from captured rows rather than incremented, so a replay or a
      // reconciler run that lands twice cannot inflate the figure.
      await c.query(
        `UPDATE sales_order o
            SET cod_advance_paid_minor = (
                  SELECT coalesce(sum(p.amount_minor), 0) FROM payment p
                   WHERE p.order_id = o.id AND p.purpose = 'cod_advance'
                     AND p.status = 'captured')
          WHERE o.id = $1 AND o.payment_method = 'cod'`,
        [intent.order_id],
      );
      await c.query(
        "UPDATE sales_order SET status = 'confirmed' WHERE id = $1 AND status = 'pending'",
        [intent.order_id],
      );
      await c.query(
        `INSERT INTO outbox (id, tenant_id, aggregate, event_type, payload)
         VALUES ($1,$2,$3,'order.paid',$4)`,
        [randomUUID(), intent.tenant_id, `order:${intent.order_id}`,
         JSON.stringify({ orderId: intent.order_id, gateway: gatewayKey })],
      );
      return { orderId: intent.order_id, result: "captured" };
    });
  }
}
