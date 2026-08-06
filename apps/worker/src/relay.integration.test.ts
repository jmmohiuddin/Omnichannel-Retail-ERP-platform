/**
 * Outbox relay integration test (real PostgreSQL, in-memory publisher).
 * Requires ADMIN_DATABASE_URL; the relay connects as omniretail_worker whose
 * RLS policy grants cross-tenant outbox access (008_worker_role.sql).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "@omniretail/db";
import { MemoryPublisher, OutboxRelay, type EventPublisher } from "./relay.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const run = Boolean(ADMIN_URL);

const workerUrl = (adminUrl: string): string => {
  const u = new URL(adminUrl);
  u.username = "omniretail_worker";
  u.password = "omniretail_worker_dev";
  return u.toString();
};

describe.skipIf(!run)("OutboxRelay", () => {
  let admin: pg.Pool;
  let worker: pg.Pool;
  const tenantId = randomUUID();

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    admin = new pg.Pool({ connectionString: ADMIN_URL!, max: 2 });
    worker = new pg.Pool({ connectionString: workerUrl(ADMIN_URL!), max: 2 });
    await admin.query(
      "INSERT INTO tenant (id, name, slug) VALUES ($1,'Relay Test',$2)",
      [tenantId, `relay-${tenantId.slice(0, 8)}`],
    );
  }, 30_000);

  afterAll(async () => {
    await admin?.end();
    await worker?.end();
  });

  const insertEvent = async (type: string) => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO outbox (id, tenant_id, aggregate, event_type, payload)
       VALUES ($1,$2,'test-aggregate',$3,'{"n":1}')`,
      [id, tenantId, type],
    );
    return id;
  };

  it("publishes pending events once, in sequence order, and marks them relayed", async () => {
    const a = await insertEvent("inventory.level.changed");
    const b = await insertEvent("order.created");

    const publisher = new MemoryPublisher();
    const relay = new OutboxRelay(worker, publisher, 50);

    const first = await relay.runOnce();
    expect(first).toBeGreaterThanOrEqual(2);
    const ids = publisher.published.map((e) => e.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    expect(ids.indexOf(a)).toBeLessThan(ids.indexOf(b)); // sequence order

    // Drained: second run publishes nothing new.
    const second = await relay.runOnce();
    expect(second).toBe(0);

    const { rows } = await admin.query(
      "SELECT relayed_at FROM outbox WHERE id = ANY($1)",
      [[a, b]],
    );
    expect(rows.every((r) => r.relayed_at !== null)).toBe(true);
  });

  it("a publish failure rolls back the claim so events are retried", async () => {
    const id = await insertEvent("inventory.level.changed");

    const failing: EventPublisher = {
      publish: async () => {
        throw new Error("broker down");
      },
    };
    const relay = new OutboxRelay(worker, failing, 50);
    await expect(relay.runOnce()).rejects.toThrow("broker down");

    const { rows } = await admin.query("SELECT relayed_at FROM outbox WHERE id = $1", [id]);
    expect(rows[0]!.relayed_at).toBeNull();

    // A healthy relay picks it up afterwards.
    const publisher = new MemoryPublisher();
    await new OutboxRelay(worker, publisher, 50).runOnce();
    expect(publisher.published.some((e) => e.id === id)).toBe(true);
  });
});
