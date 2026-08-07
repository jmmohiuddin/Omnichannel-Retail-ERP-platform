import { useState } from "react";
import { Link, useLocation, useOutletContext, useParams } from "react-router-dom";
import type { StoreContext } from "../App.js";
import { ApiError, startPayment, type OrderResult } from "../lib/api.js";
import { useCustomerSession } from "../lib/customerSession.js";
import { t, type MessageKey } from "../lib/i18n.js";
import { formatMinor } from "../lib/money.js";
import { useLang } from "../lib/useLang.js";

function isOrderResult(value: unknown): value is OrderResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.orderNo === "string" && typeof v.totals === "object" && v.totals !== null;
}

export function ConfirmationPage() {
  const { slug } = useOutletContext<StoreContext>();
  const { orderNo = "" } = useParams();
  const { lang } = useLang();
  const location = useLocation();
  const state = location.state as { result?: unknown } | null;
  const result = state && isOrderResult(state.result) ? state.result : null;
  const account = useCustomerSession(slug);

  const [paying, setPaying] = useState(false);
  // Message key (not prose) so it re-renders in the active language.
  const [payErrorKey, setPayErrorKey] = useState<MessageKey | null>(null);

  const payNow = async () => {
    if (!result) return;
    setPaying(true);
    setPayErrorKey(null);
    try {
      const intent = await startPayment(slug, result.orderId);
      if (intent.redirectUrl) {
        // Hosted checkout: the gateway page takes it from here.
        window.location.assign(intent.redirectUrl);
        return;
      }
      setPayErrorKey("confirm.payStarted");
    } catch (err) {
      if (err instanceof ApiError && err.code === "INTENT_EXISTS") {
        setPayErrorKey("confirm.payAlreadyStarted");
      } else if (err instanceof ApiError && err.code === "BAD_STATE") {
        setPayErrorKey("confirm.payBadState");
      } else {
        setPayErrorKey("confirm.payFailed");
      }
    } finally {
      setPaying(false);
    }
  };

  return (
    <section className="confirmation">
      <h1>{t(lang, "confirm.title")}</h1>
      <p className="order-no">
        {t(lang, "confirm.orderNumber")} <strong>{result?.orderNo ?? orderNo}</strong>
      </p>

      {result && (
        <div className="cart-summary">
          <div className="summary-row">
            <span>{t(lang, "confirm.subtotalExVat")}</span>
            <span>{formatMinor(result.totals.netMinor, result.totals.currency)}</span>
          </div>
          <div className="summary-row">
            <span>{t(lang, "confirm.vat")}</span>
            <span>{formatMinor(result.totals.taxMinor, result.totals.currency)}</span>
          </div>
          <div className="summary-row total">
            <span>{t(lang, "confirm.total")}</span>
            <span>{formatMinor(result.totals.totalMinor, result.totals.currency)}</span>
          </div>
        </div>
      )}

      <div className="alert info" role="status">
        <p>
          <strong>{t(lang, "confirm.pendingTitle")}</strong> {t(lang, "confirm.pendingBody")}
        </p>
        {!account.session && (
          <p>
            <Link to={`/${slug}/account/sign-in`}>
              {t(lang, "confirm.signInPrompt")}
            </Link>
          </p>
        )}
      </div>

      {result && (
        <p>
          <button type="button" onClick={payNow} disabled={paying}>
            {paying ? t(lang, "confirm.startingPayment") : t(lang, "confirm.payNow")}
          </button>
        </p>
      )}
      {payErrorKey && (
        <div className="alert" role="alert">
          <p>{t(lang, payErrorKey)}</p>
        </div>
      )}

      <p>
        <Link to={`/${slug}`} className="secondary button-like">
          {t(lang, "product.backToShop")}
        </Link>
      </p>
    </section>
  );
}
