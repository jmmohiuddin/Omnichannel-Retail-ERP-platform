import { useEffect, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import type { StoreContext } from "../App.js";
import { formatMinor } from "../lib/money.js";
import { useCart } from "../lib/useCart.js";

export function ProductPage() {
  const { slug, catalog } = useOutletContext<StoreContext>();
  const { productSlug = "" } = useParams();
  const cart = useCart(slug);

  const product = catalog.items.find((item) => item.slug === productSlug);
  const [variantId, setVariantId] = useState<string>(() => {
    const first = product?.variants.find((v) => v.available > 0) ?? product?.variants[0];
    return first?.id ?? "";
  });
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);

  // Reset selection when navigating between products.
  useEffect(() => {
    const first = product?.variants.find((v) => v.available > 0) ?? product?.variants[0];
    setVariantId(first?.id ?? "");
    setQty(1);
    setAdded(false);
  }, [product]);

  if (!product) {
    return (
      <section className="empty-state">
        <h1>Product not found</h1>
        <p>
          This product may no longer be available.{" "}
          <Link to={`/${slug}`}>Back to the shop</Link>
        </p>
      </section>
    );
  }

  const variant = product.variants.find((v) => v.id === variantId) ?? product.variants[0];
  const available = variant ? variant.available > 0 : false;
  const maxQty = variant ? Math.max(1, variant.available) : 1;

  function addToCart() {
    if (!variant || variant.available <= 0 || !product) return;
    cart.store.add(
      {
        variantId: variant.id,
        productSlug: product.slug,
        productName: product.name,
        sku: variant.sku,
        priceMinor: variant.priceMinor,
        currency: variant.currency,
      },
      qty,
    );
    setAdded(true);
  }

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to={`/${slug}`}>Shop</Link> <span aria-hidden="true">/</span> {product.name}
      </nav>

      <article className="product-detail">
        <div className="product-hero" aria-hidden="true">
          {product.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="product-info">
          <h1>{product.name}</h1>
          {product.description && <p className="product-desc">{product.description}</p>}

          {product.variants.length === 0 ? (
            <p className="status-note">This product is not currently orderable.</p>
          ) : (
            <>
              {product.variants.length > 1 && (
                <fieldset className="variant-picker">
                  <legend>Choose an option</legend>
                  {product.variants.map((v) => (
                    <label key={v.id} className={`variant-option${v.id === variantId ? " selected" : ""}`}>
                      <input
                        type="radio"
                        name="variant"
                        value={v.id}
                        checked={v.id === variantId}
                        onChange={() => {
                          setVariantId(v.id);
                          setQty(1);
                          setAdded(false);
                        }}
                      />
                      <span className="variant-sku">{v.sku}</span>
                      <span className="variant-price">{formatMinor(v.priceMinor, v.currency)}</span>
                      <span className={v.available > 0 ? "badge badge-in" : "badge badge-out"}>
                        {v.available > 0 ? "In stock" : "Out of stock"}
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}

              {variant && (
                <>
                  <div className="product-meta">
                    <span className="price price-lg">{formatMinor(variant.priceMinor, variant.currency)}</span>
                    <span className={available ? "badge badge-in" : "badge badge-out"}>
                      {available ? "In stock" : "Out of stock"}
                    </span>
                  </div>
                  <p className="vat-note">Price includes 5% VAT.</p>
                  {product.variants.length === 1 && (
                    <p className="variant-sku">SKU {variant.sku}</p>
                  )}

                  <div className="add-row">
                    <label htmlFor="qty">Qty</label>
                    <input
                      id="qty"
                      type="number"
                      min={1}
                      max={maxQty}
                      value={qty}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        setQty(Number.isFinite(n) ? Math.min(maxQty, Math.max(1, Math.floor(n))) : 1);
                      }}
                      disabled={!available}
                    />
                    <button type="button" className="primary" onClick={addToCart} disabled={!available}>
                      {available ? "Add to cart" : "Out of stock"}
                    </button>
                  </div>
                  {added && (
                    <p className="status-note success" role="status">
                      Added to cart. <Link to={`/${slug}/cart`}>View cart</Link>
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </article>
    </>
  );
}
