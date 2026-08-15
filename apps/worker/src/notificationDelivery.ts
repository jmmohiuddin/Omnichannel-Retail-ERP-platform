import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  TransportError,
  backoffMs,
  classifySmtpFailure,
  type NotificationTransport,
} from "@omniretail/api/notify/transport";
import type { Locale } from "@omniretail/api/notify/templates";

/**
 * Notification delivery job (R13.1).
 *
 * Claims due rows with FOR UPDATE SKIP LOCKED — the same pattern as the outbox
 * relay in relay.ts, and for the same reason: two workers must be able to run
 * without either double-sending a message or blocking on the other.
 *
 * The claim commits BEFORE the network call. That is deliberate and it is the
 * one place this job differs from the relay. The relay can hold its claim open
 * across the publish because a rollback simply replays the event; here a
 * rollback after the mail server has already accepted the message would replay
 * a *delivered email* to a customer. So a claim flips the row to 'sending' and
 * commits; the send happens outside any transaction; the outcome is written in
 * a second transaction. Crashing in that window leaves a row stuck in
 * 'sending', which `reclaimStalled` sweeps back into the queue — at-least-once
 * with a bounded duplicate window, rather than a held transaction that pins a
 * connection for as long as an SMTP server feels like taking.
 *
 * Runs cross-tenant on the `omniretail_worker` role: one shop's queue must not
 * stall another shop's mail. 032 grants exactly the two tables plus INSERT on
 * product_event, with permissive policies — never BYPASSRLS.
 */

interface ClaimedRow {
  id: string;
  tenant_id: string;
  template: string;
  recipient: string;
  locale: Locale;
  subject: string;
  body_text: string;
  body_html: string | null;
  attempts: number;
  max_attempts: number;
  order_id: string | null;
  customer_id: string | null;
}

export interface DeliveryReport {
  claimed: number;
  sent: number;
  failed: number;
  bounced: number;
}

export interface DeliveryOptions {
  batchSize?: number;
  /** Backoff floor; the schedule is base * 2^(attempts-1) with full jitter. */
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Injected in tests to make the backoff schedule deterministic. */
  random?: () => number;
  /** How long a row may sit in 'sending' before it is presumed abandoned. */
  stalledAfterMs?: number;
}

export class NotificationDelivery {
  private readonly batchSize: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly random: (() => number) | undefined;
  private readonly stalledAfterMs: number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly transport: NotificationTransport,
    options: DeliveryOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 20;
    this.backoffBaseMs = options.backoffBaseMs ?? 60_000;
    this.backoffCapMs = options.backoffCapMs ?? 6 * 60 * 60_000;
    this.random = options.random;
    this.stalledAfterMs = options.stalledAfterMs ?? 10 * 60_000;
  }

  /** Deliver one batch. Returns what happened to it. */
  async runOnce(): Promise<DeliveryReport> {
    await this.reclaimStalled();
    const claimed = await this.claim();
    const report: DeliveryReport = { claimed: claimed.length, sent: 0, failed: 0, bounced: 0 };

    for (const row of claimed) {
      const attemptNo = row.attempts + 1;
      try {
        const result = await this.transport.send({
          notificationId: row.id,
          to: row.recipient,
          subject: row.subject,
          bodyText: row.body_text,
          bodyHtml: row.body_html,
          locale: row.locale,
        });
        await this.markSent(row, attemptNo, result.providerRef);
        report.sent++;
      } catch (err) {
        // A TransportError already carries the classification; anything else is
        // a bug in our own code, and a bug is never evidence that a customer's
        // address is bad — retry it.
        const kind =
          err instanceof TransportError
            ? classifySmtpFailure(err.stage, err.code)
            : "transient";
        const message = (err as Error).message ?? String(err);
        if (kind === "permanent") {
          await this.markBounced(row, attemptNo, message);
          report.bounced++;
        } else {
          await this.markFailed(row, attemptNo, message);
          report.failed++;
        }
      }
    }
    return report;
  }

  /**
   * Take a batch. `attempts < max_attempts` is what makes an exhausted row
   * terminal: it stays 'failed' and visible on the Messages screen instead of
   * being retried forever. 'bounced' and 'cancelled' are never claimed at all.
   */
  private async claim(): Promise<ClaimedRow[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<ClaimedRow>(
        `WITH due AS (
           SELECT id FROM notification
            WHERE status IN ('pending','failed')
              AND next_attempt_at <= now()
              AND attempts < max_attempts
            ORDER BY next_attempt_at, id
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE notification n
            SET status = 'sending', updated_at = now()
           FROM due
          WHERE n.id = due.id
        RETURNING n.id, n.tenant_id, n.template, n.recipient, n.locale, n.subject,
                  n.body_text, n.body_html, n.attempts, n.max_attempts,
                  n.order_id, n.customer_id`,
        [this.batchSize],
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

  /**
   * A worker that died mid-send left its rows in 'sending', where nothing will
   * ever look at them again — the due index only covers pending/failed. Sweep
   * them back to 'failed' so the normal backoff path picks them up. The
   * attempt is counted, because it may well have been delivered.
   */
  async reclaimStalled(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE notification
          SET status = 'failed',
              failed_at = now(),
              updated_at = now(),
              last_error = 'delivery worker stopped mid-send; requeued'
        WHERE status = 'sending'
          AND updated_at < now() - ($1::bigint || ' milliseconds')::interval`,
      [this.stalledAfterMs],
    );
    return rowCount ?? 0;
  }

  private async markSent(
    row: ClaimedRow,
    attemptNo: number,
    providerRef: string | undefined,
  ): Promise<void> {
    await this.inTransaction(async (client) => {
      await this.recordAttempt(client, row, attemptNo, "sent", providerRef ?? null, null);
      await client.query(
        `UPDATE notification
            SET status = 'sent', attempts = $2, sent_at = now(),
                last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [row.id, attemptNo],
      );
      // R12.2's post-order funnel: placed → confirmation delivered → tracked.
      // The middle step is only observable here, at the moment the mail server
      // takes the message, so the worker writes it — in the same transaction
      // as the state change, so a delivered confirmation can never be missing
      // its funnel step. Written directly rather than through EventService:
      // apps/worker cannot reach the API's Db class, and this is a single
      // append with no invariants beyond the one CHECK constraint.
      if (row.template === "order_confirmation" && row.order_id) {
        await client.query(
          `INSERT INTO product_event
             (id, tenant_id, name, order_id, customer_id, props)
           VALUES ($1, $2, 'confirmation_delivered', $3, $4, $5::jsonb)`,
          [
            randomUUID(),
            row.tenant_id,
            row.order_id,
            row.customer_id,
            JSON.stringify({ notificationId: row.id, channel: "email" }),
          ],
        );
      }
    });
  }

  private async markFailed(row: ClaimedRow, attemptNo: number, error: string): Promise<void> {
    const delay = backoffMs(attemptNo, {
      baseMs: this.backoffBaseMs,
      capMs: this.backoffCapMs,
      ...(this.random ? { random: this.random } : {}),
    });
    await this.inTransaction(async (client) => {
      await this.recordAttempt(client, row, attemptNo, "failed", null, error);
      await client.query(
        `UPDATE notification
            SET status = 'failed', attempts = $2, failed_at = now(),
                last_error = $3, updated_at = now(),
                next_attempt_at = now() + ($4::bigint || ' milliseconds')::interval
          WHERE id = $1`,
        [row.id, attemptNo, error.slice(0, 2000), delay],
      );
    });
  }

  /**
   * Terminal. No backoff is written because nothing will read it: 'bounced' is
   * outside the claim filter. Retrying a rejected address delivers nothing and
   * damages the sending domain's reputation, which is why the schema separates
   * this from 'failed' at all.
   */
  private async markBounced(row: ClaimedRow, attemptNo: number, error: string): Promise<void> {
    await this.inTransaction(async (client) => {
      await this.recordAttempt(client, row, attemptNo, "bounced", null, error);
      await client.query(
        `UPDATE notification
            SET status = 'bounced', attempts = $2, failed_at = now(),
                last_error = $3, updated_at = now()
          WHERE id = $1`,
        [row.id, attemptNo, error.slice(0, 2000)],
      );
    });
  }

  private async recordAttempt(
    client: pg.PoolClient,
    row: ClaimedRow,
    attemptNo: number,
    outcome: "sent" | "failed" | "bounced",
    providerRef: string | null,
    error: string | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO notification_attempt
         (id, tenant_id, notification_id, attempt_no, outcome, provider_ref, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), row.tenant_id, row.id, attemptNo, outcome, providerRef, error?.slice(0, 2000) ?? null],
    );
  }

  private async inTransaction(fn: (client: pg.PoolClient) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await fn(client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Poll until stopped. Backs off to intervalMs when the queue is drained. */
  async runForever(intervalMs: number, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      let claimed = 0;
      try {
        claimed = (await this.runOnce()).claimed;
      } catch (err) {
        console.error("notification delivery error:", (err as Error).message);
      }
      if (claimed < this.batchSize) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  }
}
