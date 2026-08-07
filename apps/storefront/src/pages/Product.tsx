import { useEffect, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import type { StoreContext } from "../App.js";
import { fetchCatalog, type CatalogItem } from "../lib/api.js";
import { t } from "../lib/i18n.js";
import { formatMinor } from "../lib/money.js";
import { useCart } from "../lib/useCart.js";
import { useLang } from "../lib/useLang.js";

export function ProductPage() {
  const { slug, catalog } = useOutletContext<StoreContext>();
  const { productSlug = "" } = useParams();
  const { lang } = useLang();
  const cart = useCart(slug);

  // Language overlay: when the shopper is in Arabic, re-fetch the catalog so
  // the API can return translated name/description for this product. Falls
  // back to the layout's (English) items on failure or before the fetch lands.
  const [items, setItems] = useState<CatalogItem[]>(catalog.items);
  useEffect(() => {
    if (lang === "en") {
      setItems(catalog.items);
      return;
    }
    let cancelled = false;
    fetchCatalog(slug, lang)
      .then((next) => {
        if (!cancelled) setItems(next.items);
      })
      .catch(() => {
        /* keep the base items */
      });
    return () => {
      cancelled = true;
    };
  }, [slug, lang, catalog.items]);

  const product = items.find((item) => item.slug === productSlug);
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
        <h1>{t(lang, "product.notFoundTitle")}</h1>
        <p>
          {t(lang, "product.notFoundBody")}{" "}
          <Link to={`/${slug}`}>{t(lang, "product.backToShop")}</Link>
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
      <nav className="breadcrumb" aria-label={t(lang, "product.breadcrumbLabel")}>
        <Link to={`/${slug}`}>{t(lang, "layout.shop")}</Link> <span aria-hidden="true">/</span>{" "}
        {product.name}
      </nav>

      <article className="product-detail">
        <div className="product-hero" aria-hidden="true">
          {product.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="product-info">
          <h1>{product.name}</h1>
          {product.description && <p className="product-desc">{product.description}</p>}

          {product.variants.length === 0 ? (
            <p className="status-note">{t(lang, "product.notOrderable")}</p>
          ) : (
            <>
              {product.variants.length > 1 && (
                <fieldset className="variant-picker">
                  <legend>{t(lang, "product.chooseOption")}</legend>
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
                        {v.available > 0 ? t(lang, "catalog.inStock") : t(lang, "catalog.outOfStock")}
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
                      {available ? t(lang, "catalog.inStock") : t(lang, "catalog.outOfStock")}
                    </span>
                  </div>
                  <p className="vat-note">{t(lang, "product.vatNote")}</p>
                  {product.variants.length === 1 && (
                    <p className="variant-sku">{t(lang, "product.sku", { sku: variant.sku })}</p>
                  )}

                  <div className="add-row">
                    <label htmlFor="qty">{t(lang, "product.qty")}</label>
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
                      {available ? t(lang, "product.addToCart") : t(lang, "catalog.outOfStock")}
                    </button>
                  </div>
                  {added && (
                    <p className="status-note success" role="status">
                      {t(lang, "product.added")}{" "}
                      <Link to={`/${slug}/cart`}>{t(lang, "product.viewCart")}</Link>
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
