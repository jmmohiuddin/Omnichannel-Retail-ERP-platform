/**
 * Receipt document construction — pure, so the legal shape of a receipt is
 * unit-testable without a DOM.
 *
 * A receipt is a legal document. Two rules from the design principles govern
 * everything here:
 *
 *   "Never fabricate a number."  A missing TRN renders as absent, never as a
 *   placeholder. The previous implementation fell back to the literal
 *   `100000000000000`, which printed an invalid TRN on every receipt.
 *
 *   "A receipt never says 'Tax Invoice' unless it legally is one."  Under FTA
 *   rules a simplified tax invoice must carry the supplier's TRN. Without one
 *   the document is a sale record, and says so, rather than claiming a status
 *   it does not have.
 */
import type { Receipt, SalePaymentPayload, SaleResult } from "./api.js";
import type { CartLine, CartTotals } from "./cart.js";

export type CompletedSale =
  | {
      mode: "online";
      sale: SaleResult;
      /** null when the receipt fetch failed — totals fall back to the sale response. */
      receipt: Receipt | null;
      lines: CartLine[];
      payments: SalePaymentPayload[];
    }
  | {
      mode: "offline";
      saleId: string;
      totals: CartTotals;
      lines: CartLine[];
      payments: SalePaymentPayload[];
      currency: string;
    };

export interface ReceiptDocumentLine {
  key: string;
  /** Description of goods — mandatory on a tax invoice. Never a generic filler. */
  description: string;
  quantity: number;
  totalMinor: number;
}

/**
 * Net of VAT, derived rather than read from a field.
 *
 * `subtotalMinor` means two different things on the two sides of the wire: the
 * domain's `saleTotals` returns the VAT-INCLUSIVE gross under that name (it
 * exposes the net separately as `netMinor`, which the server does not persist
 * or send), while the POS cart uses the same name for the net. Rendering the
 * server's value under an "excl. VAT" label therefore printed the gross —
 * a receipt that contradicted its own arithmetic, since total − VAT ≠ subtotal.
 *
 * Deriving it is exact: these are integer minor units, so there is no rounding
 * to lose, and it cannot drift from whatever the field happens to mean.
 */
function netOfVat(totalMinor: number, taxMinor: number): number {
  return totalMinor - taxMinor;
}

export interface ReceiptDocument {
  /**
   * `tax_invoice` only when the supplier TRN is present and well-formed.
   * Otherwise `sale_record` — honest about what the paper actually is.
   */
  documentType: "tax_invoice" | "sale_record";
  sellerName?: string;
  /** Present only when valid. Absent is rendered as absent, never as a placeholder. */
  trn?: string;
  /** ISO-8601 instant of issue. Required on a tax invoice. */
  issuedAt?: string;
  orderNo?: string;
  /** True for a queued offline sale awaiting sync. */
  pendingSync: boolean;
  currency: string;
  lines: ReceiptDocumentLine[];
  totals: { subtotalMinor: number; taxMinor: number; totalMinor: number };
  payments: SalePaymentPayload[];
}

/**
 * The placeholder the previous implementation printed. Rejected explicitly so
 * it can never re-enter from cached data, a fixture or a seed.
 */
const FABRICATED_TRN = "100000000000000";

/** FTA TRN format: exactly 15 Western-numeral digits. */
export function isValidTrn(trn: unknown): trn is string {
  return typeof trn === "string" && /^\d{15}$/.test(trn) && trn !== FABRICATED_TRN;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function buildReceiptDocument(completed: CompletedSale): ReceiptDocument {
  if (completed.mode === "offline") {
    // The till holds no supplier fiscal identity offline, so this cannot yet be
    // a tax invoice. It is reprinted as one after sync, when the server supplies
    // the seller block.
    return {
      documentType: "sale_record",
      pendingSync: true,
      currency: completed.currency,
      lines: cartLines(completed.lines),
      totals: {
        subtotalMinor: netOfVat(completed.totals.totalMinor, completed.totals.taxMinor),
        taxMinor: completed.totals.taxMinor,
        totalMinor: completed.totals.totalMinor,
      },
      payments: completed.payments,
    };
  }

  const { sale, receipt } = completed;
  const trn = isValidTrn(receipt?.seller?.trn) ? receipt.seller.trn : undefined;

  return {
    // No TRN means no tax invoice, whatever `receipt.kind` claims.
    documentType: trn ? "tax_invoice" : "sale_record",
    sellerName: receipt?.seller?.name,
    trn,
    issuedAt: receipt?.issuedAt,
    orderNo: receipt?.orderNo ?? sale.orderNo,
    pendingSync: false,
    currency: receipt?.currency ?? sale.totals.currency,
    lines:
      receipt?.lines && receipt.lines.length > 0
        ? receipt.lines.map((l, i) => ({
            key: `r${i}`,
            // The server now joins the bound unit, so a reprinted receipt
            // identifies the exact handset it was issued for.
            description:
              l.imei !== undefined || l.serialNo !== undefined
                ? `${l.description} — ${l.imei !== undefined ? `IMEI ${l.imei}` : `S/N ${l.serialNo}`}`
                : l.description,
            quantity: positiveInt(l.quantity, 1),
            totalMinor: positiveInt(l.totalMinor, positiveInt(l.unitPriceMinor, 0) * positiveInt(l.quantity, 1)),
          }))
        : cartLines(completed.lines),
    totals: (() => {
      const taxMinor = positiveInt(receipt?.totals?.taxMinor, sale.totals.taxMinor);
      const totalMinor = positiveInt(receipt?.totals?.totalMinor, sale.totals.totalMinor);
      return { subtotalMinor: netOfVat(totalMinor, taxMinor), taxMinor, totalMinor };
    })(),
    payments: completed.payments,
  };
}

/** Fallback rendering from local cart state, used offline and when the fetch failed. */
function cartLines(lines: CartLine[]): ReceiptDocumentLine[] {
  return lines.map((l, i) => ({
    key: `c${i}`,
    // The IMEI is the customer's warranty proof; it belongs on the paper.
    description: l.imei !== undefined ? `${l.name} — IMEI ${l.imei}` : l.name,
    quantity: l.quantity,
    totalMinor: l.unitPriceMinor * l.quantity,
  }));
}
