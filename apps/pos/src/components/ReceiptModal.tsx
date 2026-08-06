import { useEffect, useRef } from "react";
import type { Receipt, SalePaymentPayload, SaleResult } from "../lib/api.js";
import type { CartLine, CartTotals } from "../lib/cart.js";
import type { MessageKey } from "../lib/i18n.js";
import { formatMinor } from "../lib/money.js";
import { useLang } from "./LangProvider.js";

export type CompletedSale =
  | {
      mode: "online";
      sale: SaleResult;
      /** null when the receipt fetch failed — totals from the sale response. */
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

const METHOD_KEYS: Record<SalePaymentPayload["method"], MessageKey> = {
  cash: "method.cash",
  card: "method.card",
  loyalty_points: "method.loyalty_points",
};

interface Props {
  completed: CompletedSale;
  onNewSale: () => void;
}

export function ReceiptModal({ completed, onNewSale }: Props) {
  const { t } = useLang();
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
          name: l.name ?? l.sku ?? t("receipt.item"),
          quantity: l.quantity ?? 1,
          totalMinor: l.totalMinor ?? (l.unitPriceMinor ?? 0) * (l.quantity ?? 1),
        }))
      : completed.lines.map((l, i) => ({
          key: `c${i}`,
          name: l.imei !== undefined ? `${l.name} — ${t("cart.imei", { imei: l.imei })}` : l.name,
          quantity: l.quantity,
          totalMinor: l.unitPriceMinor * l.quantity,
        }));

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal receipt" role="dialog" aria-modal="true" aria-label={t("receipt.aria")}>
        <header className="receipt-header">
          <h2>{(online && receipt?.tenantName) || t("receipt.taxInvoice")}</h2>
          {/* TRN itself is a 15-digit Western-numeral code (FTA format). */}
          <p className="muted">{t("receipt.trn", { trn: (online && receipt?.trn) || "100000000000000" })}</p>
          {online ? (
            <p className="receipt-orderno">
              {t("receipt.orderNo", { orderNo: receipt?.orderNo ?? completed.sale.orderNo })}
            </p>
          ) : (
            <p className="receipt-orderno offline-note">{t("receipt.offlineSaved")}</p>
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
            <dt>{t("totals.subtotal")}</dt>
            <dd className="mono">{formatMinor(totals.subtotalMinor, currency)}</dd>
          </div>
          <div>
            <dt>{t("totals.vat")}</dt>
            <dd className="mono">{formatMinor(totals.taxMinor, currency)}</dd>
          </div>
          <div className="grand-total">
            <dt>{t("totals.total")}</dt>
            <dd className="mono">{formatMinor(totals.totalMinor, currency)}</dd>
          </div>
          {completed.payments.map((p, i) => (
            <div key={`p${i}`}>
              <dt>{i === 0 ? t("receipt.paidBy") : " "}</dt>
              <dd>
                {t(METHOD_KEYS[p.method])}{" "}
                <span className="mono">{formatMinor(p.amountMinor, currency)}</span>
              </dd>
            </div>
          ))}
        </dl>

        <button type="button" ref={newSaleRef} className="btn btn-primary btn-block" onClick={onNewSale}>
          {t("receipt.newSale")}
        </button>
      </section>
    </div>
  );
}
