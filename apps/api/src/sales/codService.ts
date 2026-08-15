/**
 * Cash-on-delivery policy, risk and outcome history (R5.5, R9.5, R12.8).
 *
 * The I/O half of the COD gate. The decision itself — thresholds, advance
 * arithmetic, the risk score — lives in `packages/domain/src/codGate.ts` and
 * is called from here, never re-implemented (CLAUDE.md).
 *
 * What this service owns: reading the tenant's policy, counting a customer's
 * delivery history, and recording what actually happened at the door. That
 * last part is the compounding asset the PRD identifies (R9.5): a shop that
 * has been trading for a year knows which customers refuse deliveries, and
 * nobody else does.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  DEFAULT_COD_POLICY,
  NO_COD_HISTORY,
  codRiskScore,
  decideCod,
  type CodDecision,
  type CodHistory,
  type CodPolicy,
} from "@omniretail/domain";
import type { Db } from "../db.js";

export class CodError extends Error {
  constructor(
    readonly code: "COD_NOT_AVAILABLE" | "ADVANCE_REQUIRED" | "ORDER_NOT_FOUND",
    message: string,
    /** Everything the storefront needs to explain itself to the shopper. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CodError";
  }
}

interface PolicyRow {
  enabled: boolean;
  advance_threshold_minor: string;
  advance_mode: "fixed" | "percent";
  advance_fixed_minor: string;
  advance_percent_bp: number;
  risk_ceiling: number;
  max_order_minor: string | null;
}

const toPolicy = (r: PolicyRow): CodPolicy => ({
  enabled: r.enabled,
  advanceThresholdMinor: Number(r.advance_threshold_minor),
  advanceMode: r.advance_mode,
  advanceFixedMinor: Number(r.advance_fixed_minor),
  advancePercentBp: r.advance_percent_bp,
  riskCeiling: r.risk_ceiling,
  maxOrderMinor: r.max_order_minor === null ? null : Number(r.max_order_minor),
});

export interface RecordOutcomeInput {
  orderId: string;
  shipmentId?: string;
  customerId?: string;
  outcome: "delivered" | "refused" | "undeliverable";
  collectedMinor?: number;
  expectedMinor?: number;
  freightCostMinor?: number;
  area?: string;
  emirate?: string;
  note?: string;
}

export class CodService {
  constructor(private readonly db: Db) {}

  async policy(tenantId: string): Promise<CodPolicy> {
    return this.db.withTenant(tenantId, (c) => this.policyWith(c));
  }

  /**
   * The tenant's policy, or the shipped default when no row exists.
   *
   * Falling back to the default rather than to "no gate" is deliberate: a
   * missing configuration row must not silently mean unlimited unsecured COD.
   * Migration 035 backfills every existing tenant, so this is a belt-and-
   * braces path for a tenant created by some future code path that forgets.
   */
  async policyWith(c: pg.PoolClient): Promise<CodPolicy> {
    const { rows } = await c.query<PolicyRow>(
      `SELECT enabled, advance_threshold_minor, advance_mode, advance_fixed_minor,
              advance_percent_bp, risk_ceiling, max_order_minor
         FROM cod_policy WHERE tenant_id = current_tenant_id()`,
    );
    return rows[0] ? toPolicy(rows[0]) : DEFAULT_COD_POLICY;
  }

  async updatePolicy(tenantId: string, patch: Partial<CodPolicy>): Promise<CodPolicy> {
    return this.db.withTenant(tenantId, async (c) => {
      await c.query(
        `INSERT INTO cod_policy (tenant_id) VALUES (current_tenant_id())
         ON CONFLICT (tenant_id) DO NOTHING`,
      );
      await c.query(
        `UPDATE cod_policy
            SET enabled                 = coalesce($1, enabled),
                advance_threshold_minor = coalesce($2, advance_threshold_minor),
                advance_mode            = coalesce($3, advance_mode),
                advance_fixed_minor     = coalesce($4, advance_fixed_minor),
                advance_percent_bp      = coalesce($5, advance_percent_bp),
                risk_ceiling            = coalesce($6, risk_ceiling),
                -- max_order_minor is genuinely nullable ("no cap"), so a
                -- coalesce could never clear it. $8 says whether $7 is meant.
                max_order_minor         = CASE WHEN $8 THEN $7 ELSE max_order_minor END,
                updated_at              = now()
          WHERE tenant_id = current_tenant_id()`,
        [
          patch.enabled ?? null,
          patch.advanceThresholdMinor ?? null,
          patch.advanceMode ?? null,
          patch.advanceFixedMinor ?? null,
          patch.advancePercentBp ?? null,
          patch.riskCeiling ?? null,
          patch.maxOrderMinor ?? null,
          Object.prototype.hasOwnProperty.call(patch, "maxOrderMinor"),
        ],
      );
      return this.policyWith(c);
    });
  }

  /** A customer's counted COD history. Unknown customer → no history. */
  async historyWith(c: pg.PoolClient, customerId?: string): Promise<CodHistory> {
    if (!customerId) return NO_COD_HISTORY;
    const { rows } = await c.query<{ outcome: string; n: string }>(
      `SELECT outcome, count(*) AS n
         FROM cod_delivery_outcome
        WHERE customer_id = $1
        GROUP BY outcome`,
      [customerId],
    );
    const by = Object.fromEntries(rows.map((r) => [r.outcome, Number(r.n)]));
    return {
      delivered: by.delivered ?? 0,
      refused: by.refused ?? 0,
      undeliverable: by.undeliverable ?? 0,
    };
  }

  /**
   * The gate, inside the caller's transaction. Runs on the same client as the
   * order insert so the decision and the order it governs commit together.
   */
  async decideWith(
    c: pg.PoolClient,
    args: { orderTotalMinor: number; customerId?: string | undefined },
  ): Promise<CodDecision> {
    const [policy, history] = await Promise.all([
      this.policyWith(c),
      this.historyWith(c, args.customerId),
    ]);
    return decideCod({ orderTotalMinor: args.orderTotalMinor, policy, history });
  }

  /** What the shopper would be offered, without placing an order. */
  async quote(
    tenantId: string,
    orderTotalMinor: number,
    customerId?: string,
  ): Promise<CodDecision> {
    return this.db.withTenant(tenantId, (c) =>
      this.decideWith(c, { orderTotalMinor, ...(customerId ? { customerId } : {}) }),
    );
  }

  /**
   * Record what happened at the door (R5.4, R9.5).
   *
   * Append-only and unique per ORDER (migration 036): a delivery either
   * happened or it did not, and a second row would double-count both the
   * customer's reputation and the freight the refusal cost. Keyed on the
   * order rather than the shipment because `shipment_id` is nullable, and a
   * unique index over a nullable column dedupes nothing.
   */
  async recordOutcomeWith(
    c: pg.PoolClient,
    tenantId: string,
    input: RecordOutcomeInput,
  ): Promise<{ recorded: boolean }> {
    const inserted = await c.query(
      `INSERT INTO cod_delivery_outcome
         (id, tenant_id, order_id, shipment_id, customer_id, outcome,
          collected_minor, expected_minor, freight_cost_minor, area, emirate, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (tenant_id, order_id) DO NOTHING`,
      [
        randomUUID(), tenantId, input.orderId, input.shipmentId ?? null,
        input.customerId ?? null, input.outcome,
        input.collectedMinor ?? 0, input.expectedMinor ?? 0,
        input.freightCostMinor ?? 0,
        input.area ?? null, input.emirate ?? null, input.note ?? null,
      ],
    );
    return { recorded: (inserted.rowCount ?? 0) > 0 };
  }

  async recordOutcome(
    tenantId: string,
    input: RecordOutcomeInput,
  ): Promise<{ recorded: boolean }> {
    return this.db.withTenant(tenantId, (c) => this.recordOutcomeWith(c, tenantId, input));
  }

  /**
   * COD performance (R12.8): sent, delivered, refused, cost of refusal, by
   * area. The report the merchant needs to know whether the gate is working.
   */
  async performance(
    tenantId: string,
    sinceDays = 90,
  ): Promise<Record<string, unknown>> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows: totals } = await c.query<{
        outcome: string; n: string; collected: string; freight: string;
      }>(
        `SELECT outcome, count(*) AS n,
                coalesce(sum(collected_minor),0)   AS collected,
                coalesce(sum(freight_cost_minor),0) AS freight
           FROM cod_delivery_outcome
          WHERE occurred_at > now() - make_interval(days => $1)
          GROUP BY outcome`,
        [sinceDays],
      );
      const { rows: byArea } = await c.query<{
        area: string | null; delivered: string; refused: string; freight: string;
      }>(
        `SELECT coalesce(area, emirate, 'unknown') AS area,
                count(*) FILTER (WHERE outcome = 'delivered') AS delivered,
                count(*) FILTER (WHERE outcome <> 'delivered') AS refused,
                coalesce(sum(freight_cost_minor),0) AS freight
           FROM cod_delivery_outcome
          WHERE occurred_at > now() - make_interval(days => $1)
          GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT 25`,
        [sinceDays],
      );

      const by = Object.fromEntries(totals.map((t) => [t.outcome, Number(t.n)]));
      const delivered = by.delivered ?? 0;
      const failed = (by.refused ?? 0) + (by.undeliverable ?? 0);
      const sent = delivered + failed;

      return {
        sinceDays,
        sent,
        delivered,
        refused: by.refused ?? 0,
        undeliverable: by.undeliverable ?? 0,
        // The G5 metric: "COD refusal rate under 8%". Basis points so the
        // number stays integer-exact, like every other rate in this system.
        refusalRateBp: sent === 0 ? 0 : Math.round((10_000 * failed) / sent),
        collectedMinor: totals.reduce((s, t) => s + Number(t.collected), 0),
        costOfRefusalMinor: totals
          .filter((t) => t.outcome !== "delivered")
          .reduce((s, t) => s + Number(t.freight), 0),
        byArea: byArea.map((a) => ({
          area: a.area,
          delivered: Number(a.delivered),
          refused: Number(a.refused),
          freightMinor: Number(a.freight),
        })),
      };
    });
  }

  /** The stored risk score for a customer, for the CRM screen. */
  async riskFor(tenantId: string, customerId: string): Promise<{
    score: number;
    history: CodHistory;
  }> {
    return this.db.withTenant(tenantId, async (c) => {
      const history = await this.historyWith(c, customerId);
      return { score: codRiskScore(history), history };
    });
  }
}
