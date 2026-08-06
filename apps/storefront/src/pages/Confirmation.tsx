import { useState } from "react";
import { Link, useLocation, useOutletContext, useParams } from "react-router-dom";
import type { StoreContext } from "../App.js";
import { ApiError, startPayment, type OrderResult } from "../lib/api.js";
import { formatMinor } from "../lib/money.js";

function isOrderResult(value: unknown): value is OrderResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.orderNo === "string" && typeof v.totals === "object" && v.totals !== null;
}

export function ConfirmationPage() {
  const { slug } = useOutletContext<StoreContext>();
  const { orderNo = "" } = useParams();
  const location = useLocation();
  const state = location.state as { result?: unknown } | null;
  const result = state && isOrderResult(state.result) ? state.result : null;

  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const payNow = async () => {
    if (!result) return;
    setPaying(true);
    setPayError(null);
    try {
      const intent = await startPayment(slug, result.orderId);
      if (intent.redirectUrl) {
        // Hosted checkout: the gateway page takes it from here.
        window.location.assign(intent.redirectUrl);
        return;
      }
      setPayError("Payment started — follow the instructions sent to you.");
    } catch (err) {
      if (err instanceof ApiError && err.code === "INTENT_EXISTS") {
        setPayError("Payment for this order has already been started.");
      } else if (err instanceof ApiError && err.code === "BAD_STATE") {
        setPayError("This order can no longer be paid online — it may already be paid.");
      } else {
        setPayError("Could not start payment. Please try again.");
      }
    } finally {
      setPaying(false);
    }
  };

  return (
    <section className="confirmation">
      <h1>Thank you — order received</h1>
      <p className="order-no">
        Order number <strong>{result?.orderNo ?? orderNo}</strong>
      </p>

      {result && (
        <div className="cart-summary">
          <div className="summary-row">
            <span>Subtotal (excl. VAT)</span>
            <span>{formatMinor(result.totals.netMinor, result.totals.currency)}</span>
          </div>
          <div className="summary-row">
            <span>VAT (5%)</span>
            <span>{formatMinor(result.totals.taxMinor, result.totals.currency)}</span>
          </div>
          <div className="summary-row total">
            <span>Total</span>
            <span>{formatMinor(result.totals.totalMinor, result.totals.currency)}</span>
          </div>
        </div>
      )}

      <div className="alert info" role="status">
        <p>
          <strong>Payment pending.</strong> Your order is reserved. Pay now to confirm it —
          you'll be taken to a secure payment page.
        </p>
      </div>

      {result && (
        <p>
          <button type="button" onClick={payNow} disabled={paying}>
            {paying ? "Starting payment…" : "Pay now"}
          </button>
        </p>
      )}
      {payError && (
        <div className="alert" role="alert">
          <p>{payError}</p>
        </div>
      )}

      <p>
        <Link to={`/${slug}`} className="secondary button-like">
          Back to the shop
        </Link>
      </p>
    </section>
  );
}
