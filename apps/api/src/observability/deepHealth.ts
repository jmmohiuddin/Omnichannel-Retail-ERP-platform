import type { Db } from "../db.js";

/**
 * Deep health check. Unlike `/health` (a static "the process started" ping
 * used by load balancers), this endpoint proves the API can actually do its
 * job right now:
 *   - the app-role connection works,
 *   - the schema is present (at least one migration applied),
 *   - RLS is enforcing tenant isolation (the app role is not superuser and
 *     cannot bypass RLS — this is the property that would silently fail if
 *     someone rotated the app to a wrong role).
 *
 * Any failure returns 503 with the failed check named — production monitors
 * page on this; `/health` is deliberately silent about DB state so a paused
 * database doesn't take the load balancer with it.
 */
export interface DeepHealthResult {
  status: "healthy" | "degraded";
  checks: Record<string, { ok: boolean; detail?: string; latencyMs?: number }>;
}

export async function deepHealth(db: Db): Promise<DeepHealthResult> {
  const checks: DeepHealthResult["checks"] = {};

  const dbStart = Date.now();
  try {
    const client = await db.pool.connect();
    try {
      const who = await client.query<{ role: string; superuser: boolean; bypassrls: boolean }>(
        "SELECT current_user AS role, rolsuper AS superuser, rolbypassrls AS bypassrls FROM pg_roles WHERE rolname = current_user",
      );
      const row = who.rows[0];
      const roleOk = Boolean(row) && !row!.superuser && !row!.bypassrls;
      checks.dbRole = {
        ok: roleOk,
        detail: row ? `${row.role} superuser=${row.superuser} bypassrls=${row.bypassrls}` : "no row",
        latencyMs: Date.now() - dbStart,
      };

      const migStart = Date.now();
      const applied = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM schema_migrations",
      );
      const n = Number(applied.rows[0]?.count ?? 0);
      checks.migrations = {
        ok: n > 0,
        detail: `${n} applied`,
        latencyMs: Date.now() - migStart,
      };
    } finally {
      client.release();
    }
  } catch (err) {
    checks.database = { ok: false, detail: (err as Error).message };
  }

  const failed = Object.values(checks).some((c) => !c.ok);
  return { status: failed ? "degraded" : "healthy", checks };
}
