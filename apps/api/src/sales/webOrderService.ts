import { randomUUID } from "node:crypto";
import { LedgerError, lineTotals, saleTotals } from "@omniretail/domain";
import type { Db } from "../db.js";
import { PgInventoryService, translatePgError } from "../inventory/pgInventory.js";
import { PricingService } from "../catalog/pricingService.js";
import { NotificationService } from "../notify/notificationService.js";
import { CodError, CodService } from "./codService.js";
import { SaleError } from "./salesService.js";

export interface WebOrderInput {
  customer: { name: string; email?: string; phone?: string };
  lines: { variantId: string; quantity: number }[];
  /**
   * How the shopper intends to pay. Defaults to `gateway` — the behaviour
   * before the COD gate existed — so an older client keeps working.
   */
  paymentMethod?: "gateway" | "cod";
}

/**
 * Storefront orders. Stock is RESERVED (on_hand → reserved) at order time so
 * a POS sale can't take the same unit; payment capture and fulfillment convert
 * or release the reservation later. Movements are attributed to the tenant's
 * system actor — a web customer is not an employee.
 */
export class WebOrderService {
  constructor(
    private readonly db: Db,
    private readonly inventory: PgInventoryService,
    private readonly pricing: PricingService,
    /** Defaulted so existing construction sites need no change (same pattern
     *  as ShippingService's inventory dependency). */
    private readonly notifications: NotificationService = new NotificationService(db),
    /** Same defaulting pattern: the COD gate (R5.5) is stateless over `db`. */
    private readonly cod: CodService = new CodService(db),
  ) {}

  async resolveTenant(slug: string): Promise<{ id: string; name: string; currency: string; vatRateBp: number } | undefined> {
    return this.db.withPlatform(async (c) => {
      const { rows } = await c.query<{ id: string; name: string; base_currency: string; vat_rate_bp: number }>(
        "SELECT id, name, base_currency, vat_rate_bp FROM tenant WHERE slug = $1 AND status = 'active'",
        [slug],
      );
      const t = rows[0];
      return t ? { id: t.id, name: t.name, currency: t.base_currency, vatRateBp: t.vat_rate_bp } : undefined;
    });
  }

  async publicCatalog(
    tenantId: string,
    categorySlug?: string,
    lang?: string,
  ): Promise<unknown[]> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{
        productId: string;
        name: string;
        description: string | null;
        translations: Record<string, { name?: string; description?: string }> | null;
        variants: { id: string; priceMinor: number }[];
      } & Record<string, unknown>>(
        `SELECT p.id AS "productId", p.name, p.slug, p.description, p.tracking,
                p.seo, p.translations,
                (SELECT json_build_object('name', cat.name, 'slug', cat.slug)
                   FROM category cat WHERE cat.id = p.category_id) AS category,
                coalesce((SELECT json_agg(json_build_object(
                    'url', pi.url, 'alt', pi.alt) ORDER BY pi.position)
                   FROM product_image pi WHERE pi.product_id = p.id), '[]') AS images,
                coalesce(json_agg(json_build_object(
                  'id', v.id, 'sku', v.sku, 'priceMinor', v.price_minor,
                  'currency', v.currency,
                  'available', coalesce(av.qty, 0)
                ) ORDER BY v.sku) FILTER (WHERE v.id IS NOT NULL), '[]') AS variants
           FROM product p
           LEFT JOIN variant v ON v.product_id = p.id AND v.is_active
           LEFT JOIN LATERAL (
             SELECT sum(sl.quantity)::float8 AS qty FROM stock_level sl
              WHERE sl.variant_id = v.id AND sl.state = 'on_hand'
           ) av ON true
          WHERE p.status = 'active'
            AND ($1::text IS NULL OR EXISTS (
              SELECT 1 FROM category cat
               WHERE cat.id = p.category_id AND cat.slug = $1))
          GROUP BY p.id ORDER BY p.name`,
        [categorySlug ?? null],
      );
      // Overlay effective (promo-aware) prices in one resolution pass.
      const allVariantIds = rows.flatMap((r) => r.variants.map((v) => v.id));
      const priceMap = await this.pricing.resolveWith(c, allVariantIds);
      for (const row of rows) {
        row.variants = row.variants.map((v) => {
          const eff = priceMap.get(v.id);
          if (!eff) return v;
          return {
            ...v,
            priceMinor: eff.priceMinor,
            ...(eff.source === "promo" ? { listPriceMinor: eff.listPriceMinor } : {}),
          };
        });
        // Optional language overlay: fall back to base fields when the tenant
        // hasn't authored a translation for the requested language.
        if (lang) {
          const overlay = row.translations?.[lang];
          if (overlay?.name && overlay.name.trim().length > 0) row.name = overlay.name;
          if (overlay?.description && overlay.description.trim().length > 0) {
            row.description = overlay.description;
          }
        }
        // Never surface the raw translations map on the public API.
        delete (row as Record<string, unknown>).translations;
      }
      return rows;
    });
  }

  async createOrder(
    tenant: { id: string; currency: string; vatRateBp: number },
    input: WebOrderInput,
  ): Promise<{
    orderId: string;
    orderNo: string;
    totals: Record<string, unknown>;
    status: string;
    paymentMethod: string;
    /** What must be paid before this order confirms (R5.5). */
    amountDueNowMinor: number;
    codAdvanceRequiredMinor?: number;
  }> {
    try {
      return await this.db.withTenant(tenant.id, async (c) => {
        const system = await c.query<{ id: string }>(
          "SELECT id FROM app_user WHERE email = 'system@omniretail.internal' LIMIT 1",
        );
        if (!system.rows[0]) throw new SaleError("NO_POS_CHANNEL", "tenant has no system actor");
        const systemUserId = system.rows[0].id;

        const channel = await c.query<{ id: string }>(
          "SELECT id FROM channel WHERE kind = 'web' LIMIT 1",
        );
        if (!channel.rows[0]) throw new SaleError("NO_POS_CHANNEL", "tenant has no web channel");

        // Server-side pricing from the catalog; client prices are ignored.
        const variantIds = input.lines.map((l) => l.variantId);
        const { rows: variants } = await c.query<{
          id: string; sku: string; name: string; price_minor: string;
        }>(
          `SELECT v.id, v.sku, p.name, v.price_minor
             FROM variant v JOIN product p ON p.id = v.product_id
            WHERE v.id = ANY($1) AND v.is_active AND p.status = 'active'`,
          [variantIds],
        );
        const byId = new Map(variants.map((v) => [v.id, v]));
        for (const line of input.lines) {
          if (!byId.has(line.variantId)) {
            throw new SaleError("UNKNOWN_VARIANT", `variant ${line.variantId} unavailable`);
          }
        }

        // Fulfillment location: the active location that can cover every line
        // from on_hand alone (v1 single-location fulfillment; split-shipment
        // allocation is a WMS-phase feature).
        const { rows: candidates } = await c.query<{ id: string }>(
          `SELECT l.id FROM location l
            WHERE l.is_active AND NOT EXISTS (
              SELECT 1 FROM unnest($1::uuid[], $2::numeric[]) AS need(variant_id, qty)
               WHERE coalesce((SELECT sl.quantity FROM stock_level sl
                        WHERE sl.location_id = l.id AND sl.variant_id = need.variant_id
                          AND sl.state = 'on_hand'), 0) < need.qty)
            ORDER BY l.kind = 'warehouse' DESC
            LIMIT 1`,
          [variantIds, input.lines.map((l) => l.quantity)],
        );
        const location = candidates[0];
        if (!location) {
          throw new LedgerError(
            "INSUFFICIENT_STOCK",
            "no single location can fulfil this order from on-hand stock",
          );
        }

        // Customer upsert by contact.
        let customerId: string | undefined;
        if (input.customer.email || input.customer.phone) {
          const existing = await c.query<{ id: string }>(
            `SELECT id FROM customer
              WHERE ($1::citext IS NOT NULL AND email = $1)
                 OR ($2::text IS NOT NULL AND phone = $2) LIMIT 1`,
            [input.customer.email ?? null, input.customer.phone ?? null],
          );
          customerId = existing.rows[0]?.id;
        }
        if (!customerId) {
          customerId = randomUUID();
          await c.query(
            `INSERT INTO customer (id, tenant_id, full_name, email, phone)
             VALUES ($1,$2,$3,$4,$5)`,
            [customerId, tenant.id, input.customer.name,
             input.customer.email ?? null, input.customer.phone ?? null],
          );
        }

        const priceMap = await this.pricing.resolveWith(c, variantIds);
        const computed = input.lines.map((l) =>
          lineTotals(priceMap.get(l.variantId)!.priceMinor, l.quantity, tenant.vatRateBp),
        );
        const totals = saleTotals(computed);

        const counter = await c.query<{ last_no: string }>(
          `INSERT INTO order_counter (tenant_id, last_no) VALUES ($1, 1)
           ON CONFLICT (tenant_id) DO UPDATE SET last_no = order_counter.last_no + 1
           RETURNING last_no`,
          [tenant.id],
        );
        const orderNo = `INV-${String(counter.rows[0]!.last_no).padStart(6, "0")}`;
        const orderId = randomUUID();

        // ---- the COD gate (R5.5) ----
        //
        // Run BEFORE the order row exists. The audit's finding was that the
        // advance-payment configuration was "read and never enforced anywhere
        // in checkout"; the fix is not to warn after the fact but to refuse to
        // create the order at all when COD is not available, and to hold it
        // unconfirmed until the advance is actually collected.
        const codRequested = input.paymentMethod === "cod";
        let advanceRequiredMinor = 0;
        let riskScore: number | null = null;

        if (codRequested) {
          const decision = await this.cod.decideWith(c, {
            orderTotalMinor: totals.totalMinor,
            ...(customerId ? { customerId } : {}),
          });
          riskScore = decision.riskScore;
          if (!decision.allowed) {
            // Honest copy, and the alternatives, so the storefront can offer a
            // next step rather than a dead end.
            throw new CodError("COD_NOT_AVAILABLE", decision.message, {
              reason: decision.reason,
              alternatives: ["card", "tabby"],
            });
          }
          advanceRequiredMinor = decision.advanceRequiredMinor;
        }

        // A COD order with nothing left to collect up front is settled as far
        // as checkout is concerned and confirms immediately; one that owes an
        // advance stays `pending` until the gateway captures it. A gateway
        // order stays `pending` as it always has.
        const status =
          codRequested && advanceRequiredMinor === 0 ? "confirmed" : "pending";

        await c.query(
          `INSERT INTO sales_order
             (id, tenant_id, order_no, channel_id, location_id, customer_id, status,
              currency, subtotal_minor, tax_minor, total_minor, placed_at, meta,
              payment_method, cod_advance_required_minor, cod_risk_score)
           VALUES ($1,$2,$3,$4,$5,$6,$12,$7,$8,$9,$10, now(), $11,$13,$14,$15)`,
          [orderId, tenant.id, orderNo, channel.rows[0].id, location.id, customerId,
           tenant.currency, totals.subtotalMinor, totals.taxMinor, totals.totalMinor,
           JSON.stringify({
             customerName: input.customer.name,
             paymentState: codRequested && advanceRequiredMinor === 0
               ? "cod_pending_delivery"
               : "pending_payment",
           }),
           status,
           codRequested ? "cod" : "card",
           advanceRequiredMinor,
           riskScore],
        );

        for (let i = 0; i < input.lines.length; i++) {
          const line = input.lines[i]!;
          const variant = byId.get(line.variantId)!;
          await c.query(
            // Storefront sales are always standard-rated: reverse charge
            // requires a verified declaration captured face to face (R7.3a),
            // which a guest checkout has no way to obtain. The category and
            // rate are still written explicitly rather than left to the
            // column default, so every line states its own tax basis (R7.2).
            `INSERT INTO sales_order_line
               (id, tenant_id, order_id, variant_id, description, quantity,
                unit_price_minor, tax_minor, total_minor, tax_category, tax_rate_bp)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'S',$10)`,
            [randomUUID(), tenant.id, orderId, line.variantId,
             `${variant.name} (${variant.sku})`, line.quantity,
             priceMap.get(line.variantId)!.priceMinor,
             computed[i]!.taxMinor, computed[i]!.grossMinor,
             tenant.vatRateBp],
          );
          await this.inventory.postMovementWith(c, tenant.id, {
            id: randomUUID(),
            movementType: "reservation",
            variantId: line.variantId,
            quantity: line.quantity,
            from: { locationId: location.id, state: "on_hand" },
            to: { locationId: location.id, state: "reserved" },
            actorUserId: systemUserId,
            reference: { type: "order", id: orderId },
            occurredAt: new Date(),
          });
          await c.query(
            `INSERT INTO stock_reservation
               (tenant_id, variant_id, location_id, quantity, reference_type, reference_id,
                status, expires_at)
             VALUES ($1,$2,$3,$4,'order',$5,'active', now() + interval '60 minutes')`,
            [tenant.id, line.variantId, location.id, line.quantity, orderId],
          );
        }

        // The payment the shopper owes NOW. For a gateway order that is the
        // whole total; for a COD order it is the advance, and only when the
        // gate asked for one — the rest is collected at the door (R5.4).
        //
        // Both are `method = 'gateway'` so the existing capture path applies
        // unchanged; `purpose` is what stops a report reading a deposit as
        // settlement of the sale.
        const dueNowMinor = codRequested ? advanceRequiredMinor : totals.totalMinor;
        if (dueNowMinor > 0) {
          await c.query(
            `INSERT INTO payment (id, tenant_id, order_id, method, gateway, amount_minor,
                                  currency, status, purpose)
             VALUES ($1,$2,$3,'gateway',NULL,$4,$5,'pending',$6)`,
            [randomUUID(), tenant.id, orderId, dueNowMinor, tenant.currency,
             codRequested ? "cod_advance" : "sale"],
          );
        }

        await c.query(
          `INSERT INTO outbox (id, tenant_id, aggregate, event_type, payload)
           VALUES ($1,$2,$3,'order.created',$4)`,
          [randomUUID(), tenant.id, `order:${orderId}`,
           JSON.stringify({ orderId, orderNo, channel: "web", totalMinor: totals.totalMinor })],
        );

        // R13: the order confirmation is queued in THIS transaction. An order
        // that commits always has its confirmation queued; one that rolls back
        // never leaves a message promising a purchase that did not happen.
        //
        // Only when we have somewhere to send it. A phone-only order is a
        // legitimate order — throwing NO_RECIPIENT here would roll back the
        // sale because we could not send an email, which is the tail wagging
        // the dog.
        if (input.customer.email) {
          const { rows: tenantRows } = await c.query<{ name: string }>(
            "SELECT name FROM tenant WHERE id = $1",
            [tenant.id],
          );
          await this.notifications.enqueueWith(c, tenant.id, {
            request: {
              template: "order_confirmation",
              payload: {
                tenantName: tenantRows[0]?.name ?? "",
                customerName: input.customer.name,
                orderNo,
                currency: tenant.currency,
                lines: input.lines.map((line, i) => {
                  const variant = byId.get(line.variantId)!;
                  return {
                    description: `${variant.name} (${variant.sku})`,
                    quantity: line.quantity,
                    totalMinor: computed[i]!.grossMinor,
                  };
                }),
                subtotalMinor: totals.subtotalMinor,
                taxMinor: totals.taxMinor,
                totalMinor: totals.totalMinor,
                vatRateBp: tenant.vatRateBp,
              },
            },
            dedupeKey: `order_confirmation:${orderId}`,
            recipient: input.customer.email,
            customerId,
            orderId,
          });
        }

        return {
          orderId,
          orderNo,
          totals: { ...totals, currency: tenant.currency },
          status:
            codRequested && advanceRequiredMinor === 0
              ? "cod_pending_delivery"
              : "pending_payment",
          paymentMethod: codRequested ? "cod" : "card",
          // What the shopper must pay before this order confirms. Zero on a
          // COD order under the threshold; the full total on a gateway order.
          amountDueNowMinor: codRequested ? advanceRequiredMinor : totals.totalMinor,
          ...(codRequested ? { codAdvanceRequiredMinor: advanceRequiredMinor } : {}),
        };
      });
    } catch (err) {
      throw translatePgError(err);
    }
  }
}
