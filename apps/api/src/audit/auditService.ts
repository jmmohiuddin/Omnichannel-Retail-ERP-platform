import { createHash } from "node:crypto";
import type pg from "pg";
import type { Db } from "../db.js";

export interface AuditEntry {
  actorUserId?: string;
  actorDeviceId?: string;
  action: string;      // 'approval.decided', 'user.created', 'mfa.enabled', …
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

/**
 * Tamper-evident audit trail (001_foundation.sql): rows are immutable at the
 * database level (forbid_change trigger) AND hash-chained per tenant —
 * row_hash = sha256(prev_hash ∥ canonical(entry)) — so even an exported copy
 * can be verified, and a truncated/reordered export cannot.
 *
 * Chain appends serialize per tenant via a transaction-scoped advisory lock;
 * the inventory ledger remains the audit source for stock (this log covers
 * authz/authn and control decisions).
 */
export class AuditService {
  constructor(private readonly db: Db) {}

  /** Key-order-insensitive canonical form: Postgres jsonb does not preserve
   *  object key order, so before/after must hash identically after a round
   *  trip through the database. */
  private stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.stable(v));
    if (value !== null && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(obj).sort().map((k) => [k, this.stable(obj[k])]),
      );
    }
    return value;
  }

  private canonical(tenantId: string, entry: AuditEntry): string {
    return JSON.stringify([
      tenantId, entry.action, entry.entityType, entry.entityId,
      entry.actorUserId ?? null, entry.actorDeviceId ?? null,
      this.stable(entry.before ?? null), this.stable(entry.after ?? null),
    ]);
  }

  /** Append inside the caller's transaction (atomic with the action itself). */
  async recordWith(c: pg.PoolClient, tenantId: string, entry: AuditEntry): Promise<void> {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('audit:' || $1))", [tenantId]);
    const prev = await c.query<{ row_hash: Buffer }>(
      "SELECT row_hash FROM audit_log WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1",
      [tenantId],
    );
    const prevHash = prev.rows[0]?.row_hash ?? null;
    const rowHash = createHash("sha256")
      .update(prevHash ?? Buffer.alloc(0))
      .update(this.canonical(tenantId, entry))
      .digest();
    await c.query(
      `INSERT INTO audit_log
         (tenant_id, actor_user_id, actor_device_id, action, entity_type, entity_id,
          before, after, ip, prev_hash, row_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [tenantId, entry.actorUserId ?? null, entry.actorDeviceId ?? null,
       entry.action, entry.entityType, entry.entityId,
       entry.before === undefined ? null : JSON.stringify(entry.before),
       entry.after === undefined ? null : JSON.stringify(entry.after),
       entry.ip ?? null, prevHash, rowHash],
    );
  }

  async record(tenantId: string, entry: AuditEntry): Promise<void> {
    await this.db.withTenant(tenantId, (c) => this.recordWith(c, tenantId, entry));
  }

  async list(tenantId: string, limit = 100): Promise<unknown[]> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query(
        `SELECT a.id, a.occurred_at AS "occurredAt", a.action,
                a.entity_type AS "entityType", a.entity_id AS "entityId",
                a.before, a.after, u.full_name AS "actor"
           FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_user_id
          ORDER BY a.id DESC LIMIT $1`,
        [limit],
      );
      return rows;
    });
  }

  /** Recompute the whole chain; any edit, removal, or reorder breaks it. */
  async verifyChain(tenantId: string): Promise<{ valid: boolean; entries: number; brokenAtId?: number }> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{
        id: number; action: string; entity_type: string; entity_id: string;
        actor_user_id: string | null; actor_device_id: string | null;
        before: unknown; after: unknown; prev_hash: Buffer | null; row_hash: Buffer;
      }>(
        `SELECT id, action, entity_type, entity_id, actor_user_id, actor_device_id,
                before, after, prev_hash, row_hash
           FROM audit_log WHERE tenant_id = $1 ORDER BY id`,
        [tenantId],
      );
      let prev: Buffer | null = null;
      for (const row of rows) {
        const expected: Buffer = createHash("sha256")
          .update(prev ?? Buffer.alloc(0))
          .update(this.canonical(tenantId, {
            action: row.action, entityType: row.entity_type, entityId: row.entity_id,
            ...(row.actor_user_id ? { actorUserId: row.actor_user_id } : {}),
            ...(row.actor_device_id ? { actorDeviceId: row.actor_device_id } : {}),
            ...(row.before !== null ? { before: row.before } : {}),
            ...(row.after !== null ? { after: row.after } : {}),
          }))
          .digest();
        if (!expected.equals(row.row_hash) ||
            Boolean(prev) !== Boolean(row.prev_hash) ||
            (prev && row.prev_hash && !prev.equals(row.prev_hash))) {
          return { valid: false, entries: rows.length, brokenAtId: row.id };
        }
        prev = row.row_hash;
      }
      return { valid: true, entries: rows.length };
    });
  }
}
