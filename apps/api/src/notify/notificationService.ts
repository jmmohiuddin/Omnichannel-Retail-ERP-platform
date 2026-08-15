/**
 * The notification outbox: enqueue, read, resend, cancel (R13.1, R13.4).
 *
 * Enqueue is transactional by construction. `enqueueWith` takes the caller's
 * `pg.PoolClient` — the same shape as EventService.recordWith and
 * AuditService — so the confirmation for an order is written in the order's
 * own transaction. An order that commits always has its confirmation queued;
 * an order that rolls back never leaves a message promising a purchase that
 * did not happen. This is not a nicety: the alternative (enqueue after commit)
 * has a window in which the process dies and a paying customer hears nothing,
 * which is precisely the Phase 0 gap this subsystem closes.
 *
 * Content is rendered HERE, at enqueue, and stored on the row. The template is
 * code and code changes; what the customer was told is a fact and must not.
 * Every read path — the Messages screen, a dispute, a resend — reads the
 * stored body, never a re-render.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Db } from "../db.js";
import {
  isLocale,
  recipientKindFor,
  render,
  type Locale,
  type NotificationRequest,
  type TemplateName,
} from "./templates.js";

export type NotificationChannel = "email" | "sms" | "whatsapp";

export type NotificationStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "bounced"
  | "cancelled";

export class NotificationError extends Error {
  constructor(
    readonly code:
      | "NOTIFICATION_NOT_FOUND"
      | "NO_RECIPIENT"
      | "NOT_RESENDABLE"
      | "NOT_CANCELLABLE"
      | "UNSUPPORTED_CHANNEL",
    message: string,
  ) {
    super(message);
    this.name = "NotificationError";
  }
}

export interface EnqueueInput {
  /** Template + its typed payload. */
  request: NotificationRequest;
  /**
   * Idempotency key, unique per tenant. Convention: `<template>:<subject id>`,
   * e.g. `order_confirmation:<orderId>`. Enqueueing twice delivers once.
   */
  dedupeKey: string;
  /** v1 delivers email only; the column models the rest (R13.2). */
  channel?: NotificationChannel;
  /** Explicit address. Falls back to the customer's email. */
  recipient?: string;
  customerId?: string;
  orderId?: string;
  /** Overrides locale resolution. Used by staff templates and by tests. */
  locale?: Locale;
  maxAttempts?: number;
}

export interface EnqueueResult {
  id: string;
  /** False when `dedupeKey` already existed — the caller enqueued a duplicate. */
  created: boolean;
}

export interface NotificationView {
  id: string;
  template: TemplateName;
  channel: NotificationChannel;
  recipientKind: "customer" | "staff";
  recipient: string;
  locale: Locale;
  subject: string;
  status: NotificationStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  sentAt: string | null;
  failedAt: string | null;
  orderId: string | null;
  customerId: string | null;
  dedupeKey: string;
  createdAt: string;
}

export interface NotificationDetail extends NotificationView {
  bodyText: string;
  bodyHtml: string | null;
  payload: unknown;
  attemptLog: {
    attemptNo: number;
    outcome: "sent" | "failed" | "bounced";
    providerRef: string | null;
    error: string | null;
    attemptedAt: string;
  }[];
}

export interface ListFilter {
  status?: NotificationStatus[];
  template?: TemplateName;
  orderId?: string;
  customerId?: string;
  limit?: number;
  offset?: number;
}

const MAX_PAGE = 200;

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export class NotificationService {
  constructor(private readonly db: Db) {}

  /**
   * R13.4's locale rule: what the customer told us, else what the tenant
   * serves by default, else English. A NULL customer.locale is "not stated"
   * and defers to the tenant; an explicit 'en' is the customer's choice and
   * survives a tenant whose default is Arabic.
   */
  async resolveLocaleWith(
    c: pg.PoolClient,
    tenantId: string,
    customerId?: string,
  ): Promise<Locale> {
    const { rows } = await c.query<{ customer_locale: string | null; default_locale: string | null }>(
      `SELECT (SELECT cu.locale FROM customer cu WHERE cu.id = $1) AS customer_locale,
              (SELECT t.default_locale FROM tenant t WHERE t.id = $2) AS default_locale`,
      [customerId ?? null, tenantId],
    );
    const row = rows[0];
    if (row && isLocale(row.customer_locale)) return row.customer_locale;
    if (row && isLocale(row.default_locale)) return row.default_locale;
    return "en";
  }

  /**
   * Enqueue inside the caller's transaction. Idempotent on `dedupeKey`: a
   * retried transaction or a replayed webhook queues one message, not two.
   */
  async enqueueWith(
    c: pg.PoolClient,
    tenantId: string,
    input: EnqueueInput,
  ): Promise<EnqueueResult> {
    const channel = input.channel ?? "email";
    if (channel !== "email") {
      // The column accepts sms/whatsapp so delivery history does not need a
      // migration when those land; no transport implements them yet, and
      // queueing a row nothing can deliver would just look like an outage.
      throw new NotificationError(
        "UNSUPPORTED_CHANNEL",
        `channel '${channel}' has no transport in v1 (email only)`,
      );
    }

    const locale = input.locale ?? (await this.resolveLocaleWith(c, tenantId, input.customerId));
    const recipient = (input.recipient ?? (await this.recipientFor(c, input.customerId)))?.trim();
    if (!recipient) {
      throw new NotificationError(
        "NO_RECIPIENT",
        "no email address for this notification (customer has none and none was supplied)",
      );
    }

    const rendered = render(input.request, locale);
    const id = randomUUID();

    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO notification
         (id, tenant_id, template, channel, recipient_kind, recipient, locale,
          subject, body_text, body_html, order_id, customer_id, dedupe_key,
          payload, max_attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,
               coalesce($15::int, 5))
       ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
       RETURNING id`,
      [
        id,
        tenantId,
        input.request.template,
        channel,
        recipientKindFor(input.request.template),
        recipient,
        locale,
        rendered.subject,
        rendered.bodyText,
        rendered.bodyHtml,
        input.orderId ?? null,
        input.customerId ?? null,
        input.dedupeKey,
        JSON.stringify(input.request.payload),
        input.maxAttempts ?? null,
      ],
    );

    const inserted = rows[0];
    if (inserted) return { id: inserted.id, created: true };

    // Lost the race (or a genuine duplicate): hand back the row that won, so
    // the caller can still correlate. DO NOTHING returns nothing, so re-read.
    const existing = await c.query<{ id: string }>(
      "SELECT id FROM notification WHERE tenant_id = $1 AND dedupe_key = $2",
      [tenantId, input.dedupeKey],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new NotificationError(
        "NOTIFICATION_NOT_FOUND",
        `insert was skipped but no row exists for dedupe key ${input.dedupeKey}`,
      );
    }
    return { id: row.id, created: false };
  }

  /** Standalone enqueue, for callers with nothing to be atomic with. */
  async enqueue(tenantId: string, input: EnqueueInput): Promise<EnqueueResult> {
    return this.db.withTenant(tenantId, (c) => this.enqueueWith(c, tenantId, input));
  }

  private async recipientFor(
    c: pg.PoolClient,
    customerId?: string,
  ): Promise<string | undefined> {
    if (!customerId) return undefined;
    const { rows } = await c.query<{ email: string | null }>(
      "SELECT email FROM customer WHERE id = $1",
      [customerId],
    );
    return rows[0]?.email ?? undefined;
  }

  /** The Messages screen (R13.1: bounces must be visible, not merely logged). */
  async list(tenantId: string, filter: ListFilter = {}): Promise<NotificationView[]> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), MAX_PAGE);
    const offset = Math.max(filter.offset ?? 0, 0);
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<NotificationRow>(
        `SELECT id, template, channel, recipient_kind, recipient, locale, subject,
                status, attempts, max_attempts, next_attempt_at, last_error,
                sent_at, failed_at, order_id, customer_id, dedupe_key, created_at
           FROM notification
          WHERE ($1::text[] IS NULL OR status = ANY($1))
            AND ($2::text IS NULL OR template = $2)
            AND ($3::uuid IS NULL OR order_id = $3)
            AND ($4::uuid IS NULL OR customer_id = $4)
          ORDER BY created_at DESC, id
          LIMIT $5 OFFSET $6`,
        [
          filter.status && filter.status.length > 0 ? filter.status : null,
          filter.template ?? null,
          filter.orderId ?? null,
          filter.customerId ?? null,
          limit,
          offset,
        ],
      );
      return rows.map(toView);
    });
  }

  /** One message with its full attempt history — the "why didn't it arrive" view. */
  async get(tenantId: string, notificationId: string): Promise<NotificationDetail> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<NotificationRow & {
        body_text: string;
        body_html: string | null;
        payload: unknown;
      }>(
        `SELECT id, template, channel, recipient_kind, recipient, locale, subject,
                body_text, body_html, payload, status, attempts, max_attempts,
                next_attempt_at, last_error, sent_at, failed_at, order_id,
                customer_id, dedupe_key, created_at
           FROM notification WHERE id = $1`,
        [notificationId],
      );
      const row = rows[0];
      if (!row) throw new NotificationError("NOTIFICATION_NOT_FOUND", "notification not found");

      const { rows: attempts } = await c.query<{
        attempt_no: number;
        outcome: "sent" | "failed" | "bounced";
        provider_ref: string | null;
        error: string | null;
        attempted_at: Date;
      }>(
        `SELECT attempt_no, outcome, provider_ref, error, attempted_at
           FROM notification_attempt
          WHERE notification_id = $1
          ORDER BY attempt_no`,
        [notificationId],
      );

      return {
        ...toView(row),
        bodyText: row.body_text,
        bodyHtml: row.body_html,
        payload: row.payload,
        attemptLog: attempts.map((a) => ({
          attemptNo: a.attempt_no,
          outcome: a.outcome,
          providerRef: a.provider_ref,
          error: a.error,
          attemptedAt: a.attempted_at.toISOString(),
        })),
      };
    });
  }

  /**
   * Resend as a NEW row, never by resetting the old one.
   *
   * History is the point: "we tried on the 4th, it bounced, we corrected the
   * address and it went out on the 5th" has to stay readable, and rewinding
   * the original row's status would erase the first half of that sentence.
   * The new row carries a derived dedupe key (unique by construction) and a
   * verbatim copy of the stored body — a resend delivers what the customer was
   * originally told, not what today's template would produce.
   *
   * `recipient` may be corrected here, which is the whole remedy for a bounce.
   */
  async resend(
    tenantId: string,
    notificationId: string,
    options: { recipient?: string } = {},
  ): Promise<{ id: string; resentFrom: string }> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ status: NotificationStatus }>(
        "SELECT status FROM notification WHERE id = $1 FOR UPDATE",
        [notificationId],
      );
      const original = rows[0];
      if (!original) {
        throw new NotificationError("NOTIFICATION_NOT_FOUND", "notification not found");
      }
      if (original.status === "pending" || original.status === "sending") {
        throw new NotificationError(
          "NOT_RESENDABLE",
          `notification is ${original.status}; it is already queued for delivery`,
        );
      }

      const newId = randomUUID();
      const { rows: created } = await c.query<{ id: string }>(
        `INSERT INTO notification
           (id, tenant_id, template, channel, recipient_kind, recipient, locale,
            subject, body_text, body_html, order_id, customer_id, dedupe_key,
            payload, max_attempts)
         SELECT $2::uuid, tenant_id, template, channel, recipient_kind,
                coalesce($3::text, recipient), locale, subject, body_text, body_html,
                order_id, customer_id, dedupe_key || '#resend:' || $4::text,
                payload, max_attempts
           FROM notification WHERE id = $1
         RETURNING id`,
        // $2 and $4 are the same id, passed twice: one is consumed as a uuid
        // column and one as text in the dedupe key, and Postgres refuses to
        // deduce two types for one parameter.
        [notificationId, newId, options.recipient?.trim() ?? null, newId],
      );
      const row = created[0];
      if (!row) throw new NotificationError("NOTIFICATION_NOT_FOUND", "notification not found");
      return { id: row.id, resentFrom: notificationId };
    });
  }

  /** Stop a message that has not gone out yet. Sent mail cannot be recalled. */
  async cancel(tenantId: string, notificationId: string): Promise<{ id: string; status: "cancelled" }> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ status: NotificationStatus }>(
        "SELECT status FROM notification WHERE id = $1 FOR UPDATE",
        [notificationId],
      );
      const found = rows[0];
      if (!found) throw new NotificationError("NOTIFICATION_NOT_FOUND", "notification not found");
      if (found.status !== "pending" && found.status !== "failed") {
        throw new NotificationError(
          "NOT_CANCELLABLE",
          `notification is ${found.status}; only pending or failed messages can be cancelled`,
        );
      }
      await c.query(
        "UPDATE notification SET status = 'cancelled', updated_at = now() WHERE id = $1",
        [notificationId],
      );
      return { id: notificationId, status: "cancelled" };
    });
  }
}

interface NotificationRow {
  id: string;
  template: TemplateName;
  channel: NotificationChannel;
  recipient_kind: "customer" | "staff";
  recipient: string;
  locale: Locale;
  subject: string;
  status: NotificationStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  sent_at: Date | null;
  failed_at: Date | null;
  order_id: string | null;
  customer_id: string | null;
  dedupe_key: string;
  created_at: Date;
}

const toView = (row: NotificationRow): NotificationView => ({
  id: row.id,
  template: row.template,
  channel: row.channel,
  recipientKind: row.recipient_kind,
  recipient: row.recipient,
  locale: row.locale,
  subject: row.subject,
  status: row.status,
  attempts: row.attempts,
  maxAttempts: row.max_attempts,
  nextAttemptAt: row.next_attempt_at.toISOString(),
  lastError: row.last_error,
  sentAt: iso(row.sent_at),
  failedAt: iso(row.failed_at),
  orderId: row.order_id,
  customerId: row.customer_id,
  dedupeKey: row.dedupe_key,
  createdAt: row.created_at.toISOString(),
});
