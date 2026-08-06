/**
 * Cron: ledger drift check (ADR-002).
 *
 * Replays the movement ledger and compares it to the materialized stock_level
 * table across all tenants; any divergence is a code bug (stock cannot change
 * without a movement) and emits inventory.drift.detected per tenant. Normally
 * hourly in the worker; here it is a scheduled function. Read-only apart from
 * the alarm outbox rows.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeCron, workerDatabaseUrl } from "./_guard.js";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!authorizeCron(req, res)) return;

  const [{ default: pg }, { DriftCheck }] = await Promise.all([
    import("pg"),
    import("../../apps/worker/dist/driftCheck.js"),
  ]);

  const pool = new pg.Pool({ connectionString: workerDatabaseUrl(), max: 2 });
  try {
    const findings = await new DriftCheck(pool).runOnce();
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, driftBuckets: findings.length, findings }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (err as Error).message }));
  } finally {
    await pool.end().catch(() => {});
  }
}
