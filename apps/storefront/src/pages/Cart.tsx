import { Link, useNavigate, useOutletContext } from "react-router-dom";
import type { StoreContext } from "../App.js";
import { formatMinor, vatPortionMinor } from "../lib/money.js";
import { useCart } from "../lib/useCart.js";

export function CartPage() {
  const { slug, catalog } = useOutletContext<StoreContext>();
  const cart = useCart(slug);
  const navigate = useNavigate();
  const currency = cart.lines[0]?.currency ?? catalog.tenant.currency;

  if (cart.lines.length === 0) {
    return (
      <section className="empty-state">
        <h1>Your cart is empty</h1>
        <p>
          <Link to={`/${slug}`}>Browse the shop</Link> to add something.
        </p>
      </section>
    );
  }

  return (
    <>
      <h1>Your cart</h1>
      <ul className="cart-lines">
        {cart.lines.map((line) => (
          <li key={line.variantId} className="cart-line">
            <div className="cart-line-info">
              <Link to={`/${slug}/product/${line.productSlug}`}>{line.productName}</Link>
              <span className="variant-sku">SKU {line.sku}</span>
            </div>
            <div className="qty-controls" aria-label={`Quantity of ${line.productName}`}>
              <button
                type="button"
                className="secondary"
                aria-label={`Decrease quantity of ${line.productName}`}
                onClick={() => cart.store.setQuantity(line.variantId, line.quantity - 1)}
              >
                −
              </button>
              <span className="qty-value">{line.quantity}</span>
              <button
                type="button"
                className="secondary"
                aria-label={`Increase quantity of ${line.productName}`}
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
              Remove
            </button>
          </li>
        ))}
      </ul>

      <div className="cart-summary">
        <div className="summary-row total">
          <span>Subtotal</span>
          <span>{formatMinor(cart.totalMinor, currency)}</span>
        </div>
        <p className="vat-note">
          Includes 5% VAT of approximately {formatMinor(vatPortionMinor(cart.totalMinor), currency)}. The
          exact VAT breakdown appears on your tax invoice.
        </p>
        <div className="cart-actions">
          <Link to={`/${slug}`} className="secondary button-like">
            Continue shopping
          </Link>
          <button type="button" className="primary" onClick={() => navigate(`/${slug}/checkout`)}>
            Proceed to checkout
          </button>
        </div>
      </div>
    </>
  );
}
