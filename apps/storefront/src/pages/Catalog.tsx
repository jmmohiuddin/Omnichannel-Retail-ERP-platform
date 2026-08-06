import { useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import type { StoreContext } from "../App.js";
import type { CatalogItem } from "../lib/api.js";
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

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return catalog.items;
    return catalog.items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        (item.description ?? "").toLowerCase().includes(q) ||
        item.variants.some((v) => v.sku.toLowerCase().includes(q)),
    );
  }, [catalog.items, query]);

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

      {catalog.items.length === 0 && (
        <section className="empty-state">
          <p>{t(lang, "catalog.empty")}</p>
        </section>
      )}

      {catalog.items.length > 0 && items.length === 0 && (
        <section className="empty-state">
          <p>{t(lang, "catalog.noMatches", { query: query.trim() })}</p>
        </section>
      )}

      <ul className="product-grid">
        {items.map((item) => {
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
