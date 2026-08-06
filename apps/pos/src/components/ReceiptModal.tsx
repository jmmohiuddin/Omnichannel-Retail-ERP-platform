import { useEffect, useRef } from "react";
import type { Receipt, SaleResult } from "../lib/api.js";
import type { CartLine, CartTotals } from "../lib/cart.js";
import { formatMinor } from "../lib/money.js";

export type CompletedSale =
  | {
      mode: "online";
      sale: SaleResult;
      /** null when the receipt fetch failed — totals from the sale response. */
      receipt: Receipt | null;
      lines: CartLine[];
      payment: "cash" | "card";
    }
  | {
      mode: "offline";
      saleId: string;
      totals: CartTotals;
      lines: CartLine[];
      payment: "cash" | "card";
      currency: string;
    };

interface Props {
  completed: CompletedSale;
  onNewSale: () => void;
}

export function ReceiptModal({ completed, onNewSale }: Props) {
  const newSaleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    newSaleRef.current?.focus();
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Enter" || e.key === "Escape") onNewSale();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNewSale]);

  const online = completed.mode === "online";
  const receipt = online ? completed.receipt : null;
  const currency = online
    ? (receipt?.totals?.currency ?? completed.sale.totals.currency)
    : completed.currency;
  const totals = online
    ? {
        subtotalMinor: receipt?.totals?.subtotalMinor ?? completed.sale.totals.subtotalMinor,
        taxMinor: receipt?.totals?.taxMinor ?? completed.sale.totals.taxMinor,
        totalMinor: receipt?.totals?.totalMinor ?? completed.sale.totals.totalMinor,
      }
    : completed.totals;

  const receiptLines =
    online && receipt?.lines && receipt.lines.length > 0
      ? receipt.lines.map((l, i) => ({
          key: `r${i}`,
          name: l.name ?? l.sku ?? "Item",
          quantity: l.quantity ?? 1,
          totalMinor: l.totalMinor ?? (l.unitPriceMinor ?? 0) * (l.quantity ?? 1),
        }))
      : completed.lines.map((l, i) => ({
          key: `c${i}`,
          name: l.name,
          quantity: l.quantity,
          totalMinor: l.unitPriceMinor * l.quantity,
        }));

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal receipt" role="dialog" aria-modal="true" aria-label="Receipt">
        <header className="receipt-header">
          <h2>{(online && receipt?.tenantName) || "Tax Invoice"}</h2>
          <p className="muted">TRN: {(online && receipt?.trn) || "100000000000000"}</p>
          {online ? (
            <p className="receipt-orderno">Order {receipt?.orderNo ?? completed.sale.orderNo}</p>
          ) : (
            <p className="receipt-orderno offline-note">Saved offline — will sync when back online</p>
          )}
        </header>

        <ul className="receipt-lines">
          {receiptLines.map((l) => (
            <li key={l.key} className="receipt-line">
              <span className="receipt-line-name">
                {l.quantity} × {l.name}
              </span>
              <span className="mono">{formatMinor(l.totalMinor, currency)}</span>
            </li>
          ))}
        </ul>

        <dl className="totals receipt-totals">
          <div>
            <dt>Subtotal (excl. VAT)</dt>
            <dd className="mono">{formatMinor(totals.subtotalMinor, currency)}</dd>
          </div>
          <div>
            <dt>VAT 5% (included)</dt>
            <dd className="mono">{formatMinor(totals.taxMinor, currency)}</dd>
          </div>
          <div className="grand-total">
            <dt>Total</dt>
            <dd className="mono">{formatMinor(totals.totalMinor, currency)}</dd>
          </div>
          <div>
            <dt>Paid by</dt>
            <dd>{completed.payment === "cash" ? "Cash" : "Card"}</dd>
          </div>
        </dl>

        <button type="button" ref={newSaleRef} className="btn btn-primary btn-block" onClick={onNewSale}>
          New sale
        </button>
      </section>
    </div>
  );
}
