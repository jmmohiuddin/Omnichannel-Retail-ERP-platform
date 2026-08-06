/**
 * E-invoice document service: loads the order data (same shape as
 * SalesService.receipt, re-queried here to keep the modules decoupled) and
 * runs the pure generator pipeline (model → validation → UBL XML).
 *
 * DRAFT STATUS: documents carry profile "PINT-AE-draft" — see generator.ts.
 * They are pre-transmission drafts for the accredited-service-provider
 * integration and must be validated against the final AE specification
 * (current FTA/Peppol PINT-AE docs) before transmission.
 */
import type { Db } from "../db.js";
import {
  buildEInvoiceModel,
  renderUbl,
  validateModel,
  type BuildOptions,
  type EInvoiceModel,
  type ReceiptLike,
  type ValidationResult,
} from "./generator.js";

export interface EInvoiceDocument {
  model: EInvoiceModel;
  xml: string;
  validation: ValidationResult;
}

export class EInvoiceService {
  constructor(private readonly db: Db) {}

  /**
   * Generate the draft e-invoice document for a completed order.
   * Returns undefined when the order does not exist (in this tenant).
   */
  async generateForOrder(
    tenantId: string,
    orderId: string,
  ): Promise<EInvoiceDocument | undefined> {
    const receipt = await this.db.withTenant(tenantId, async (c) => {
      const order = await c.query<{
        order_no: string;
        currency: string;
        subtotal_minor: string;
        discount_minor: string;
        tax_minor: string;
        total_minor: string;
        placed_at: Date;
        tenant_name: string;
        trn: string | null;
        vat_rate_bp: number;
        buyer_name: string | null;
      }>(
        `SELECT o.order_no, o.currency, o.subtotal_minor, o.discount_minor,
                o.tax_minor, o.total_minor, o.placed_at,
                t.name AS tenant_name, t.trn, t.vat_rate_bp,
                cu.full_name AS buyer_name
           FROM sales_order o
           JOIN tenant t ON t.id = o.tenant_id
           LEFT JOIN customer cu ON cu.id = o.customer_id
          WHERE o.id = $1`,
        [orderId],
      );
      const head = order.rows[0];
      if (!head) return undefined;

      const { rows: lines } = await c.query<{
        description: string;
        quantity: string;
        unit_price_minor: string;
        discount_minor: string;
        tax_minor: string;
        total_minor: string;
      }>(
        `SELECT description, quantity, unit_price_minor, discount_minor,
                tax_minor, total_minor
           FROM sales_order_line WHERE order_id = $1 ORDER BY description`,
        [orderId],
      );
      const { rows: payments } = await c.query<{ method: string; amount_minor: string }>(
        "SELECT method, amount_minor FROM payment WHERE order_id = $1",
        [orderId],
      );

      const data: ReceiptLike = {
        orderNo: head.order_no,
        issuedAt: head.placed_at,
        seller: { name: head.tenant_name, trn: head.trn ?? null },
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
        payments: payments.map((p) => ({
          method: p.method,
          amountMinor: Number(p.amount_minor),
        })),
      };
      const opts: BuildOptions = head.buyer_name ? { buyer: { name: head.buyer_name } } : {};
      return { data, opts };
    });

    if (!receipt) return undefined;
    const model = buildEInvoiceModel(receipt.data, receipt.opts);
    return { model, xml: renderUbl(model), validation: validateModel(model) };
  }
}
