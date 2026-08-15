/**
 * Tax credit notes (R7.8).
 *
 * A refund moves money and stock. A credit note is the TAX DOCUMENT that
 * reverses the output VAT on the refunded portion — without one, VAT has been
 * collected on a sale that was given back and never returned to the customer
 * or reclaimed from the FTA.
 *
 * The rule this service exists to protect: **the credit note mirrors the
 * original invoice's tax treatment; it never recomputes it.** A handset sold
 * under the domestic reverse charge (CD 91/2023) carried no VAT, so crediting
 * it carries no VAT — even if the buyer's declaration has since been revoked,
 * even if the VAT rate has changed by decree in the meantime. Recomputing
 * would produce a credit that does not reverse the invoice it names, which is
 * exactly the discrepancy an FTA audit looks for. PRD §10 lists this as an
 * explicit edge case.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Db } from "../db.js";

export class CreditNoteError extends Error {
  constructor(
    readonly code: "ORDER_NOT_FOUND" | "NOTHING_TO_CREDIT" | "EXCEEDS_INVOICE",
    message: string,
  ) {
    super(message);
    this.name = "CreditNoteError";
  }
}

export interface CreditNoteLineInput {
  /** The invoice line being credited. Required to mirror its tax treatment. */
  orderLineId: string;
  quantity: number;
}

export interface IssueCreditNoteInput {
  orderId: string;
  reason: string;
  /** Omit to credit the whole invoice. */
  lines?: CreditNoteLineInput[];
  refundId?: string;
}

export interface CreditNoteDocument {
  id: string;
  noteNo: string;
  orderId: string;
  orderNo: string;
  issuedAt: Date;
  reason: string;
  currency: string;
  taxTreatment: "standard" | "reverse_charge" | "mixed";
  buyer?: { legalName: string | null; trn: string | null; address: unknown };
  seller: { name: string; trn: string | null; address: unknown };
  lines: Array<{
    /** The invoice line this credits — the audit trail back to the sale. */
    orderLineId: string | null;
    description: string;
    quantity: number;
    unitPriceMinor: number;
    taxMinor: number;
    totalMinor: number;
    taxCategory: string;
    taxRateBp: number;
  }>;
  totals: { subtotalMinor: number; taxMinor: number; totalMinor: number };
}

interface OrderHeadRow {
  id: string;
  order_no: string;
  currency: string;
  total_minor: string;
  tax_treatment: "standard" | "reverse_charge" | "mixed";
  buyer_trn: string | null;
  buyer_legal_name: string | null;
  buyer_address: unknown;
}

interface OrderLineRow {
  id: string;
  variant_id: string;
  stock_unit_id: string | null;
  description: string;
  quantity: string;
  unit_price_minor: string;
  discount_minor: string;
  tax_minor: string;
  total_minor: string;
  tax_category: string;
  tax_rate_bp: number;
  emirate: string | null;
}

export class CreditNoteService {
  constructor(private readonly db: Db) {}

  async issue(
    tenantId: string,
    actorUserId: string,
    input: IssueCreditNoteInput,
  ): Promise<CreditNoteDocument> {
    return this.db.withTenant(tenantId, (c) =>
      this.issueWith(c, tenantId, actorUserId, input),
    );
  }

  /**
   * Issue inside an existing transaction — used by the refund path so the
   * credit note and the refund it documents commit together. A refund that
   * succeeded without its credit note would leave the VAT unreversed with
   * nothing to notice it.
   */
  async issueWith(
    c: pg.PoolClient,
    tenantId: string,
    actorUserId: string,
    input: IssueCreditNoteInput,
  ): Promise<CreditNoteDocument> {
    const { rows: heads } = await c.query<OrderHeadRow>(
      `SELECT id, order_no, currency, total_minor, tax_treatment,
              buyer_trn, buyer_legal_name, buyer_address
         FROM sales_order WHERE id = $1`,
      [input.orderId],
    );
    const head = heads[0];
    if (!head) {
      throw new CreditNoteError("ORDER_NOT_FOUND", `order ${input.orderId} not found`);
    }

    const { rows: invoiceLines } = await c.query<OrderLineRow>(
      `SELECT id, variant_id, stock_unit_id, description, quantity, unit_price_minor,
              discount_minor, tax_minor, total_minor, tax_category, tax_rate_bp, emirate
         FROM sales_order_line WHERE order_id = $1 ORDER BY description`,
      [input.orderId],
    );
    if (invoiceLines.length === 0) {
      throw new CreditNoteError("NOTHING_TO_CREDIT", "the invoice has no lines");
    }
    const byId = new Map(invoiceLines.map((l) => [l.id, l]));

    // Whole invoice unless specific lines were named.
    const requested: CreditNoteLineInput[] =
      input.lines && input.lines.length > 0
        ? input.lines
        : invoiceLines.map((l) => ({ orderLineId: l.id, quantity: Number(l.quantity) }));

    const credited = requested.map((r) => {
      const source = byId.get(r.orderLineId);
      if (!source) {
        throw new CreditNoteError(
          "NOTHING_TO_CREDIT",
          `line ${r.orderLineId} is not on invoice ${head.order_no}`,
        );
      }
      const invoicedQty = Number(source.quantity);
      if (r.quantity <= 0 || r.quantity > invoicedQty) {
        throw new CreditNoteError(
          "EXCEEDS_INVOICE",
          `cannot credit ${r.quantity} of ${source.description}: ${invoicedQty} were invoiced`,
        );
      }

      // Pro-rate from the INVOICED line totals rather than recomputing tax
      // from the unit price. The invoice's own numbers are the source of
      // truth — they already carry the discount, the rounding decision made
      // at sale time, and the tax treatment that applied that day. Integer
      // arithmetic throughout; no floats touch money.
      const share = r.quantity / invoicedQty;
      const totalMinor = Math.round(Number(source.total_minor) * share);
      const taxMinor = Math.round(Number(source.tax_minor) * share);

      return {
        source,
        quantity: r.quantity,
        totalMinor,
        taxMinor,
      };
    });

    const subtotalMinor = credited.reduce((s, l) => s + l.totalMinor, 0);
    const taxMinor = credited.reduce((s, l) => s + l.taxMinor, 0);

    if (subtotalMinor > Number(head.total_minor)) {
      throw new CreditNoteError(
        "EXCEEDS_INVOICE",
        `credit of ${subtotalMinor} exceeds the invoice total of ${head.total_minor}`,
      );
    }

    // Gapless, in its own series, incremented inside this transaction so a
    // rollback un-consumes the number (see migration 034's header).
    const { rows: counter } = await c.query<{ last_no: string }>(
      `INSERT INTO credit_note_counter (tenant_id, last_no) VALUES ($1, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET last_no = credit_note_counter.last_no + 1
       RETURNING last_no`,
      [tenantId],
    );
    const noteNo = `CN-${String(counter[0]!.last_no).padStart(6, "0")}`;

    const id = randomUUID();
    const emirate = credited.find((l) => l.source.emirate)?.source.emirate ?? null;

    await c.query(
      `INSERT INTO credit_note
         (id, tenant_id, note_no, order_id, refund_id, issued_by, reason, currency,
          subtotal_minor, tax_minor, total_minor,
          tax_treatment, buyer_trn, buyer_legal_name, buyer_address, emirate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        id, tenantId, noteNo, input.orderId, input.refundId ?? null, actorUserId,
        input.reason, head.currency,
        subtotalMinor, taxMinor, subtotalMinor,
        // Copied, never recomputed — the invariant this service exists for.
        head.tax_treatment, head.buyer_trn, head.buyer_legal_name,
        head.buyer_address ? JSON.stringify(head.buyer_address) : null,
        emirate,
      ],
    );

    for (const line of credited) {
      await c.query(
        `INSERT INTO credit_note_line
           (id, tenant_id, credit_note_id, order_line_id, variant_id, stock_unit_id,
            description, quantity, unit_price_minor, tax_minor, total_minor,
            tax_category, tax_rate_bp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          randomUUID(), tenantId, id, line.source.id, line.source.variant_id,
          line.source.stock_unit_id, line.source.description, line.quantity,
          Number(line.source.unit_price_minor), line.taxMinor, line.totalMinor,
          // Mirrored from the invoice line.
          line.source.tax_category, line.source.tax_rate_bp,
        ],
      );
    }

    await c.query(
      `INSERT INTO outbox (id, tenant_id, aggregate, event_type, payload)
       VALUES ($1,$2,$3,'credit_note.issued',$4)`,
      [randomUUID(), tenantId, `order:${input.orderId}`,
       JSON.stringify({ creditNoteId: id, noteNo, orderId: input.orderId, totalMinor: subtotalMinor })],
    );

    return this.readWith(c, id) as Promise<CreditNoteDocument>;
  }

  async read(tenantId: string, creditNoteId: string): Promise<CreditNoteDocument | undefined> {
    return this.db.withTenant(tenantId, (c) => this.readWith(c, creditNoteId));
  }

  private async readWith(
    c: pg.PoolClient,
    creditNoteId: string,
  ): Promise<CreditNoteDocument | undefined> {
    const { rows } = await c.query(
      `SELECT cn.id, cn.note_no, cn.order_id, cn.issued_at, cn.reason, cn.currency,
              cn.subtotal_minor, cn.tax_minor, cn.total_minor, cn.tax_treatment,
              cn.buyer_trn, cn.buyer_legal_name, cn.buyer_address,
              o.order_no,
              t.name AS tenant_name, t.trn AS tenant_trn, t.address AS tenant_address
         FROM credit_note cn
         JOIN sales_order o ON o.id = cn.order_id
         JOIN tenant t ON t.id = cn.tenant_id
        WHERE cn.id = $1`,
      [creditNoteId],
    );
    const head = rows[0];
    if (!head) return undefined;

    const { rows: lines } = await c.query(
      `SELECT order_line_id, description, quantity, unit_price_minor, tax_minor,
              total_minor, tax_category, tax_rate_bp
         FROM credit_note_line WHERE credit_note_id = $1 ORDER BY description`,
      [creditNoteId],
    );

    return {
      id: head.id,
      noteNo: head.note_no,
      orderId: head.order_id,
      orderNo: head.order_no,
      issuedAt: head.issued_at,
      reason: head.reason,
      currency: head.currency,
      taxTreatment: head.tax_treatment,
      seller: { name: head.tenant_name, trn: head.tenant_trn, address: head.tenant_address },
      ...(head.buyer_trn
        ? {
            buyer: {
              legalName: head.buyer_legal_name,
              trn: head.buyer_trn,
              address: head.buyer_address,
            },
          }
        : {}),
      lines: lines.map((l) => ({
        orderLineId: l.order_line_id,
        description: l.description,
        quantity: Number(l.quantity),
        unitPriceMinor: Number(l.unit_price_minor),
        taxMinor: Number(l.tax_minor),
        totalMinor: Number(l.total_minor),
        taxCategory: l.tax_category,
        taxRateBp: Number(l.tax_rate_bp),
      })),
      totals: {
        subtotalMinor: Number(head.subtotal_minor),
        taxMinor: Number(head.tax_minor),
        totalMinor: Number(head.total_minor),
      },
    };
  }

  async listForOrder(tenantId: string, orderId: string): Promise<unknown[]> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, note_no AS "noteNo", issued_at AS "issuedAt", reason,
                total_minor AS "totalMinor", tax_minor AS "taxMinor",
                tax_treatment AS "taxTreatment", currency
           FROM credit_note WHERE order_id = $1 ORDER BY issued_at DESC`,
        [orderId],
      );
      return rows.map((r) => ({
        ...r,
        totalMinor: Number(r.totalMinor),
        taxMinor: Number(r.taxMinor),
      }));
    });
  }
}
