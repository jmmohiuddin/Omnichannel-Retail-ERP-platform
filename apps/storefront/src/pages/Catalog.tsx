import { useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import type { StoreContext } from "../App.js";
import { fetchCatalog, type CatalogItem } from "../lib/api.js";
import { t } from "../lib/i18n.js";
import { formatMinor } from "../lib/money.js";
import { useLang } from "../lib/useLang.js";

function fromPriceMinor(item: CatalogItem): number | null {
  if (item.variants.length === 0) return null;
  return Math.min(...item.variants.map((v) => v.priceMinor));
}

function inStock(item: CatalogItem): boolean {
  return item.variants.some((v) => v.available > 0);
}

export function CatalogPage() {
  const { slug, catalog } = useOutletContext<StoreContext>();
  const { lang } = useLang();
  const [query, setQuery] = useState("");
  // The layout fetches the catalog once (no language). Re-fetch here when the
  // shopper switches to Arabic so the API-side overlay swaps in translated
  // names/descriptions; English keeps the layout's fetch to avoid a duplicate.
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
        // Non-fatal: keep the base (English) items so the page still renders.
      });
    return () => {
      cancelled = true;
    };
  }, [slug, lang, catalog.items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return items;
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        (item.description ?? "").toLowerCase().includes(q) ||
        item.variants.some((v) => v.sku.toLowerCase().includes(q)),
    );
  }, [items, query]);

  return (
    <>
      <div className="page-head">
        <h1>{catalog.tenant.name}</h1>
        <div className="search-box">
          <label htmlFor="catalog-search" className="visually-hidden">
            {t(lang, "catalog.searchLabel")}
          </label>
          <input
            id="catalog-search"
            type="search"
            placeholder={t(lang, "catalog.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {items.length === 0 && (
        <section className="empty-state">
          <p>{t(lang, "catalog.empty")}</p>
        </section>
      )}

      {items.length > 0 && filtered.length === 0 && (
        <section className="empty-state">
          <p>{t(lang, "catalog.noMatches", { query: query.trim() })}</p>
        </section>
      )}

      <ul className="product-grid">
        {filtered.map((item) => {
          const price = fromPriceMinor(item);
          const currency = item.variants[0]?.currency ?? catalog.tenant.currency;
          const available = inStock(item);
          return (
            <li key={item.productId} className="product-card">
              <Link to={`/${slug}/product/${item.slug}`}>
                <div className="product-thumb" aria-hidden="true">
                  {item.name.slice(0, 1).toUpperCase()}
                </div>
                <h2>{item.name}</h2>
                {item.description && <p className="product-desc">{item.description}</p>}
                <div className="product-meta">
                  <span className="price">
                    {price === null ? "—" : (
                      <>
                        {item.variants.length > 1 && (
                          <span className="price-from">{t(lang, "catalog.from")} </span>
                        )}
                        {formatMinor(price, currency)}
                      </>
                    )}
                  </span>
                  <span className={available ? "badge badge-in" : "badge badge-out"}>
                    {available ? t(lang, "catalog.inStock") : t(lang, "catalog.outOfStock")}
                  </span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}
