import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { PaymentService } from "@omniretail/api/payments";
import type { GatewayPaymentStatus } from "@omniretail/api/payments/gateway";

/** Why an intent could not be repaired. Mirrors the CHECK on the table. */
export type ExceptionReason =
  | "gateway_failed"
  | "gateway_unknown"
  | "amount_mismatch"
  | "currency_mismatch"
  | "no_status_api"
  | "apply_failed";

export interface ReconciliationException {
  tenantId: string;
  intentId: string;
  orderId: string;
  gateway: string;
  gatewayRef: string;
  reason: ExceptionReason;
  detail: Record<string, unknown>;
}

/**
 * Where un-repairable intents are recorded. Inverted so the job's decisions can
 * be tested without the reporting table, and so a future sink (pager, ticket)
 * is a constructor argument rather than a rewrite.
 */
export interface ExceptionSink {
  flag(exception: ReconciliationException): Promise<void>;
  /** An intent that was previously flagged has reached a good terminal state. */
  resolve(tenantId: string, intentId: string): Promise<void>;
}

export interface ReconcileOutcome {
  intentId: string;
  orderId: string;
  gateway: string;
  gatewayRef: string;
  action:
    /** Repaired: the payment the webhook never told us about is now captured. */
    | "captured"
    /** Repaired: the gateway says it failed, so the intent is closed as failed. */
    | "failed"
    /** A webhook (or another reconciler) got there first. */
    | "already_final"
    /** This exact reconciliation was already applied — same idempotency key. */
    | "duplicate"
    /** Not repairable; recorded for a human. */
    | "flagged"
    /** Nothing to do yet: the gateway is still working, or it did not answer. */
    | "left_alone";
  reason?: string;
  /**
   * An exception was filed for this intent. Set even when the action was a
   * repair: a gateway-declined payment is both closed and reported.
   */
  recorded?: ExceptionReason;
}

export interface ReconcileSummary {
  examined: number;
  repaired: number;
  flagged: number;
  outcomes: ReconcileOutcome[];
}

export interface ReconcileOptions {
  /**
   * How old a non-terminal intent must be before we treat its webhook as lost.
   * Long enough that a merely-slow gateway is not mistaken for a dropped
   * delivery; 3-D Secure and Tabby approvals routinely take minutes.
   */
  staleAfterSeconds?: number;
  limit?: number;
}

interface StuckIntent {
  id: string;
  tenant_id: string;
  order_id: string;
  gateway: string;
  gateway_ref: string;
  amount_minor: string;
  currency: string;
}

/** In-memory sink for tests and dry runs (cf. MemoryPublisher in relay.ts). */
export class MemoryExceptionSink implements ExceptionSink {
  readonly flagged: ReconciliationException[] = [];
  readonly resolved: { tenantId: string; intentId: string }[] = [];

  async flag(exception: ReconciliationException): Promise<void> {
    this.flagged.push(exception);
  }

  async resolve(tenantId: string, intentId: string): Promise<void> {
    this.resolved.push({ tenantId, intentId });
  }
}

/**
 * Durable sink: `payment_reconciliation_exception`, surfaced by
 * GET /v1/reports/exceptions. One open row per (intent, reason) — the job runs
 * on a timer, so a stuck intent must bump a counter rather than file a fresh
 * exception every few minutes and bury the surface it exists to make visible.
 */
export class PgExceptionSink implements ExceptionSink {
  constructor(private readonly pool: pg.Pool) {}

  async flag(e: ReconciliationException): Promise<void> {
    await this.inTenant(e.tenantId, (c) =>
      c.query(
        `INSERT INTO payment_reconciliation_exception
           (id, tenant_id, intent_id, order_id, gateway, gateway_ref, reason, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, intent_id, reason) DO UPDATE
            SET last_seen_at = now(),
                seen_count   = payment_reconciliation_exception.seen_count + 1,
                detail       = EXCLUDED.detail,
                -- Re-observing a problem we had marked resolved reopens it.
                resolved_at  = NULL`,
        [randomUUID(), e.tenantId, e.intentId, e.orderId, e.gateway, e.gatewayRef,
         e.reason, JSON.stringify(e.detail)],
      ),
    );
  }

  async resolve(tenantId: string, intentId: string): Promise<void> {
    await this.inTenant(tenantId, (c) =>
      c.query(
        `UPDATE payment_reconciliation_exception SET resolved_at = now()
          WHERE intent_id = $1 AND resolved_at IS NULL`,
        [intentId],
      ),
    );
  }

  private async inTenant(tenantId: string, fn: (c: pg.PoolClient) => Promise<unknown>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await fn(client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Payment reconciliation (R6.2). Stripe, N-Genius and Tabby all confirm
 * asynchronously, so a dropped webhook leaves an intent stuck in
 * `created`/`processing` while the shopper's money has already moved. This job
 * is the safety net: it polls the gateway for authoritative status and
 * **repairs** what it can, flagging only what it must not decide alone.
 *
 * Two properties make it safe to point at money:
 *
 *  1. It writes no payment state of its own. The repair is applied through
 *     `PaymentService.applyWebhook` — the exact path a real webhook takes.
 *     A second implementation of "apply a payment" is how a repair job
 *     double-spends, so there isn't one.
 *  2. Its idempotency key is derived from (gateway, ref, outcome), not from a
 *     delivery id, so re-running the job replays the same key and the dedupe
 *     row rejects it. Against a *real* webhook — a different key — the intent
 *     row lock inside `applyWebhook` serializes the two and the loser observes
 *     a terminal status and stops.
 *
 * Discovery is a bounded cross-tenant read; every write happens under the
 * tenant GUC and the same RLS policies as the API.
 */
export class PaymentReconciler {
  constructor(
    private readonly pool: pg.Pool,
    private readonly payments: PaymentService,
    private readonly sink: ExceptionSink,
  ) {}

  async runOnce(opts: ReconcileOptions = {}): Promise<ReconcileSummary> {
    const staleAfterSeconds = opts.staleAfterSeconds ?? 15 * 60;
    const limit = opts.limit ?? 100;

    const stuck = await this.findStuck(staleAfterSeconds, limit);
    const summary: ReconcileSummary = {
      examined: stuck.length, repaired: 0, flagged: 0, outcomes: [],
    };

    for (const intent of stuck) {
      const outcome = await this.reconcileOne(intent);
      summary.outcomes.push(outcome);
      if (outcome.action === "captured" || outcome.action === "failed") summary.repaired++;
      if (outcome.action === "flagged" || outcome.recorded) summary.flagged++;
    }

    if (summary.repaired || summary.flagged) {
      console.log(
        `payment reconciler: examined ${summary.examined}, ` +
          `repaired ${summary.repaired}, flagged ${summary.flagged}`,
      );
    }
    return summary;
  }

  /**
   * Non-terminal intents past the staleness threshold, across tenants.
   *
   * Deliberately NOT `FOR UPDATE SKIP LOCKED`. A locking read here would either
   * release the lock at once (autocommit — pure theatre) or be held across the
   * repair, in which case it would deadlock against the `FOR UPDATE` that
   * `applyWebhook` takes on the same row from a different connection. Two
   * reconcilers racing on one intent is instead made harmless by the
   * deterministic idempotency key: both call `applyWebhook` with the same
   * external id, one inserts the dedupe row and the other gets `duplicate`.
   *
   * `app.webhook_lookup` is the same transaction-local flag the webhook handler
   * uses to resolve gateway_ref -> tenant; under the worker role the read is
   * instead permitted by that role's own SELECT-only discovery policy. Setting
   * it makes this query correct under either role.
   */
  private async findStuck(staleAfterSeconds: number, limit: number): Promise<StuckIntent[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.webhook_lookup', 'on', true)");
      const { rows } = await client.query<StuckIntent>(
        `SELECT id, tenant_id, order_id, gateway, gateway_ref, amount_minor, currency
           FROM payment_intent
          WHERE status IN ('created','processing')
            AND created_at < now() - ($1 || ' seconds')::interval
          ORDER BY created_at
          LIMIT $2`,
        [staleAfterSeconds, limit],
      );
      await client.query("COMMIT");
      return rows;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async reconcileOne(intent: StuckIntent): Promise<ReconcileOutcome> {
    const base = {
      intentId: intent.id,
      orderId: intent.order_id,
      gateway: intent.gateway,
      gatewayRef: intent.gateway_ref,
    };

    // A gateway that is not configured here, or has no status API, is a
    // permanent condition — worth an exception. A gateway that is configured
    // but did not answer is not; that is handled below.
    let fetchStatus: (ref: string) => Promise<GatewayPaymentStatus>;
    try {
      const port = this.payments.gateway(intent.gateway);
      if (!port.fetchStatus) {
        return this.flag(intent, "no_status_api", {
          message: `gateway '${intent.gateway}' cannot be polled for status`,
        });
      }
      fetchStatus = port.fetchStatus.bind(port);
    } catch (err) {
      return this.flag(intent, "no_status_api", { message: (err as Error).message });
    }

    let status: GatewayPaymentStatus;
    try {
      status = await fetchStatus(intent.gateway_ref);
    } catch (err) {
      // An unreachable gateway is a transient condition, not an exception to
      // file: flagging here would fill the report with noise during an outage
      // and drown the intents that genuinely need a human. Retry next tick.
      const message = (err as Error).message;
      console.error(`payment reconciler: status poll failed for ${intent.gateway_ref}: ${message}`);
      return { ...base, action: "left_alone", reason: `status_poll_failed: ${message}` };
    }

    switch (status.state) {
      case "pending":
        // The gateway is still working. Not a lost webhook.
        return { ...base, action: "left_alone", reason: "gateway_still_pending" };

      case "unknown":
        return this.flag(intent, "gateway_unknown", { reason: status.reason ?? null });

      case "failed": {
        // Repairable *and* reportable. Closing the intent as failed is the
        // correct terminal state and stops it being polled forever; the flag
        // exists because a shopper who believed they had paid needs follow-up,
        // and because the order is still holding stock until its reservation
        // expires.
        const applied = await this.apply(intent, "payment.failed", status);
        if (applied.action === "flagged") return applied;
        await this.sink
          .flag({
            tenantId: intent.tenant_id,
            intentId: intent.id,
            orderId: intent.order_id,
            gateway: intent.gateway,
            gatewayRef: intent.gateway_ref,
            reason: "gateway_failed",
            detail: { reason: status.reason ?? null },
          })
          .catch((err) =>
            console.error(`payment reconciler: could not flag ${intent.id}: ${(err as Error).message}`),
          );
        return { ...applied, recorded: "gateway_failed" };
      }

      case "succeeded": {
        // The whole point of the amount check: a webhook that never arrived is
        // precisely the case where our record and the gateway's could have
        // diverged. Capturing a total we cannot match is not a repair.
        const expected = BigInt(intent.amount_minor);
        const actual = Number.isInteger(status.amountMinor) ? BigInt(status.amountMinor) : null;
        if (actual === null || actual !== expected) {
          return this.flag(intent, "amount_mismatch", {
            expectedMinor: expected.toString(),
            gatewayMinor: status.amountMinor,
          });
        }
        if (intent.currency.trim().toUpperCase() !== status.currency.trim().toUpperCase()) {
          return this.flag(intent, "currency_mismatch", {
            expected: intent.currency.trim(),
            gateway: status.currency,
          });
        }

        const applied = await this.apply(intent, "payment.succeeded", status);
        if (applied.action === "captured") {
          await this.sink
            .resolve(intent.tenant_id, intent.id)
            .catch((err) =>
              console.error(
                `payment reconciler: could not resolve ${intent.id}: ${(err as Error).message}`,
              ),
            );
        }
        return applied;
      }
    }
  }

  /**
   * Apply the terminal effect through the webhook path.
   *
   * The external id is derived, not random: (gateway, ref, outcome) is stable
   * across runs, so the second attempt at the same repair collides on
   * `webhook_delivery`'s primary key and changes nothing. It deliberately does
   * NOT collide with the gateway's own delivery ids — if the real webhook turns
   * up later it must still be recorded — which is why the intent row lock, not
   * this key, is what stops the two from both applying.
   */
  private async apply(
    intent: StuckIntent,
    type: "payment.succeeded" | "payment.failed",
    status: GatewayPaymentStatus,
  ): Promise<ReconcileOutcome> {
    const base = {
      intentId: intent.id,
      orderId: intent.order_id,
      gateway: intent.gateway,
      gatewayRef: intent.gateway_ref,
    };
    const outcome = type === "payment.succeeded" ? "succeeded" : "failed";
    const externalId = `reconcile:${intent.gateway}:${intent.gateway_ref}:${outcome}`;
    const rawBody = JSON.stringify({
      source: "payment-reconciler",
      gateway: intent.gateway,
      gatewayRef: intent.gateway_ref,
      status,
      observedAt: new Date().toISOString(),
    });

    let result: Awaited<ReturnType<PaymentService["applyWebhook"]>>;
    try {
      result = await this.payments.applyWebhook(
        intent.gateway,
        { externalId, type, gatewayRef: intent.gateway_ref },
        rawBody,
      );
    } catch (err) {
      // The effect rolls back with its dedupe row (see webhookAtomicity), so
      // the next run retries this same key. Flagging makes a persistent
      // failure visible without giving up on the retry.
      return this.flag(intent, "apply_failed", { message: (err as Error).message });
    }

    if (result.duplicate) return { ...base, action: "duplicate" };
    if (result.result === "already_final") return { ...base, action: "already_final" };
    if (result.result === "captured") {
      console.log(
        `payment reconciler: repaired order ${intent.order_id} — ` +
          `gateway ${intent.gateway} ref ${intent.gateway_ref} was paid, webhook never arrived`,
      );
      return { ...base, action: "captured" };
    }
    if (result.result === "failed") return { ...base, action: "failed" };
    return { ...base, action: "left_alone", reason: result.result ?? "unknown" };
  }

  private async flag(
    intent: StuckIntent,
    reason: ExceptionReason,
    detail: Record<string, unknown>,
  ): Promise<ReconcileOutcome> {
    const exception: ReconciliationException = {
      tenantId: intent.tenant_id,
      intentId: intent.id,
      orderId: intent.order_id,
      gateway: intent.gateway,
      gatewayRef: intent.gateway_ref,
      reason,
      detail,
    };
    try {
      await this.sink.flag(exception);
    } catch (err) {
      console.error(
        `payment reconciler: could not record exception for ${intent.id}: ${(err as Error).message}`,
      );
    }
    console.error(
      `payment reconciler: cannot repair order ${intent.order_id} (${reason}): ` +
        JSON.stringify(detail),
    );
    return {
      intentId: intent.id,
      orderId: intent.order_id,
      gateway: intent.gateway,
      gatewayRef: intent.gateway_ref,
      action: "flagged",
      reason,
    };
  }
}
