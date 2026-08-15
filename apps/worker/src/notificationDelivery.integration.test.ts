/**
 * Notification delivery against real PostgreSQL (R13.1).
 *
 * The job connects as `omniretail_worker`, so this also proves the grants and
 * permissive policies added in 032 are sufficient and no wider than they need
 * to be — the same arrangement relay.integration.test.ts checks for the outbox.
 *
 * What is being proven: a delivered message becomes 'sent' with an attempt row
 * and its funnel event; a permanently rejected address becomes 'bounced' and
 * is never claimed again; a transient failure becomes 'failed', is scheduled
 * into the future, and succeeds on a later attempt; and concurrent workers
 * never send the same message twice.
 *
 * Requires ADMIN_DATABASE_URL; skipped without it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "@omniretail/db";
import { MemoryTransport, TransportError } from "@omniretail/api/notify/transport";
import { NotificationDelivery } from "./notificationDelivery.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const run = Boolean(ADMIN_URL);

const workerUrl = (adminUrl: string): string => {
  const u = new URL(adminUrl);
  u.username = "omniretail_worker";
  u.password = "omniretail_worker_dev";
  return u.toString();
};

describe.skipIf(!run)("NotificationDelivery", () => {
  let admin: pg.Pool;
  let worker: pg.Pool;
  let transport: MemoryTransport;
  let delivery: NotificationDelivery;
  const tenantId = randomUUID();
  const customerId = randomUUID();
  let orderId = "";

  /** Queue a message. Returns its id. */
  const enqueue = async (over: Partial<{
    template: string;
    recipient: string;
    orderId: string | null;
    status: string;
    attempts: number;
    maxAttempts: number;
  }> = {}): Promise<string> => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO notification
         (id, tenant_id, template, channel, recipient, locale, subject, body_text,
          body_html, order_id, customer_id, dedupe_key, status, attempts, max_attempts)
       VALUES ($1,$2,$3,'email',$4,'en','Order confirmed','Hello, your order is confirmed.',
               '<p>Hello</p>',$5,$6,$7,$8,$9,$10)`,
      [
        id,
        tenantId,
        over.template ?? "order_confirmation",
        over.recipient ?? `shopper-${id.slice(0, 8)}@example.ae`,
        over.orderId === null ? null : over.orderId ?? orderId,
        customerId,
        `test:${id}`,
        over.status ?? "pending",
        over.attempts ?? 0,
        over.maxAttempts ?? 5,
      ],
    );
    return id;
  };

  const readRow = async (id: string) => {
    const { rows } = await admin.query<{
      status: string;
      attempts: number;
      last_error: string | null;
      sent_at: Date | null;
      failed_at: Date | null;
      next_attempt_at: Date;
    }>(
      `SELECT status, attempts, last_error, sent_at, failed_at, next_attempt_at
         FROM notification WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  };

  const attemptsFor = async (id: string) => {
    const { rows } = await admin.query<{
      attempt_no: number; outcome: string; provider_ref: string | null; error: string | null;
    }>(
      `SELECT attempt_no, outcome, provider_ref, error
         FROM notification_attempt WHERE notification_id = $1 ORDER BY attempt_no`,
      [id],
    );
    return rows;
  };

  const funnelEvents = async (order: string) => {
    const { rows } = await admin.query<{ name: string; props: Record<string, unknown> }>(
      "SELECT name, props FROM product_event WHERE order_id = $1 AND name = 'confirmation_delivered'",
      [order],
    );
    return rows;
  };

  /** Make a row due right now, undoing whatever backoff was written. */
  const makeDue = (id: string) =>
    admin.query("UPDATE notification SET next_attempt_at = now() - interval '1 minute' WHERE id = $1", [id]);

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    admin = new pg.Pool({ connectionString: ADMIN_URL!, max: 4 });
    worker = new pg.Pool({ connectionString: workerUrl(ADMIN_URL!), max: 4 });

    await admin.query(
      "INSERT INTO tenant (id, name, slug) VALUES ($1,'Delivery Test',$2)",
      [tenantId, `delivery-${tenantId.slice(0, 8)}`],
    );
    const channelId = randomUUID();
    await admin.query(
      "INSERT INTO channel (id, tenant_id, kind, name) VALUES ($1,$2,'web','Web')",
      [channelId, tenantId],
    );
    await admin.query(
      "INSERT INTO customer (id, tenant_id, full_name, email) VALUES ($1,$2,'Delivery Buyer',$3)",
      [customerId, tenantId, `buyer-${tenantId.slice(0, 8)}@example.ae`],
    );
    orderId = randomUUID();
    await admin.query(
      `INSERT INTO sales_order (id, tenant_id, order_no, channel_id, customer_id, currency, total_minor)
       VALUES ($1,$2,$3,$4,$5,'AED',10000)`,
      [orderId, tenantId, `DEL-${tenantId.slice(0, 6)}`, channelId, customerId],
    );

    // The delivery job is deliberately cross-tenant, so sibling suites sharing
    // this database would otherwise make batch assertions here non-deterministic.
    // Park their queued rows instead of cancelling them — their status is what
    // those suites assert on, and it must survive untouched.
    await admin.query(
      `UPDATE notification SET next_attempt_at = now() + interval '1 day'
        WHERE tenant_id <> $1 AND status IN ('pending','failed')`,
      [tenantId],
    );

    transport = new MemoryTransport();
    delivery = new NotificationDelivery(worker, transport, {
      batchSize: 10,
      backoffBaseMs: 60_000,
      random: () => 1, // no jitter: the schedule is assertable
    });
  }, 30_000);

  afterAll(async () => {
    await admin?.end();
    await worker?.end();
  });

  it("delivers a pending message and records the attempt", async () => {
    const id = await enqueue();
    const report = await delivery.runOnce();
    expect(report.sent).toBeGreaterThanOrEqual(1);

    const row = await readRow(id);
    expect(row.status).toBe("sent");
    expect(row.attempts).toBe(1);
    expect(row.sent_at).not.toBeNull();
    expect(row.last_error).toBeNull();

    const attempts = await attemptsFor(id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt_no: 1, outcome: "sent" });
    expect(attempts[0]!.provider_ref).toContain("memory:");

    // The message the transport actually saw carries the stored content.
    const delivered = transport.sent.find((m) => m.notificationId === id);
    expect(delivered).toBeTruthy();
    expect(delivered!.subject).toBe("Order confirmed");
    expect(delivered!.bodyHtml).toBe("<p>Hello</p>");
  });

  it("records the confirmation_delivered funnel step (R12.2)", async () => {
    const before = (await funnelEvents(orderId)).length;
    await enqueue();
    await delivery.runOnce();
    const after = await funnelEvents(orderId);
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)!.props).toMatchObject({ channel: "email" });
  });

  it("does not record a funnel step for a non-confirmation template", async () => {
    const before = (await funnelEvents(orderId)).length;
    const id = await enqueue({ template: "dispatch_tracking" });
    await delivery.runOnce();
    expect((await readRow(id)).status).toBe("sent");
    expect((await funnelEvents(orderId)).length).toBe(before);
  });

  it("marks a permanently rejected address bounced and never retries it", async () => {
    const recipient = "no-such-user@example.ae";
    transport.failFor(
      recipient,
      new TransportError("permanent", "rcpt_to", 550, "550 5.1.1 user unknown"),
    );
    const id = await enqueue({ recipient });

    await delivery.runOnce();
    const row = await readRow(id);
    expect(row.status).toBe("bounced");
    expect(row.attempts).toBe(1);
    expect(row.failed_at).not.toBeNull();
    expect(row.last_error).toContain("550");
    expect(await attemptsFor(id)).toEqual([
      expect.objectContaining({ attempt_no: 1, outcome: "bounced" }),
    ]);

    // The point of 'bounced': even made due, it is never claimed again.
    await makeDue(id);
    await delivery.runOnce();
    await delivery.runOnce();
    const later = await readRow(id);
    expect(later.status).toBe("bounced");
    expect(later.attempts).toBe(1);
    expect(await attemptsFor(id)).toHaveLength(1);
  });

  it("retries a transient failure with exponential backoff, then succeeds", async () => {
    const recipient = "greylisted@example.ae";
    transport.failFor(
      recipient,
      new TransportError("transient", "rcpt_to", 451, "451 4.7.1 greylisted, try later"),
    );
    const id = await enqueue({ recipient });

    await delivery.runOnce();
    let row = await readRow(id);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("451");
    // random: () => 1 makes the first backoff exactly the 60s base.
    const scheduled = row.next_attempt_at.getTime() - Date.now();
    expect(scheduled).toBeGreaterThan(30_000);
    expect(scheduled).toBeLessThanOrEqual(61_000);

    // Not due yet, so a worker running now must leave it alone.
    await delivery.runOnce();
    expect((await readRow(id)).attempts).toBe(1);

    // Due again, and this time the provider accepts it.
    transport.clearFailure(recipient);
    await makeDue(id);
    await delivery.runOnce();
    row = await readRow(id);
    expect(row.status).toBe("sent");
    expect(row.attempts).toBe(2);
    expect(row.last_error).toBeNull();
    expect(await attemptsFor(id)).toMatchObject([
      { attempt_no: 1, outcome: "failed" },
      { attempt_no: 2, outcome: "sent" },
    ]);
  });

  it("stops retrying once max_attempts is spent", async () => {
    const recipient = "always-down@example.ae";
    transport.failFor(
      recipient,
      new TransportError("transient", "connect", undefined, "connection refused"),
    );
    const id = await enqueue({ recipient, maxAttempts: 2 });

    await delivery.runOnce();
    await makeDue(id);
    await delivery.runOnce();
    expect((await readRow(id)).attempts).toBe(2);

    // Exhausted: it stays 'failed' and visible, and is not claimed again.
    await makeDue(id);
    await delivery.runOnce();
    const row = await readRow(id);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(2);
    expect(await attemptsFor(id)).toHaveLength(2);
  });

  it("treats an unexpected error as transient, never as a bounce", async () => {
    const recipient = "boom@example.ae";
    // Not a TransportError at all — a bug in our own code.
    transport.failFor(recipient, new Error("undefined is not a function") as TransportError);
    const id = await enqueue({ recipient });
    await delivery.runOnce();
    const row = await readRow(id);
    expect(row.status).toBe("failed");
    expect(row.last_error).toContain("undefined is not a function");
    transport.clearFailure(recipient);
  });

  it("never claims a cancelled message", async () => {
    const id = await enqueue({ status: "cancelled" });
    await delivery.runOnce();
    const row = await readRow(id);
    expect(row.status).toBe("cancelled");
    expect(row.attempts).toBe(0);
    expect(await attemptsFor(id)).toHaveLength(0);
  });

  it("requeues a message abandoned mid-send by a dead worker", async () => {
    const id = await enqueue({ status: "pending" });
    await admin.query(
      `UPDATE notification
          SET status = 'sending', updated_at = now() - interval '1 hour'
        WHERE id = $1`,
      [id],
    );
    // A worker with a short patience sees it as abandoned.
    const reaper = new NotificationDelivery(worker, transport, { stalledAfterMs: 60_000 });
    expect(await reaper.reclaimStalled()).toBeGreaterThanOrEqual(1);
    const requeued = await readRow(id);
    expect(requeued.status).toBe("failed");
    expect(requeued.last_error).toContain("mid-send");

    // And it goes out on the next pass.
    await makeDue(id);
    await delivery.runOnce();
    expect((await readRow(id)).status).toBe("sent");
  });

  it("leaves a freshly claimed message alone (the stall window is not a race)", async () => {
    const id = await enqueue();
    await admin.query(
      "UPDATE notification SET status = 'sending', updated_at = now() WHERE id = $1",
      [id],
    );
    await delivery.reclaimStalled();
    expect((await readRow(id)).status).toBe("sending");
    await admin.query("UPDATE notification SET status = 'cancelled' WHERE id = $1", [id]);
  });

  it("two workers running at once never send the same message twice", async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, () => enqueue()));
    const a = new NotificationDelivery(worker, transport, { batchSize: 3 });
    const b = new NotificationDelivery(worker, transport, { batchSize: 3 });

    // Drain from both sides concurrently.
    for (let round = 0; round < 6; round++) {
      await Promise.all([a.runOnce(), b.runOnce()]);
    }

    for (const id of ids) {
      const row = await readRow(id);
      expect(row.status).toBe("sent");
      expect(row.attempts).toBe(1);
      // Exactly one attempt row: no message was delivered twice.
      expect(await attemptsFor(id)).toHaveLength(1);
    }
  }, 30_000);

  it("the attempt log is append-only even for the worker role", async () => {
    const id = await enqueue();
    await delivery.runOnce();
    await expect(
      worker.query("UPDATE notification_attempt SET outcome = 'sent' WHERE notification_id = $1", [id]),
    ).rejects.toThrow();
  });
});
