import { useState, type FormEvent } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import type { StoreContext } from "../App.js";
import { ApiError, placeOrder, type OrderResult } from "../lib/api.js";
import type { CartLine } from "../lib/cart.js";
import { isCheckoutValid, toCustomerPayload, validateCheckout, type CheckoutErrors } from "../lib/checkout.js";
import { formatMinor, vatPortionMinor } from "../lib/money.js";
import { useCart } from "../lib/useCart.js";

interface Shortage {
  line: CartLine;
  available: number;
}

export function CheckoutPage() {
  const { slug, catalog, reloadCatalog } = useOutletContext<StoreContext>();
  const cart = useCart(slug);
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [errors, setErrors] = useState<CheckoutErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [shortages, setShortages] = useState<Shortage[] | null>(null);

  const currency = cart.lines[0]?.currency ?? catalog.tenant.currency;

  if (cart.lines.length === 0) {
    return (
      <section className="empty-state">
        <h1>Nothing to check out</h1>
        <p>
          Your cart is empty. <Link to={`/${slug}`}>Back to the shop</Link>
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
    setSubmitError(null);
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
          setSubmitError(
            found.length > 0
              ? "Some items in your cart are no longer available in the quantity requested:"
              : "Stock changed while you were checking out. Please review your cart and try again.",
          );
        } catch {
          setSubmitError("Some items are out of stock. Please review your cart and try again.");
        }
      } else if (err instanceof ApiError && err.status === 404) {
        setSubmitError("This store is no longer available.");
      } else {
        setSubmitError("We couldn't place your order. Please try again in a moment.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <h1>Checkout</h1>
      <div className="checkout-grid">
        <form className="checkout-form" onSubmit={onSubmit} noValidate>
          <h2>Your details</h2>

          <div className="field">
            <label htmlFor="co-name">Full name *</label>
            <input
              id="co-name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={errors.name ? true : undefined}
            />
            {errors.name && <p className="field-error">{errors.name}</p>}
          </div>

          <div className="field">
            <label htmlFor="co-email">Email</label>
            <input
              id="co-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={errors.email ? true : undefined}
            />
            {errors.email && <p className="field-error">{errors.email}</p>}
          </div>

          <div className="field">
            <label htmlFor="co-phone">Phone</label>
            <input
              id="co-phone"
              type="tel"
              autoComplete="tel"
              placeholder="+971 …"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              aria-invalid={errors.phone ? true : undefined}
            />
            {errors.phone && <p className="field-error">{errors.phone}</p>}
          </div>

          {errors.contact && <p className="field-error">{errors.contact}</p>}

          {submitError && (
            <div className="alert" role="alert">
              <p>{submitError}</p>
              {shortages && shortages.length > 0 && (
                <ul>
                  {shortages.map(({ line, available }) => (
                    <li key={line.variantId}>
                      {line.productName} (SKU {line.sku}) — requested {line.quantity},{" "}
                      {available > 0 ? `only ${available} left` : "out of stock"}
                    </li>
                  ))}
                </ul>
              )}
              {shortages && (
                <p>
                  <Link to={`/${slug}/cart`}>Adjust your cart</Link> and try again.
                </p>
              )}
            </div>
          )}

          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? "Placing order…" : "Place order"}
          </button>
          <p className="vat-note">
            No payment is taken now — you'll receive payment instructions after placing the order.
          </p>
        </form>

        <aside className="order-summary" aria-label="Order summary">
          <h2>Order summary</h2>
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
            <span>Total</span>
            <span>{formatMinor(cart.totalMinor, currency)}</span>
          </div>
          <p className="vat-note">
            Includes 5% VAT of approximately {formatMinor(vatPortionMinor(cart.totalMinor), currency)}.
          </p>
        </aside>
      </div>
    </>
  );
}
