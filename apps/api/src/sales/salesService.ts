import { createHash, randomUUID } from "node:crypto";

/**
 * Deterministic UUID for a sale line's ledger movement, derived from the sale
 * id: replaying the same offline sale always produces the same movement ids,
 * so the ledger's duplicate-id rejection makes replay idempotent end to end.
 */
export function saleLineMovementId(saleId: string, lineIndex: number): string {
  const digest = createHash("sha256").update(`${saleId}:${lineIndex}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
import { lineTotals, saleTotals, type LineTotals } from "@omniretail/domain";
import type { Db } from "../db.js";
import { PgInventoryService, translatePgError } from "../inventory/pgInventory.js";
import { LoyaltyService } from "../crm/loyaltyService.js";
import { PricingService } from "../catalog/pricingService.js";
import { GiftCardService } from "../crm/giftCardService.js";

export class SaleError extends Error {
  constructor(
    readonly code:
      | "UNKNOWN_VARIANT"
      | "PAYMENT_MISMATCH"
      | "EMPTY_SALE"
      | "DUPLICATE_SALE"
      | "NO_POS_CHANNEL"
      | "SERIALIZED_REQUIRED"
      | "UNIT_UNAVAILABLE"
      | "PRICE_MISMATCH"
      | "DISCOUNT_APPROVAL_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "SaleError";
  }
}

export interface SaleLineInput {
  variantId: string;
  quantity: number;
  /** Tax-inclusive unit price in fils. Server verifies against catalog price. */
  unitPriceMinor: number;
  stockUnitId?: string;
  discountMinor?: number;
  /** Approved 'discount' approval — required when the discount exceeds the
   *  cashier band (FP-004 exceptional-discount control). */
  discountApprovalId?: string;
}

export interface PosSaleInput {
  /** Client-generated UUID — idempotency key for offline replay. */
  id: string;
  deviceId: string;
  locationId: string;
  customerName?: string;
  /** Attached CRM customer — required for loyalty_points payments. */
  customerId?: string;
  lines: SaleLineInput[];
  payments: {
    method: "cash" | "card" | "loyalty_points" | "gift_card";
    amountMinor: number;
    /** Required for gift_card payments. */
    giftCardCode?: string;
  }[];
  offlineCreated?: boolean;
  occurredAt?: Date;
}

export interface PosSaleResult {
  orderId: string;
  orderNo: string;
  totals: {
    subtotalMinor: number;
    taxMinor: number;
    netMinor: number;
    totalMinor: number;
    currency: string;
  };
}

/**
 * A POS sale is ONE transaction: order header + lines + payments + a ledger
 * movement per line + outbox events. If any piece fails (oversell, duplicate
 * replay, bad variant) the entire sale rolls back — there is no state where
 * money moved but stock didn't, or vice versa.
 */
export class SalesService {
  constructor(
    private readonly db: Db,
    private readonly inventory: PgInventoryService,
    private readonly loyalty: LoyaltyService,
    private readonly pricing: PricingService,
    private readonly giftCards: GiftCardService,
  ) {}

  async createPosSale(
    tenantId: string,
    actorUserId: string,
    input: PosSaleInput,
  ): Promise<PosSaleResult> {
    if (input.lines.length === 0) throw new SaleError("EMPTY_SALE", "sale has no lines");

    try {
      return await this.db.withTenant(tenantId, async (c) => {
        const tenant = await c.query<{
          base_currency: string; vat_rate_bp: number; settings: { pos?: { discountBandBp?: number } };
        }>(
          "SELECT base_currency, vat_rate_bp, settings FROM tenant WHERE id = $1",
          [tenantId],
        );
        const { base_currency: currency, vat_rate_bp: vatRateBp } = tenant.rows[0]!;
        // Cashier discount band: fraction of the line gross a cashier may
        // discount without a manager approval. Default 5% (500 bp).
        const discountBandBp = tenant.rows[0]!.settings?.pos?.discountBandBp ?? 500;

        // Verify variants exist and prices come from the catalog unless the
        // cashier-band override matches (v1: price must equal catalog price;
        // overrides arrive with approval workflows in a later increment).
        const variantIds = input.lines.map((l) => l.variantId);
        const { rows: variants } = await c.query<{
          id: string; sku: string; price_minor: string; name: string; tracking: string;
          warranty_months: number | null;
        }>(
          `SELECT v.id, v.sku, v.price_minor, p.name, p.tracking, v.warranty_months
             FROM variant v JOIN product p ON p.id = v.product_id
            WHERE v.id = ANY($1)`,
          [variantIds],
        );
        const byId = new Map(variants.map((v) => [v.id, v]));
        // The server owns pricing (FP-004): effective price = catalog or an
        // active promo price list, resolved here — never the client's number.
        const priceMap = await this.pricing.resolveWith(c, variantIds);
        for (const line of input.lines) {
          const variant = byId.get(line.variantId);
          if (!variant) {
            throw new SaleError("UNKNOWN_VARIANT", `variant ${line.variantId} not found`);
          }
          const effective = priceMap.get(line.variantId)!.priceMinor;
          if (line.unitPriceMinor !== effective) {
            throw new SaleError(
              "PRICE_MISMATCH",
              `${variant.sku}: effective price is ${effective}, got ${line.unitPriceMinor}`,
            );
          }
          const discount = line.discountMinor ?? 0;
          if (discount > 0) {
            const gross = Math.round(line.unitPriceMinor * line.quantity);
            const band = Math.floor((gross * discountBandBp) / 10_000);
            if (discount > band) {
              if (!line.discountApprovalId) {
                throw new SaleError(
                  "DISCOUNT_APPROVAL_REQUIRED",
                  `${variant.sku}: discount ${discount} exceeds the cashier band (${band}); manager approval required`,
                );
              }
              const approval = await c.query<{ status: string; kind: string }>(
                "SELECT status, kind FROM approval WHERE id = $1",
                [line.discountApprovalId],
              );
              if (approval.rows[0]?.kind !== "discount" || approval.rows[0].status !== "approved") {
                throw new SaleError(
                  "DISCOUNT_APPROVAL_REQUIRED",
                  "discount approval is missing, not approved, or of the wrong kind",
                );
              }
            }
          }
          // Serialized items sell as an exact scanned unit, never as a quantity
          // (FP-003: scan enforcement — a phone can't leave stock anonymously).
          if (variant.tracking === "serialized") {
            if (!line.stockUnitId) {
              throw new SaleError(
                "SERIALIZED_REQUIRED",
                `${variant.sku} is serialized: scan the unit's IMEI to sell it`,
              );
            }
            if (line.quantity !== 1) {
              throw new SaleError("SERIALIZED_REQUIRED", "serialized lines must have quantity 1");
            }
          }
        }

        // Claim serialized units: lock, validate, and mark sold inside this
        // same transaction, so two registers can never sell the same phone.
        for (const line of input.lines) {
          if (!line.stockUnitId) continue;
          const unit = await c.query<{ variant_id: string; state: string; location_id: string }>(
            "SELECT variant_id, state, location_id FROM stock_unit WHERE id = $1 FOR UPDATE",
            [line.stockUnitId],
          );
          const u = unit.rows[0];
          if (!u || u.variant_id !== line.variantId) {
            throw new SaleError("UNIT_UNAVAILABLE", "stock unit not found for this variant");
          }
          if (u.state !== "in_stock" || u.location_id !== input.locationId) {
            throw new SaleError(
              "UNIT_UNAVAILABLE",
              `unit is ${u.state}${u.location_id !== input.locationId ? " at another location" : ""}`,
            );
          }
          // Warranty starts at the moment of sale (docs/08: retailers evidence
          // warranty from the tax invoice date).
          const months = byId.get(line.variantId)!.warranty_months;
          await c.query(
            `UPDATE stock_unit
                SET state = 'sold', sold_order_id = $2, updated_at = now(),
                    warranty_until = CASE WHEN $3::int IS NULL THEN warranty_until
                                          ELSE (now() + make_interval(months => $3::int))::date END
              WHERE id = $1`,
            [line.stockUnitId, input.id, months],
          );
        }

        const computed: LineTotals[] = input.lines.map((l) =>
          lineTotals(l.unitPriceMinor, l.quantity, vatRateBp, l.discountMinor ?? 0),
        );
        const totals = saleTotals(computed);
        const paid = input.payments.reduce((s, p) => s + p.amountMinor, 0);
        if (paid !== totals.totalMinor) {
          throw new SaleError(
            "PAYMENT_MISMATCH",
            `payments (${paid}) do not equal total (${totals.totalMinor})`,
          );
        }

        // POS channel (created at tenant provisioning; guard for older tenants)
        const channel = await c.query<{ id: string }>(
          "SELECT id FROM channel WHERE kind = 'pos' LIMIT 1",
        );
        if (!channel.rows[0]) throw new SaleError("NO_POS_CHANNEL", "tenant has no POS channel");

        // Gapless per-tenant order number, locked within this transaction.
        const counter = await c.query<{ last_no: string }>(
          `INSERT INTO order_counter (tenant_id, last_no) VALUES ($1, 1)
           ON CONFLICT (tenant_id) DO UPDATE SET last_no = order_counter.last_no + 1
           RETURNING last_no`,
          [tenantId],
        );
        const orderNo = `INV-${String(counter.rows[0]!.last_no).padStart(6, "0")}`;

        const occurredAt = input.occurredAt ?? new Date();
        await c.query(
          `INSERT INTO sales_order
             (id, tenant_id, order_no, channel_id, location_id, cashier_user_id, device_id,
              customer_id, status, currency, subtotal_minor, discount_minor, tax_minor,
              total_minor, placed_at, completed_at, offline_created, meta)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9,$10,$11,$12,$13,$14,$14,$15,$16)`,
          [
            input.id, tenantId, orderNo, channel.rows[0].id, input.locationId,
            actorUserId, input.deviceId, input.customerId ?? null, currency,
            totals.subtotalMinor,
            input.lines.reduce((s, l) => s + (l.discountMinor ?? 0), 0),
            totals.taxMinor, totals.totalMinor, occurredAt,
            input.offlineCreated ?? false,
            JSON.stringify(input.customerName ? { customerName: input.customerName } : {}),
          ],
        );

        for (let i = 0; i < input.lines.length; i++) {
          const line = input.lines[i]!;
          const lt = computed[i]!;
          const variant = byId.get(line.variantId)!;
          await c.query(
            `INSERT INTO sales_order_line
               (id, tenant_id, order_id, variant_id, stock_unit_id, description,
                quantity, unit_price_minor, discount_minor, discount_approval_id,
                tax_minor, total_minor)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              randomUUID(), tenantId, input.id, line.variantId, line.stockUnitId ?? null,
              `${variant.name} (${variant.sku})`, line.quantity, line.unitPriceMinor,
              line.discountMinor ?? 0, line.discountApprovalId ?? null,
              lt.taxMinor, lt.grossMinor,
            ],
          );

          // Ledger movement — same transaction, same invariants as any movement.
          await this.inventory.postMovementWith(c, tenantId, {
            id: saleLineMovementId(input.id, i),
            movementType: "sale",
            variantId: line.variantId,
            ...(line.stockUnitId ? { stockUnitId: line.stockUnitId } : {}),
            quantity: line.quantity,
            from: { locationId: input.locationId, state: "on_hand" },
            actorUserId,
            deviceId: input.deviceId,
            reference: { type: "order", id: input.id },
            occurredAt,
          });
        }

        // Loyalty redemption is part of the sale transaction: points are
        // deducted (or the whole sale fails) before any payment row exists.
        const loyaltyPaid = input.payments
          .filter((p) => p.method === "loyalty_points")
          .reduce((s, p) => s + p.amountMinor, 0);
        if (loyaltyPaid > 0) {
          if (!input.customerId) {
            throw new SaleError("PAYMENT_MISMATCH", "loyalty payment requires an attached customer");
          }
          await this.loyalty.redeemWith(c, tenantId, input.customerId, input.id, loyaltyPaid);
        }

        // Gift-card tenders debit the card inside the sale transaction — a
        // failed debit rolls back the whole sale (same discipline as loyalty).
        for (const payment of input.payments) {
          if (payment.method !== "gift_card") continue;
          if (!payment.giftCardCode) {
            throw new SaleError("PAYMENT_MISMATCH", "gift_card payment requires giftCardCode");
          }
          await this.giftCards.redeemWith(
            c, tenantId, payment.giftCardCode, input.id, payment.amountMinor,
          );
        }

        // Cash lands in the register's open session so blind reconciliation
        // (FP-005) has a complete ledger of what should be in the drawer.
        const session = await c.query<{ id: string }>(
          "SELECT id FROM cash_session WHERE device_id = $1 AND status = 'open'",
          [input.deviceId],
        );
        const cashSessionId = session.rows[0]?.id ?? null;
        for (const payment of input.payments) {
          await c.query(
            `INSERT INTO payment (id, tenant_id, order_id, method, amount_minor, currency,
                                  status, received_by, cash_session_id, gateway_ref)
             VALUES ($1,$2,$3,$4,$5,$6,'captured',$7,$8,$9)`,
            [randomUUID(), tenantId, input.id, payment.method, payment.amountMinor,
             currency, actorUserId, payment.method === "cash" ? cashSessionId : null,
             payment.method === "gift_card" ? payment.giftCardCode!.toUpperCase() : null],
          );
        }

        // Points accrue on what the customer actually paid (excluding the
        // loyalty-funded part) — atomically with the sale, idempotent on replay.
        if (input.customerId) {
          await this.loyalty.accrueWith(
            c, tenantId, input.customerId, input.id, totals.totalMinor - loyaltyPaid,
          );
        }

        await c.query(
          `INSERT INTO outbox (id, tenant_id, aggregate, event_type, payload)
           VALUES ($1,$2,$3,'order.created',$4)`,
          [randomUUID(), tenantId, `order:${input.id}`,
           JSON.stringify({ orderId: input.id, orderNo, channel: "pos",
                            totalMinor: totals.totalMinor, currency })],
        );

        return { orderId: input.id, orderNo, totals: { ...totals, currency } };
      });
    } catch (err) {
      const translated = translatePgError(err);
      if (
        translated instanceof Error &&
        "code" in translated &&
        (translated as { code: string }).code === "DUPLICATE_MOVEMENT"
      ) {
        throw translated;
      }
      if ((err as { code?: string; constraint?: string }).code === "23505" &&
          (err as { constraint?: string }).constraint === "sales_order_pkey") {
        throw new SaleError("DUPLICATE_SALE", "sale already recorded");
      }
      throw translated;
    }
  }

  async receipt(tenantId: string, orderId: string): Promise<Record<string, unknown> | undefined> {
    return this.db.withTenant(tenantId, async (c) => {
      const order = await c.query(
        `SELECT o.id, o.order_no, o.currency, o.subtotal_minor, o.discount_minor,
                o.tax_minor, o.total_minor, o.placed_at, o.meta,
                t.name AS tenant_name, t.trn, t.vat_rate_bp,
                l.name AS location_name, l.code AS location_code,
                u.full_name AS cashier_name
           FROM sales_order o
           JOIN tenant t ON t.id = o.tenant_id
           LEFT JOIN location l ON l.id = o.location_id
           LEFT JOIN app_user u ON u.id = o.cashier_user_id
          WHERE o.id = $1`,
        [orderId],
      );
      const head = order.rows[0];
      if (!head) return undefined;
      const { rows: lines } = await c.query(
        `SELECT description, quantity, unit_price_minor, discount_minor, tax_minor, total_minor
           FROM sales_order_line WHERE order_id = $1 ORDER BY description`,
        [orderId],
      );
      const { rows: payments } = await c.query(
        "SELECT method, amount_minor FROM payment WHERE order_id = $1",
        [orderId],
      );
      return {
        kind: "tax_invoice", // FTA: simplified tax invoice fields (docs/08 §2)
        orderNo: head.order_no,
        issuedAt: head.placed_at,
        seller: { name: head.tenant_name, trn: head.trn ?? null },
        location: { name: head.location_name, code: head.location_code },
        cashier: head.cashier_name,
        currency: head.currency,
        vatRateBp: head.vat_rate_bp,
        lines: lines.map((l) => ({
          description: l.description,
          quantity: Number(l.quantity),
          unitPriceMinor: Number(l.unit_price_minor),
          discountMinor: Number(l.discount_minor),
          taxMinor: Number(l.tax_minor),
          totalMinor: Number(l.total_minor),
        })),
        totals: {
          subtotalMinor: Number(head.subtotal_minor),
          discountMinor: Number(head.discount_minor),
          taxMinor: Number(head.tax_minor),
          totalMinor: Number(head.total_minor),
        },
        payments: payments.map((p) => ({ method: p.method, amountMinor: Number(p.amount_minor) })),
      };
    });
  }
}
