import pg from "pg";

export interface OutboxEvent {
  id: string;
  tenantId: string;
  aggregate: string;
  sequence: number;
  eventType: string;
  payload: unknown;
}

/**
 * Destination for relayed events. BullMQ in production (jobId = event id gives
 * broker-side dedupe); in-memory for tests. Publishers must be idempotent on
 * event id — the relay guarantees at-least-once, not exactly-once.
 */
export interface EventPublisher {
  publish(events: OutboxEvent[]): Promise<void>;
}

export class MemoryPublisher implements EventPublisher {
  readonly published: OutboxEvent[] = [];
  async publish(events: OutboxEvent[]): Promise<void> {
    this.published.push(...events);
  }
}

/**
 * Transactional-outbox relay (ADR-006). Claims a batch of unrelayed rows with
 * FOR UPDATE SKIP LOCKED (safe under multiple relay instances), publishes, and
 * marks them relayed in the same transaction as the claim. A publish failure
 * rolls back the claim, so rows are retried — never lost.
 */
export class OutboxRelay {
  constructor(
    private readonly pool: pg.Pool,
    private readonly publisher: EventPublisher,
    private readonly batchSize = 100,
  ) {}

  /** Relay one batch. Returns how many events were published. */
  async runOnce(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT id, tenant_id, aggregate, sequence, event_type, payload
           FROM outbox
          WHERE relayed_at IS NULL
          ORDER BY sequence
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );
      if (rows.length === 0) {
        await client.query("COMMIT");
        return 0;
      }
      const events: OutboxEvent[] = rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        aggregate: r.aggregate,
        sequence: Number(r.sequence),
        eventType: r.event_type,
        payload: r.payload,
      }));
      await this.publisher.publish(events);
      await client.query(
        "UPDATE outbox SET relayed_at = now() WHERE id = ANY($1)",
        [events.map((e) => e.id)],
      );
      await client.query("COMMIT");
      return events.length;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Poll until stopped. Backs off to intervalMs when the table is drained. */
  async runForever(intervalMs: number, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      let published = 0;
      try {
        published = await this.runOnce();
      } catch (err) {
        console.error("outbox relay error:", (err as Error).message);
      }
      if (published < this.batchSize) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  }
}
