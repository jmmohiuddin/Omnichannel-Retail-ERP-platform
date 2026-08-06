import pg from "pg";

/**
 * Tenant-scoped data access. Every request runs inside a transaction with the
 * `app.tenant_id` GUC bound for the duration (SET LOCAL semantics via
 * set_config(..., true)), so PostgreSQL row-level security scopes every query.
 * The pool connects as `omniretail_app` — a non-superuser without BYPASSRLS —
 * making the database, not the application, the isolation boundary (ADR-008).
 */
export class Db {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  /** Run `fn` in a transaction scoped to a tenant. Rolls back on any throw. */
  async withTenant<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Platform-scope transaction (no tenant GUC): tenant provisioning only. */
  async withPlatform<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export interface PgError {
  code?: string;
  constraint?: string;
  message: string;
}

export const isPgError = (err: unknown): err is PgError =>
  typeof err === "object" && err !== null && "code" in err;
