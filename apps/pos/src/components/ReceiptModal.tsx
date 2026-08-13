import { useEffect, useRef } from "react";
import type { SalePaymentPayload } from "../lib/api.js";
import type { MessageKey } from "../lib/i18n.js";
import { formatMinor } from "../lib/money.js";
import { buildReceiptDocument, type CompletedSale } from "../lib/receipt.js";
import { useLang } from "./LangProvider.js";

export type { CompletedSale };

const METHOD_KEYS: Record<SalePaymentPayload["method"], MessageKey> = {
  cash: "method.cash",
  card: "method.card",
  loyalty_points: "method.loyalty_points",
};

/**
 * Issue date on a tax invoice. Explicitly Asia/Dubai — the shop's fiscal day,
 * not the browser's guess, so a sale near midnight lands in the right period.
 */
function formatIssuedAt(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-AE" : "en-AE", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    numberingSystem: "latn", // Western digits throughout, including in Arabic
  }).format(new Date(iso));
}

interface Props {
  completed: CompletedSale;
  onNewSale: () => void;
}

export function ReceiptModal({ completed, onNewSale }: Props) {
  const { t, lang } = useLang();
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

  const doc = buildReceiptDocument(completed);
  const { currency, totals } = doc;

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal receipt" role="dialog" aria-modal="true" aria-label={t("receipt.aria")}>
        <header className="receipt-header">
          {/*
            The document type is stated first and is earned, not assumed: it reads
            "Tax Invoice" only when a valid supplier TRN backs it. The seller's
            legal name is a separate line — it never displaces the mandatory phrase.
          */}
          <h2>{doc.documentType === "tax_invoice" ? t("receipt.taxInvoice") : t("receipt.saleRecord")}</h2>
          {doc.sellerName !== undefined && <p className="receipt-seller">{doc.sellerName}</p>}
          {/* TRN is a 15-digit Western-numeral code (FTA format). Omitted when absent — never invented. */}
          {doc.trn !== undefined && <p className="muted">{t("receipt.trn", { trn: doc.trn })}</p>}
          {doc.issuedAt !== undefined && (
            <p className="muted receipt-issued">{formatIssuedAt(doc.issuedAt, lang)}</p>
          )}
          {doc.orderNo !== undefined && (
            <p className="receipt-orderno">{t("receipt.orderNo", { orderNo: doc.orderNo })}</p>
          )}
          {doc.pendingSync && <p className="receipt-orderno offline-note">{t("receipt.offlineSaved")}</p>}
        </header>

        <ul className="receipt-lines">
          {doc.lines.map((l) => (
            <li key={l.key} className="receipt-line">
              <span className="receipt-line-name">
                {l.quantity} × {l.description}
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
          {doc.payments.map((p, i) => (
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
