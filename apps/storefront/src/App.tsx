import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet, Route, Routes, useParams } from "react-router-dom";
import { ApiError, fetchCatalog, type Catalog } from "./lib/api.js";
import { useCart } from "./lib/useCart.js";
import { CartPage } from "./pages/Cart.js";
import { CatalogPage } from "./pages/Catalog.js";
import { CheckoutPage } from "./pages/Checkout.js";
import { ConfirmationPage } from "./pages/Confirmation.js";
import { ProductPage } from "./pages/Product.js";

/** Shared context passed to store pages via <Outlet />. */
export interface StoreContext {
  slug: string;
  catalog: Catalog;
  reloadCatalog: () => Promise<Catalog>;
}

function StoreLayout() {
  const { slug = "" } = useParams();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const cart = useCart(slug);

  const reloadCatalog = useCallback(async (): Promise<Catalog> => {
    const next = await fetchCatalog(slug);
    setCatalog(next);
    return next;
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCatalog(null);
    fetchCatalog(slug)
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setError(`We couldn't find a store called “${slug}”.`);
        } else {
          setError("The store is temporarily unavailable. Please try again shortly.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <div className="store">
      <header className="store-header">
        <Link to={`/${slug}`} className="store-brand">
          {catalog?.tenant.name ?? slug}
        </Link>
        <nav aria-label="Store">
          <NavLink to={`/${slug}`} end>
            Shop
          </NavLink>
          <NavLink to={`/${slug}/cart`} className="cart-link">
            Cart
            {cart.count > 0 && (
              <span className="cart-badge" aria-label={`${cart.count} items in cart`}>
                {cart.count}
              </span>
            )}
          </NavLink>
        </nav>
      </header>
      <main className="store-page">
        {loading && <p className="status-note">Loading store…</p>}
        {!loading && error && (
          <section className="empty-state">
            <h1>Store not available</h1>
            <p>{error}</p>
          </section>
        )}
        {!loading && !error && catalog && (
          <Outlet context={{ slug, catalog, reloadCatalog } satisfies StoreContext} />
        )}
      </main>
      <footer className="store-footer">
        <p>All prices include 5% VAT. Powered by OmniRetail OS.</p>
      </footer>
    </div>
  );
}

function NoStore() {
  return (
    <main className="store-page">
      <section className="empty-state">
        <h1>OmniRetail OS storefront</h1>
        <p>
          Open a store by its address, e.g. <code>/your-store-name</code>.
        </p>
      </section>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<NoStore />} />
      <Route path="/:slug" element={<StoreLayout />}>
        <Route index element={<CatalogPage />} />
        <Route path="product/:productSlug" element={<ProductPage />} />
        <Route path="cart" element={<CartPage />} />
        <Route path="checkout" element={<CheckoutPage />} />
        <Route path="order/:orderNo" element={<ConfirmationPage />} />
      </Route>
    </Routes>
  );
}
