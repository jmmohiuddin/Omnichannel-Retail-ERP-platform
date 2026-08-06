import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  ChannelOrder,
  Connector,
  ConnectorContext,
} from "@omniretail/connector-sdk";

export interface ImportSummary {
  imported: string[];
  duplicates: string[];
  failed: { externalId: string; reason: string }[];
  warnings: string[];
}

/**
 * Deterministic movement id per (channel, channel order, line): retrying an
 * import can never post the same reservation twice — the stock_movement PK is
 * the idempotency backstop. Same scheme as saleLineMovementId (sha256 →
 * UUIDv4 format) in apps/api/src/sales/salesService.ts.
 *
 * The channel id MUST be part of the derivation: stock_movement.id is a
 * global primary key, and external order ids are only unique per channel —
 * two channels (or two tenants) can both have an "ORD-1".
 */
export function orderLineMovementId(
  channelId: string,
  externalId: string,
  lineIndex: number,
): string {
  const digest = createHash("sha256").update(`${channelId}:${externalId}:${lineIndex}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface PgErrorLike {
  code?: string;
  constraint?: string;
  message: string;
}

const isPgError = (err: unknown): err is PgErrorLike =>
  typeof err === "object" && err !== null && "code" in err;

/** Thrown to fail one order with an operator-readable reason (rolls back). */
class OrderImportError extends Error {}

/**
 * Imports marketplace orders pulled from a channel connector — a simplified
 * realization of the order-import state machine in
 * docs/integrations/03-sync-policies.md §3:
 *
 * - dedupe on (tenant, channel, external order id); the UNIQUE constraint on
 *   sales_order is the backstop against concurrent importers,
 * - channel totals win — ERP never recomputes a marketplace's money,
 * - each order is imported atomically (order + lines + reservation movements +
 *   stock levels + outbox) or not at all,
 * - ack (where the channel requires one) happens strictly after commit; an ack
 *   failure never rolls back an imported order, it becomes a warning.
 */
export class OrderImportService {
  constructor(private readonly pool: pg.Pool /* worker role */) {}

  /** Tenant-scoped transaction: `app.tenant_id` GUC bound for RLS (apps/api/src/db.ts pattern). */
  private async withTenant<T>(
    tenantId: string,
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
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

  async importOrders(
    tenantId: string,
    channelId: string,
    connector: Connector,
    ctx: ConnectorContext,
  ): Promise<ImportSummary> {
    const orders = await connector.pullOrders(ctx);
    const summary: ImportSummary = { imported: [], duplicates: [], failed: [], warnings: [] };

    for (const order of orders) {
      let outcome: "imported" | "duplicate";
      try {
        outcome = await this.withTenant(tenantId, (c) =>
          this.importOne(c, tenantId, channelId, order),
        );
      } catch (err) {
        // Concurrent importer beat us to the insert: the UNIQUE constraint on
        // (tenant_id, channel_id, external_ref) is the dedupe backstop.
        if (isPgError(err) && err.code === "23505" && err.constraint?.includes("external_ref")) {
          summary.duplicates.push(order.externalId);
          continue;
        }
        // Concurrent debit tripped the stock_level CHECK (quantity >= 0).
        const reason =
          isPgError(err) && err.code === "23514" && err.constraint?.includes("stock_level")
            ? "insufficient stock"
            : (err as Error).message;
        summary.failed.push({ externalId: order.externalId, reason });
        continue;
      }

      if (outcome === "duplicate") {
        summary.duplicates.push(order.externalId);
        continue;
      }

      summary.imported.push(order.externalId);
      // Ack strictly after commit; failure downgrades to imported-with-warning.
      if (connector.ackOrder) {
        try {
          await connector.ackOrder(ctx, order.externalId);
        } catch (err) {
          summary.warnings.push(
            `ack failed for ${order.externalId}: ${(err as Error).message}`,
          );
        }
      }
    }
    return summary;
  }

  private async importOne(
    c: pg.PoolClient,
    tenantId: string,
    channelId: string,
    order: ChannelOrder,
  ): Promise<"imported" | "duplicate"> {
    // Idempotency fast path (poll overlap is normal — 03-sync-policies §9.1.7).
    const dupe = await c.query(
      "SELECT 1 FROM sales_order WHERE channel_id = $1 AND external_ref = $2",
      [channelId, order.externalId],
    );
    if (dupe.rows[0]) return "duplicate";

    if (order.lines.length === 0) throw new OrderImportError("order has no lines");

    // Movements are attributed to the tenant's system actor — a marketplace
    // buyer is not an employee.
    const system = await c.query<{ id: string }>(
      "SELECT id FROM app_user WHERE email = 'system@omniretail.internal' LIMIT 1",
    );
    if (!system.rows[0]) throw new OrderImportError("tenant has no system actor");
    const systemUserId = system.rows[0].id;

    // Resolve channel SKUs → ERP variants. Any unknown SKU fails the whole
    // order (never partially import a marketplace order).
    const skus = order.lines.map((l) => l.sku);
    const { rows: variants } = await c.query<{
      id: string;
      sku: string;
      name: string;
    }>(
      `SELECT v.id, v.sku, p.name
         FROM variant v JOIN product p ON p.id = v.product_id
        WHERE v.tenant_id = $1 AND v.sku = ANY($2) AND v.is_active`,
      [tenantId, skus],
    );
    const bySku = new Map(variants.map((v) => [v.sku, v]));
    for (const line of order.lines) {
      if (!bySku.has(line.sku)) {
        throw new OrderImportError(`unknown SKU ${line.sku}`);
      }
    }

    // Fulfillment location: one active location covering every line from
    // on_hand (v1 single-location fulfillment, same rule as web orders).
    const variantIds = order.lines.map((l) => bySku.get(l.sku)!.id);
    const { rows: candidates } = await c.query<{ id: string }>(
      `SELECT l.id FROM location l
        WHERE l.is_active AND NOT EXISTS (
          SELECT 1 FROM unnest($1::uuid[], $2::numeric[]) AS need(variant_id, qty)
           WHERE coalesce((SELECT sl.quantity FROM stock_level sl
                    WHERE sl.location_id = l.id AND sl.variant_id = need.variant_id
                      AND sl.state = 'on_hand'), 0) < need.qty)
        ORDER BY l.kind = 'warehouse' DESC
        LIMIT 1`,
      [variantIds, order.lines.map((l) => l.quantity)],
    );
    const location = candidates[0];
    if (!location) throw new OrderImportError("insufficient stock");

    // Customer upsert by contact, when the channel shared one.
    let customerId: string | null = null;
    const buyer = order.buyer;
    if (buyer?.email || buyer?.phone) {
      const existing = await c.query<{ id: string }>(
        `SELECT id FROM customer
          WHERE ($1::citext IS NOT NULL AND email = $1)
             OR ($2::text IS NOT NULL AND phone = $2) LIMIT 1`,
        [buyer.email ?? null, buyer.phone ?? null],
      );
      customerId = existing.rows[0]?.id ?? null;
      if (!customerId) {
        customerId = randomUUID();
        await c.query(
          `INSERT INTO customer (id, tenant_id, full_name, email, phone)
           VALUES ($1,$2,$3,$4,$5)`,
          [customerId, tenantId, buyer.name ?? "Marketplace customer",
           buyer.email ?? null, buyer.phone ?? null],
        );
      }
    }

    // Gapless per-tenant order number (007_sales.sql row-lock counter).
    const counter = await c.query<{ last_no: string }>(
      `INSERT INTO order_counter (tenant_id, last_no) VALUES ($1, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET last_no = order_counter.last_no + 1
       RETURNING last_no`,
      [tenantId],
    );
    const orderNo = `INV-${String(counter.rows[0]!.last_no).padStart(6, "0")}`;
    const orderId = randomUUID();

    // Channel totals win — ERP records the marketplace's own money verbatim.
    const t = order.totals;
    await c.query(
      `INSERT INTO sales_order
         (id, tenant_id, order_no, channel_id, external_ref, location_id, customer_id,
          status, currency, subtotal_minor, discount_minor, tax_minor, shipping_minor,
          total_minor, placed_at, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed',$8,$9,$10,$11,$12,$13,$14,$15)`,
      [orderId, tenantId, orderNo, channelId, order.externalId, location.id, customerId,
       order.currency, t.subtotalMinor, t.discountMinor, t.taxMinor, t.shippingMinor,
       t.grandMinor, order.placedAt,
       JSON.stringify({
         channelOrderNumber: order.orderNumber ?? null,
         channelStatus: order.status,
       })],
    );

    for (let i = 0; i < order.lines.length; i++) {
      const line = order.lines[i]!;
      const variant = bySku.get(line.sku)!;
      await c.query(
        `INSERT INTO sales_order_line
           (id, tenant_id, order_id, variant_id, description, quantity,
            unit_price_minor, total_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [randomUUID(), tenantId, orderId, variant.id,
         `${variant.name} (${variant.sku})`, line.quantity,
         line.unitPriceMinor, line.unitPriceMinor * line.quantity],
      );

      // Reservation movement: on_hand → reserved at the fulfilling location.
      const movementId = orderLineMovementId(channelId, order.externalId, i);
      const { rows: mv } = await c.query<{ seq: string }>(
        `INSERT INTO stock_movement
           (id, tenant_id, occurred_at, movement_type, variant_id, quantity,
            from_location_id, from_state, to_location_id, to_state,
            actor_user_id, reference_type, reference_id)
         VALUES ($1,$2,now(),'reservation',$3,$4,$5,'on_hand',$5,'reserved',$6,'order',$7)
         RETURNING seq`,
        [movementId, tenantId, variant.id, line.quantity, location.id,
         systemUserId, orderId],
      );
      const seq = Number(mv[0]!.seq);

      // stock_level maintenance in the same transaction (pgInventory applyDelta
      // pattern): debit must UPDATE an existing row — an upsert can never debit
      // because the CHECK constraint is evaluated on the proposed negative row.
      const debit = await c.query(
        `UPDATE stock_level
            SET quantity = quantity - $4, updated_seq = $5, updated_at = now()
          WHERE tenant_id = $1 AND location_id = $2 AND variant_id = $3
            AND state = 'on_hand'`,
        [tenantId, location.id, variant.id, line.quantity, seq],
      );
      if (debit.rowCount === 0) throw new OrderImportError("insufficient stock");
      await c.query(
        `INSERT INTO stock_level (tenant_id, location_id, variant_id, state, quantity, updated_seq)
         VALUES ($1,$2,$3,'reserved',$4,$5)
         ON CONFLICT (tenant_id, location_id, variant_id, state)
         DO UPDATE SET quantity   = stock_level.quantity + EXCLUDED.quantity,
                       updated_seq = EXCLUDED.updated_seq,
                       updated_at  = now()`,
        [tenantId, location.id, variant.id, line.quantity, seq],
      );

      // Hard reservation, no expiry — marketplace orders don't expire; only a
      // channel-confirmed cancellation or operator override releases them.
      await c.query(
        `INSERT INTO stock_reservation
           (tenant_id, variant_id, location_id, quantity, reference_type, reference_id,
            status, expires_at)
         VALUES ($1,$2,$3,$4,'order',$5,'active',NULL)`,
        [tenantId, variant.id, location.id, line.quantity, orderId],
      );
    }

    await c.query(
      `INSERT INTO outbox (id, tenant_id, aggregate, event_type, payload)
       VALUES ($1,$2,$3,'channel.order.imported',$4)`,
      [randomUUID(), tenantId, `order:${orderId}`,
       JSON.stringify({
         orderId, orderNo, channelId, externalId: order.externalId,
         totalMinor: t.grandMinor, currency: order.currency,
       })],
    );

    return "imported";
  }
}
