import { useEffect, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import type { StoreContext } from "../App.js";
import {
  ApiError,
  fetchCustomerOrders,
  type CustomerOrderSummary,
} from "../lib/api.js";
import { formatOrderTime, useCustomerSession } from "../lib/customerSession.js";
import { t, type MessageKey } from "../lib/i18n.js";
import { formatMinor } from "../lib/money.js";
import { useLang } from "../lib/useLang.js";

/** "My Orders" screen for a signed-in shopper. */
export function AccountOrdersPage() {
  const { slug } = useOutletContext<StoreContext>();
  const { lang } = useLang();
  const navigate = useNavigate();
  const account = useCustomerSession(slug);

  const [orders, setOrders] = useState<CustomerOrderSummary[] | null>(null);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);

  useEffect(() => {
    // Redirecting inside an effect keeps the render path pure and avoids the
    // navigate-during-render warning.
    if (!account.session) {
      navigate(`/${slug}/account/sign-in`, { replace: true });
      return;
    }
    let cancelled = false;
    setOrders(null);
    setErrorKey(null);
    fetchCustomerOrders(slug, account.session.sessionToken)
      .then((items) => {
        if (!cancelled) setOrders(items);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          account.signOut();
          setErrorKey("account.error.sessionExpired");
        } else {
          setErrorKey("layout.storeUnavailable");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slug, account.session?.sessionToken]);

  if (!account.session) return null;

  return (
    <section className="confirmation">
      <h1>{t(lang, "orders.title")}</h1>
      <p className="status-note">
        {t(lang, "account.signedInAs", { name: account.session.customer.fullName })}
      </p>

      {errorKey && (
        <div className="alert" role="alert">
          <p>{t(lang, errorKey)}</p>
        </div>
      )}

      {orders === null && !errorKey && (
        <p className="status-note">{t(lang, "layout.loading")}</p>
      )}

      {orders && orders.length === 0 && (
        <section className="empty-state">
          <p>{t(lang, "orders.empty")}</p>
        </section>
      )}

      {orders && orders.length > 0 && (
        <ul className="summary-lines">
          {orders.map((o) => (
            <li key={o.id}>
              <span>
                <strong>
                  {t(lang, "orders.orderNo")} {o.orderNo}
                </strong>
                <br />
                <span className="variant-sku">
                  {t(lang, "orders.placedAt")}: {formatOrderTime(o.placedAt)}
                </span>
                <br />
                <span className="variant-sku">
                  {t(lang, "orders.status")}: {o.status}
                </span>
              </span>
              <span>{formatMinor(o.totalMinor, o.currency)}</span>
            </li>
          ))}
        </ul>
      )}

      <p>
        <Link to={`/${slug}/account/devices`} className="button-like secondary">
          {t(lang, "account.myDevices")}
        </Link>
      </p>
    </section>
  );
}
