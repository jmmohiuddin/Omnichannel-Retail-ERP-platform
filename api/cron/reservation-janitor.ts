/**
 * Cron: release expired web-checkout reservations.
 *
 * The worker normally runs this on a 60s loop; on serverless it becomes a
 * scheduled function (see vercel.json crons). runOnce() is idempotent and
 * batch-bounded, so repeated/overlapping invocations are safe. Dynamic import
 * because Vercel compiles this entry to CommonJS while the codebase is ESM.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeCron, workerDatabaseUrl } from "./_guard.js";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!authorizeCron(req, res)) return;

  const [{ default: pg }, { ReservationJanitor }] = await Promise.all([
    import("pg"),
    import("../../apps/worker/dist/reservationJanitor.js"),
  ]);

  const pool = new pg.Pool({ connectionString: workerDatabaseUrl(), max: 2 });
  try {
    // Drain in bounded batches so a backlog clears within one invocation
    // without an unbounded loop (each batch is its own set of transactions).
    let released: string[] = [];
    for (let i = 0; i < 20; i++) {
      const batch = await new ReservationJanitor(pool).runOnce(50);
      released = released.concat(batch);
      if (batch.length < 50) break;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, releasedOrders: released.length }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (err as Error).message }));
  } finally {
    await pool.end().catch(() => {});
  }
}
