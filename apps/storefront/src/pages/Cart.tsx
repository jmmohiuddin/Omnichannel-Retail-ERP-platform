import { Link, useNavigate, useOutletContext } from "react-router-dom";
import type { StoreContext } from "../App.js";
import { t } from "../lib/i18n.js";
import { formatMinor, vatPortionMinor } from "../lib/money.js";
import { useCart } from "../lib/useCart.js";
import { useLang } from "../lib/useLang.js";

export function CartPage() {
  const { slug, catalog } = useOutletContext<StoreContext>();
  const { lang } = useLang();
  const cart = useCart(slug);
  const navigate = useNavigate();
  const currency = cart.lines[0]?.currency ?? catalog.tenant.currency;

  if (cart.lines.length === 0) {
    return (
      <section className="empty-state">
        <h1>{t(lang, "cart.emptyTitle")}</h1>
        <p>
          <Link to={`/${slug}`}>{t(lang, "cart.emptyCta")}</Link>
        </p>
      </section>
    );
  }

  return (
    <>
      <h1>{t(lang, "cart.title")}</h1>
      <ul className="cart-lines">
        {cart.lines.map((line) => (
          <li key={line.variantId} className="cart-line">
            <div className="cart-line-info">
              <Link to={`/${slug}/product/${line.productSlug}`}>{line.productName}</Link>
              <span className="variant-sku">{t(lang, "product.sku", { sku: line.sku })}</span>
            </div>
            <div className="qty-controls" aria-label={t(lang, "cart.qtyOf", { name: line.productName })}>
              <button
                type="button"
                className="secondary"
                aria-label={t(lang, "cart.decrease", { name: line.productName })}
                onClick={() => cart.store.setQuantity(line.variantId, line.quantity - 1)}
              >
                −
              </button>
              <span className="qty-value">{line.quantity}</span>
              <button
                type="button"
                className="secondary"
                aria-label={t(lang, "cart.increase", { name: line.productName })}
                onClick={() => cart.store.setQuantity(line.variantId, line.quantity + 1)}
              >
                +
              </button>
            </div>
            <span className="price">{formatMinor(line.priceMinor * line.quantity, line.currency)}</span>
            <button
              type="button"
              className="link-button"
              onClick={() => cart.store.remove(line.variantId)}
            >
              {t(lang, "cart.remove")}
            </button>
          </li>
        ))}
      </ul>

      <div className="cart-summary">
        <div className="summary-row total">
          <span>{t(lang, "cart.subtotal")}</span>
          <span>{formatMinor(cart.totalMinor, currency)}</span>
        </div>
        <p className="vat-note">
          {t(lang, "cart.vatNote", { amount: formatMinor(vatPortionMinor(cart.totalMinor), currency) })}
        </p>
        <div className="cart-actions">
          <Link to={`/${slug}`} className="secondary button-like">
            {t(lang, "cart.continueShopping")}
          </Link>
          <button type="button" className="primary" onClick={() => navigate(`/${slug}/checkout`)}>
            {t(lang, "cart.checkout")}
          </button>
        </div>
      </div>
    </>
  );
}
