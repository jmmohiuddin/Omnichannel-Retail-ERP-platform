import { Queue } from "bullmq";
import type { EventPublisher, OutboxEvent } from "./relay.js";

/**
 * BullMQ publisher: one `domain-events` queue; consumers (connector workers,
 * notification senders, AI jobs) subscribe with their own worker groups.
 * jobId = event id → broker-side dedupe if the relay retries a batch.
 */
export class BullPublisher implements EventPublisher {
  private readonly queue: Queue;

  constructor(redisUrl: string) {
    const url = new URL(redisUrl);
    this.queue = new Queue("domain-events", {
      connection: {
        host: url.hostname,
        port: Number(url.port || 6379),
        ...(url.password ? { password: url.password } : {}),
      },
    });
  }

  async publish(events: OutboxEvent[]): Promise<void> {
    await this.queue.addBulk(
      events.map((e) => ({
        name: e.eventType,
        data: e,
        opts: { jobId: e.id, removeOnComplete: 10_000, removeOnFail: false },
      })),
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
