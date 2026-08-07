import { useEffect, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import type { StoreContext } from "../App.js";
import {
  ApiError,
  fetchCustomerUnits,
  type CustomerUnitSummary,
} from "../lib/api.js";
import {
  formatWarrantyUntil,
  useCustomerSession,
} from "../lib/customerSession.js";
import { t, type MessageKey } from "../lib/i18n.js";
import { useLang } from "../lib/useLang.js";

/**
 * "My Devices" screen — every serialized unit the shopper has bought from
 * this store, with IMEI and warranty status. This is the warranty visibility
 * screen from the IA (docs/prd/03-information-architecture.md).
 */
export function AccountDevicesPage() {
  const { slug } = useOutletContext<StoreContext>();
  const { lang } = useLang();
  const navigate = useNavigate();
  const account = useCustomerSession(slug);

  const [units, setUnits] = useState<CustomerUnitSummary[] | null>(null);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);

  useEffect(() => {
    if (!account.session) {
      navigate(`/${slug}/account/sign-in`, { replace: true });
      return;
    }
    let cancelled = false;
    setUnits(null);
    setErrorKey(null);
    fetchCustomerUnits(slug, account.session.sessionToken)
      .then((items) => {
        if (!cancelled) setUnits(items);
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
      <h1>{t(lang, "devices.title")}</h1>

      {errorKey && (
        <div className="alert" role="alert">
          <p>{t(lang, errorKey)}</p>
        </div>
      )}

      {units === null && !errorKey && (
        <p className="status-note">{t(lang, "layout.loading")}</p>
      )}

      {units && units.length === 0 && (
        <section className="empty-state">
          <p>{t(lang, "devices.empty")}</p>
        </section>
      )}

      {units && units.length > 0 && (
        <ul className="summary-lines">
          {units.map((u) => {
            const warranty = formatWarrantyUntil(u.warrantyUntil);
            const idBadge = u.imei1
              ? `${t(lang, "devices.imei")} ${u.imei1}`
              : u.serialNo
                ? `${t(lang, "devices.serial")} ${u.serialNo}`
                : "";
            return (
              <li key={u.id}>
                <span>
                  <strong>{u.productName}</strong>{" "}
                  <span className="variant-sku">({u.sku})</span>
                  <br />
                  {idBadge && <span className="variant-sku">{idBadge}</span>}
                  <br />
                  <span className="variant-sku">
                    {t(lang, "devices.fromOrder", { orderNo: u.orderNo })}
                  </span>
                </span>
                <span>
                  {warranty ? (
                    <>
                      {t(lang, "devices.warrantyUntil")}
                      <br />
                      <strong>{warranty}</strong>
                    </>
                  ) : (
                    t(lang, "devices.noWarranty")
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <p>
        <Link to={`/${slug}/account/orders`} className="button-like secondary">
          {t(lang, "account.myOrders")}
        </Link>
      </p>
    </section>
  );
}
