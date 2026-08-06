import type pg from "pg";

export interface DriftFinding {
  tenantId: string;
  locationId: string;
  variantId: string;
  state: string;
  ledgerQty: number;
  levelQty: number;
  driftQty: number;
}

/**
 * Ledger drift check (ADR-002). stock_level is a read-model maintained in the
 * same transaction as each movement; replaying the append-only ledger must
 * reproduce it exactly. Any mismatch is a CODE BUG (never "shrinkage" — stock
 * cannot change without a movement), so findings alarm loudly.
 *
 * Entirely SQL-side: the ledger is folded (credits minus debits) per bucket
 * and FULL OUTER JOINed against the materialized levels, so buckets missing
 * from either side surface too.
 */
export class DriftCheck {
  constructor(private readonly pool: pg.Pool) {}

  async runOnce(): Promise<DriftFinding[]> {
    const { rows } = await this.pool.query<{
      tenant_id: string; location_id: string; variant_id: string; state: string;
      ledger_qty: string | null; level_qty: string | null;
    }>(
      `WITH ledger AS (
         SELECT tenant_id, location_id, variant_id, state, sum(qty) AS qty
           FROM (
             SELECT tenant_id, to_location_id AS location_id, variant_id,
                    to_state AS state, quantity AS qty
               FROM stock_movement WHERE to_location_id IS NOT NULL
             UNION ALL
             SELECT tenant_id, from_location_id, variant_id, from_state, -quantity
               FROM stock_movement WHERE from_location_id IS NOT NULL
           ) sides
          GROUP BY 1, 2, 3, 4
       )
       SELECT coalesce(l.tenant_id, sl.tenant_id)     AS tenant_id,
              coalesce(l.location_id, sl.location_id) AS location_id,
              coalesce(l.variant_id, sl.variant_id)   AS variant_id,
              coalesce(l.state, sl.state)             AS state,
              l.qty  AS ledger_qty,
              sl.quantity AS level_qty
         FROM ledger l
         FULL OUTER JOIN stock_level sl
           ON sl.tenant_id = l.tenant_id AND sl.location_id = l.location_id
          AND sl.variant_id = l.variant_id AND sl.state = l.state
        WHERE coalesce(l.qty, 0) <> coalesce(sl.quantity, 0)`,
    );

    const findings: DriftFinding[] = rows.map((r) => ({
      tenantId: r.tenant_id,
      locationId: r.location_id,
      variantId: r.variant_id,
      state: r.state,
      ledgerQty: Number(r.ledger_qty ?? 0),
      levelQty: Number(r.level_qty ?? 0),
      driftQty: Number(r.level_qty ?? 0) - Number(r.ledger_qty ?? 0),
    }));

    // Alarm per tenant: one outbox event carrying that tenant's findings, so
    // the exception pipeline (and eventually paging) picks it up.
    const byTenant = new Map<string, DriftFinding[]>();
    for (const f of findings) {
      const list = byTenant.get(f.tenantId) ?? [];
      list.push(f);
      byTenant.set(f.tenantId, list);
    }
    for (const [tenantId, tenantFindings] of byTenant) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        await client.query(
          `INSERT INTO outbox (id, tenant_id, aggregate, event_type, payload)
           VALUES (gen_random_uuid(), $1, 'inventory:drift', 'inventory.drift.detected', $2)`,
          [tenantId, JSON.stringify({ findings: tenantFindings })],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("drift-check outbox insert failed:", (err as Error).message);
      } finally {
        client.release();
      }
    }
    return findings;
  }
}
