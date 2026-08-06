import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Db } from "../db.js";

export interface EffectivePrice {
  priceMinor: number;
  /** Catalog price when a promo undercuts it (for strike-through display). */
  listPriceMinor: number;
  source: "catalog" | "promo";
}

/**
 * Price resolution (002_catalog.sql price lists, finally live).
 * v1 policy: active `promo` price lists apply automatically to every channel —
 * the effective price is the LOWEST of catalog and active promo prices at
 * min_qty ≤ 1. Wholesale/customer-tier lists are a v2 policy decision (they
 * need a customer→list assignment model); the schema already supports them.
 */
export class PricingService {
  constructor(private readonly db: Db) {}

  async resolveWith(
    c: pg.PoolClient,
    variantIds: string[],
  ): Promise<Map<string, EffectivePrice>> {
    if (variantIds.length === 0) return new Map();
    const { rows } = await c.query<{
      id: string; price_minor: string; promo_minor: string | null;
    }>(
      `SELECT v.id, v.price_minor,
              (SELECT min(pli.price_minor)
                 FROM price_list_item pli
                 JOIN price_list pl ON pl.id = pli.price_list_id
                WHERE pli.variant_id = v.id
                  AND pl.kind = 'promo'
                  AND (pl.starts_at IS NULL OR pl.starts_at <= now())
                  AND (pl.ends_at IS NULL OR pl.ends_at > now())
                  AND pli.min_qty <= 1) AS promo_minor
         FROM variant v
        WHERE v.id = ANY($1)`,
      [variantIds],
    );
    const map = new Map<string, EffectivePrice>();
    for (const r of rows) {
      const list = Number(r.price_minor);
      const promo = r.promo_minor === null ? null : Number(r.promo_minor);
      const usePromo = promo !== null && promo < list;
      map.set(r.id, {
        priceMinor: usePromo ? promo! : list,
        listPriceMinor: list,
        source: usePromo ? "promo" : "catalog",
      });
    }
    return map;
  }

  async createPriceList(
    tenantId: string,
    input: { name: string; kind: "promo" | "wholesale" | "channel"; currency: string;
             startsAt?: string; endsAt?: string },
  ): Promise<{ priceListId: string }> {
    const id = randomUUID();
    await this.db.withTenant(tenantId, (c) =>
      c.query(
        `INSERT INTO price_list (id, tenant_id, name, kind, currency, starts_at, ends_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, tenantId, input.name, input.kind, input.currency,
         input.startsAt ?? null, input.endsAt ?? null],
      ),
    );
    return { priceListId: id };
  }

  async upsertItems(
    tenantId: string,
    priceListId: string,
    items: { variantId: string; priceMinor: number; minQty?: number }[],
  ): Promise<{ upserted: number }> {
    return this.db.withTenant(tenantId, async (c) => {
      let upserted = 0;
      for (const item of items) {
        await c.query(
          `INSERT INTO price_list_item (price_list_id, tenant_id, variant_id, price_minor, min_qty)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (price_list_id, variant_id, min_qty)
           DO UPDATE SET price_minor = EXCLUDED.price_minor`,
          [priceListId, tenantId, item.variantId, item.priceMinor, item.minQty ?? 1],
        );
        upserted++;
      }
      return { upserted };
    });
  }

  async listPriceLists(tenantId: string): Promise<unknown[]> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query(
        `SELECT pl.id, pl.name, pl.kind, pl.currency,
                pl.starts_at AS "startsAt", pl.ends_at AS "endsAt",
                count(pli.variant_id)::int AS items
           FROM price_list pl
           LEFT JOIN price_list_item pli ON pli.price_list_id = pl.id
          GROUP BY pl.id ORDER BY pl.name`,
      );
      return rows;
    });
  }
}
