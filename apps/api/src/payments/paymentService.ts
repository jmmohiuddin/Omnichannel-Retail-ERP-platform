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

      const intent = await gateway.createIntent({
        orderId,
        orderNo: head.order_no,
        amountMinor: Number(head.total_minor),
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
           Number(head.total_minor), head.currency, intent.redirectUrl ?? null],
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
    // Dedupe first — platform scope (webhook_delivery carries no tenant).
    const inserted = await this.db.withPlatform((c) =>
      c.query(
        `INSERT INTO webhook_delivery (gateway, external_id, payload)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [gatewayKey, event.externalId, rawBody],
      ),
    );
    if (inserted.rowCount === 0) return { duplicate: true };

    // Find the intent. The webhook names no tenant, so this SELECT opts into
    // the transaction-local webhook_lookup policy (016) — the intent row is
    // what resolves gateway_ref → tenant.
    const found = await this.db.withPlatform(async (c) => {
      await c.query("SELECT set_config('app.webhook_lookup', 'on', true)");
      return c.query<{ id: string; tenant_id: string; order_id: string; status: string }>(
        `SELECT id, tenant_id, order_id, status FROM payment_intent
          WHERE gateway = $1 AND gateway_ref = $2`,
        [gatewayKey, event.gatewayRef],
      );
    });
    const intent = found.rows[0];
    if (!intent) return { result: "intent_not_found" }; // acknowledged; investigated via ops

    return this.db.withTenant(intent.tenant_id, async (c) => {
      if (intent.status === "succeeded" || intent.status === "failed") {
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
