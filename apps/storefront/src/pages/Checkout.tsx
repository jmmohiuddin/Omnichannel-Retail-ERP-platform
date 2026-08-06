import { useState, type FormEvent } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import type { StoreContext } from "../App.js";
import { ApiError, placeOrder, type OrderResult } from "../lib/api.js";
import type { CartLine } from "../lib/cart.js";
import { isCheckoutValid, toCustomerPayload, validateCheckout, type CheckoutErrors } from "../lib/checkout.js";
import { t, type MessageKey } from "../lib/i18n.js";
import { formatMinor, vatPortionMinor } from "../lib/money.js";
import { useCart } from "../lib/useCart.js";
import { useLang } from "../lib/useLang.js";

interface Shortage {
  line: CartLine;
  available: number;
}

export function CheckoutPage() {
  const { slug, catalog, reloadCatalog } = useOutletContext<StoreContext>();
  const { lang } = useLang();
  const cart = useCart(slug);
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [errors, setErrors] = useState<CheckoutErrors>({});
  const [submitting, setSubmitting] = useState(false);
  // Message key (not prose) so errors re-render in the active language.
  const [submitErrorKey, setSubmitErrorKey] = useState<MessageKey | null>(null);
  const [shortages, setShortages] = useState<Shortage[] | null>(null);

  const currency = cart.lines[0]?.currency ?? catalog.tenant.currency;

  if (cart.lines.length === 0) {
    return (
      <section className="empty-state">
        <h1>{t(lang, "checkout.emptyTitle")}</h1>
        <p>
          {t(lang, "checkout.emptyBody")}{" "}
          <Link to={`/${slug}`}>{t(lang, "product.backToShop")}</Link>
        </p>
      </section>
    );
  }

  async function findShortages(): Promise<Shortage[]> {
    const fresh = await reloadCatalog();
    const availability = new Map<string, number>();
    for (const item of fresh.items) {
      for (const v of item.variants) availability.set(v.id, v.available);
    }
    return cart.lines
      .map((line) => ({ line, available: availability.get(line.variantId) ?? 0 }))
      .filter(({ line, available }) => available < line.quantity);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const input = { name, email, phone };
    const validation = validateCheckout(input);
    setErrors(validation);
    if (!isCheckoutValid(validation)) return;

    setSubmitting(true);
    setSubmitErrorKey(null);
    setShortages(null);
    try {
      const result: OrderResult = await placeOrder(slug, {
        customer: toCustomerPayload(input),
        lines: cart.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
      });
      cart.store.clear();
      navigate(`/${slug}/order/${encodeURIComponent(result.orderNo)}`, {
        state: { result },
        replace: true,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === "INSUFFICIENT_STOCK") {
        try {
          const found = await findShortages();
          setShortages(found);
          setSubmitErrorKey(
            found.length > 0 ? "checkout.error.shortages" : "checkout.error.stockChanged",
          );
        } catch {
          setSubmitErrorKey("checkout.error.someOutOfStock");
        }
      } else if (err instanceof ApiError && err.status === 404) {
        setSubmitErrorKey("checkout.error.storeGone");
      } else {
        setSubmitErrorKey("checkout.error.orderFailed");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <h1>{t(lang, "checkout.title")}</h1>
      <div className="checkout-grid">
        <form className="checkout-form" onSubmit={onSubmit} noValidate>
          <h2>{t(lang, "checkout.details")}</h2>

          <div className="field">
            <label htmlFor="co-name">{t(lang, "checkout.name")}</label>
            <input
              id="co-name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={errors.name ? true : undefined}
            />
            {errors.name && <p className="field-error">{t(lang, errors.name)}</p>}
          </div>

          <div className="field">
            <label htmlFor="co-email">{t(lang, "checkout.email")}</label>
            <input
              id="co-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={errors.email ? true : undefined}
            />
            {errors.email && <p className="field-error">{t(lang, errors.email)}</p>}
          </div>

          <div className="field">
            <label htmlFor="co-phone">{t(lang, "checkout.phone")}</label>
            <input
              id="co-phone"
              type="tel"
              autoComplete="tel"
              placeholder="+971 …"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              aria-invalid={errors.phone ? true : undefined}
            />
            {errors.phone && <p className="field-error">{t(lang, errors.phone)}</p>}
          </div>

          {errors.contact && <p className="field-error">{t(lang, errors.contact)}</p>}

          {submitErrorKey && (
            <div className="alert" role="alert">
              <p>{t(lang, submitErrorKey)}</p>
              {shortages && shortages.length > 0 && (
                <ul>
                  {shortages.map(({ line, available }) => (
                    <li key={line.variantId}>
                      {t(
                        lang,
                        available > 0 ? "checkout.shortageOnlyLeft" : "checkout.shortageOutOfStock",
                        {
                          name: line.productName,
                          sku: line.sku,
                          requested: line.quantity,
                          available,
                        },
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {shortages && (
                <p>
                  <Link to={`/${slug}/cart`}>{t(lang, "checkout.adjustCart")}</Link>
                </p>
              )}
            </div>
          )}

          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? t(lang, "checkout.placingOrder") : t(lang, "checkout.placeOrder")}
          </button>
          <p className="vat-note">{t(lang, "checkout.noPaymentNote")}</p>
        </form>

        <aside className="order-summary" aria-label={t(lang, "checkout.summary")}>
          <h2>{t(lang, "checkout.summary")}</h2>
          <ul className="summary-lines">
            {cart.lines.map((line) => (
              <li key={line.variantId}>
                <span>
                  {line.productName} <span className="variant-sku">× {line.quantity}</span>
                </span>
                <span>{formatMinor(line.priceMinor * line.quantity, line.currency)}</span>
              </li>
            ))}
          </ul>
          <div className="summary-row total">
            <span>{t(lang, "checkout.total")}</span>
            <span>{formatMinor(cart.totalMinor, currency)}</span>
          </div>
          <p className="vat-note">
            {t(lang, "checkout.vatNote", {
              amount: formatMinor(vatPortionMinor(cart.totalMinor), currency),
            })}
          </p>
        </aside>
      </div>
    </>
  );
}
