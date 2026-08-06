import { Link, useLocation, useOutletContext, useParams } from "react-router-dom";
import type { StoreContext } from "../App.js";
import type { OrderResult } from "../lib/api.js";
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
          <strong>Payment pending.</strong> Your order is reserved and you'll receive payment
          instructions shortly. Keep your order number handy.
        </p>
      </div>

      <p>
        <Link to={`/${slug}`} className="secondary button-like">
          Back to the shop
        </Link>
      </p>
    </section>
  );
}
