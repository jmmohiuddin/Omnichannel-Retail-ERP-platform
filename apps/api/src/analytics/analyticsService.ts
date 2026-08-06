import {
  type DailySales,
  detectDeadStock,
  forecastDemand,
  reorderSuggestion,
} from "@omniretail/domain";
import type { Db } from "../db.js";

/**
 * Analytics + the AI module's statistical layer. Every number here is straight
 * SQL over the ledger and orders; forecast/reorder/dead-stock math lives in
 * @omniretail/domain (deterministic, unit-tested). The LLM narration layer
 * (ADR-009) consumes these outputs — it never produces figures itself.
 */
export class AnalyticsService {
  constructor(private readonly db: Db) {}

  async summary(tenantId: string): Promise<Record<string, unknown>> {
    return this.db.withTenant(tenantId, async (c) => {
      const [today, week, top, stock] = await Promise.all([
        c.query(
          `SELECT count(*)::int AS orders, coalesce(sum(total_minor),0)::bigint AS revenue,
                  coalesce(sum(tax_minor),0)::bigint AS vat
             FROM sales_order
            WHERE status NOT IN ('cancelled') AND placed_at >= date_trunc('day', now())`,
        ),
        c.query(
          `SELECT count(*)::int AS orders, coalesce(sum(total_minor),0)::bigint AS revenue
             FROM sales_order
            WHERE status NOT IN ('cancelled') AND placed_at >= now() - interval '7 days'`,
        ),
        c.query(
          `SELECT l.variant_id AS "variantId", max(l.description) AS description,
                  sum(l.quantity)::float8 AS units, sum(l.total_minor)::bigint AS revenue
             FROM sales_order_line l
             JOIN sales_order o ON o.id = l.order_id
            WHERE o.placed_at >= now() - interval '30 days'
              AND o.status NOT IN ('cancelled')
            GROUP BY l.variant_id ORDER BY revenue DESC LIMIT 5`,
        ),
        c.query(
          `SELECT coalesce(sum(sl.quantity * coalesce(v.cost_minor, 0)),0)::bigint AS "stockValue",
                  coalesce(sum(sl.quantity) FILTER (WHERE sl.state = 'on_hand'),0)::float8 AS "onHandUnits"
             FROM stock_level sl JOIN variant v ON v.id = sl.variant_id
            WHERE sl.state IN ('on_hand','reserved')`,
        ),
      ]);
      return {
        today: {
          orders: today.rows[0].orders,
          revenueMinor: Number(today.rows[0].revenue),
          vatMinor: Number(today.rows[0].vat),
        },
        last7Days: {
          orders: week.rows[0].orders,
          revenueMinor: Number(week.rows[0].revenue),
        },
        topSellers30Days: top.rows.map((r) => ({
          ...r, revenue: Number(r.revenue),
        })),
        stockValueMinor: Number(stock.rows[0].stockValue),
        onHandUnits: Number(stock.rows[0].onHandUnits),
      };
    });
  }

  /** Reorder suggestions across all active variants (statistical baseline). */
  async reorderSuggestions(
    tenantId: string,
    opts: { windowDays?: number; leadTimeDays?: number } = {},
  ): Promise<unknown[]> {
    const windowDays = opts.windowDays ?? 56;
    const leadTimeDays = opts.leadTimeDays ?? 7;

    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{
        variant_id: string; sku: string; name: string;
        on_hand: string; in_transit: string; sales: DailySales[] | null;
      }>(
        `SELECT v.id AS variant_id, v.sku, p.name,
                coalesce((SELECT sum(sl.quantity) FROM stock_level sl
                   WHERE sl.variant_id = v.id AND sl.state = 'on_hand'), 0) AS on_hand,
                coalesce((SELECT sum(sl.quantity) FROM stock_level sl
                   WHERE sl.variant_id = v.id AND sl.state = 'in_transit'), 0) AS in_transit,
                (SELECT json_agg(json_build_object('date', d.day, 'quantity', d.qty))
                   FROM (SELECT to_char(o.placed_at, 'YYYY-MM-DD') AS day,
                                sum(l.quantity)::float8 AS qty
                           FROM sales_order_line l
                           JOIN sales_order o ON o.id = l.order_id
                          WHERE l.variant_id = v.id
                            AND o.status NOT IN ('cancelled')
                            AND o.placed_at >= now() - ($1 || ' days')::interval
                          GROUP BY 1) d) AS sales
           FROM variant v JOIN product p ON p.id = v.product_id
          WHERE v.is_active AND p.status = 'active'`,
        [windowDays],
      );

      return rows.map((r) => {
        const forecast = forecastDemand(r.sales ?? [], windowDays, leadTimeDays);
        const suggestion = reorderSuggestion(
          forecast, Number(r.on_hand), Number(r.in_transit), { leadTimeDays },
        );
        return {
          variantId: r.variant_id, sku: r.sku, product: r.name,
          onHand: Number(r.on_hand), inTransit: Number(r.in_transit),
          forecast, suggestion,
        };
      }).filter((r) => r.suggestion.reorder)
        .sort((a, b) => (a.suggestion.daysOfCoverLeft ?? 1e9) - (b.suggestion.daysOfCoverLeft ?? 1e9));
    });
  }

  async deadStock(tenantId: string, thresholdDays = 90): Promise<unknown[]> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{
        variant_id: string; sku: string; name: string; on_hand: string;
        cost: string | null; last_sale_days: string | null;
      }>(
        `SELECT v.id AS variant_id, v.sku, p.name,
                coalesce((SELECT sum(sl.quantity) FROM stock_level sl
                   WHERE sl.variant_id = v.id AND sl.state = 'on_hand'), 0) AS on_hand,
                coalesce(v.cost_minor, v.price_minor) AS cost,
                (SELECT extract(day FROM now() - max(o.placed_at))::int
                   FROM sales_order_line l JOIN sales_order o ON o.id = l.order_id
                  WHERE l.variant_id = v.id) AS last_sale_days
           FROM variant v JOIN product p ON p.id = v.product_id
          WHERE v.is_active AND p.status = 'active'`,
      );
      const detected = detectDeadStock(
        rows.map((r) => ({
          variantId: r.variant_id,
          onHand: Number(r.on_hand),
          unitCostMinor: Number(r.cost ?? 0),
          lastSaleDaysAgo: r.last_sale_days === null ? null : Number(r.last_sale_days),
        })),
        thresholdDays,
      );
      const meta = new Map(rows.map((r) => [r.variant_id, { sku: r.sku, product: r.name }]));
      return detected.map((d) => ({ ...d, ...meta.get(d.variantId) }));
    });
  }

  /** Daily exception digest (FP-007): refund and approval activity for review. */
  async exceptions(tenantId: string, sinceHours = 24): Promise<Record<string, unknown>> {
    return this.db.withTenant(tenantId, async (c) => {
      const [refunds, approvals] = await Promise.all([
        c.query(
          `SELECT r.id, r.amount_minor AS "amountMinor", r.reason, r.status,
                  u.full_name AS "requestedBy", r.created_at AS "createdAt"
             FROM refund r JOIN app_user u ON u.id = r.requested_by
            WHERE r.created_at >= now() - ($1 || ' hours')::interval
            ORDER BY r.amount_minor DESC`,
          [sinceHours],
        ),
        c.query(
          `SELECT a.id, a.kind, a.status, ru.full_name AS "requestedBy",
                  au.full_name AS "decidedBy", a.requested_at AS "requestedAt"
             FROM approval a
             JOIN app_user ru ON ru.id = a.requested_by
             LEFT JOIN app_user au ON au.id = a.approved_by
            WHERE a.requested_at >= now() - ($1 || ' hours')::interval
            ORDER BY a.requested_at DESC`,
          [sinceHours],
        ),
      ]);
      return {
        windowHours: sinceHours,
        refunds: refunds.rows.map((r) => ({ ...r, amountMinor: Number(r.amountMinor) })),
        approvals: approvals.rows,
      };
    });
  }
}
