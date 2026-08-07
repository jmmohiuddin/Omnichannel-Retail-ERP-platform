import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet, Route, Routes, useParams } from "react-router-dom";
import { ApiError, fetchCatalog, type Catalog } from "./lib/api.js";
import { useCustomerSession } from "./lib/customerSession.js";
import { t, type MessageKey } from "./lib/i18n.js";
import { useCart } from "./lib/useCart.js";
import { useLang } from "./lib/useLang.js";
import { AccountDevicesPage } from "./pages/AccountDevices.js";
import { AccountOrdersPage } from "./pages/AccountOrders.js";
import { AccountSignInPage } from "./pages/AccountSignIn.js";
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
  const { lang, setLang } = useLang();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  // Error kind (not prose) so the message re-renders in the active language.
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const [loading, setLoading] = useState(true);
  const cart = useCart(slug);
  const account = useCustomerSession(slug);

  const reloadCatalog = useCallback(async (): Promise<Catalog> => {
    const next = await fetchCatalog(slug);
    setCatalog(next);
    return next;
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorKey(null);
    setCatalog(null);
    fetchCatalog(slug)
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setErrorKey("layout.storeNotFound");
        } else {
          setErrorKey("layout.storeUnavailable");
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
            {t(lang, "layout.shop")}
          </NavLink>
          <NavLink to={`/${slug}/cart`} className="cart-link">
            {t(lang, "layout.cart")}
            {cart.count > 0 && (
              <span
                className="cart-badge"
                aria-label={t(lang, "layout.cartBadge", { count: cart.count })}
              >
                {cart.count}
              </span>
            )}
          </NavLink>
          {account.session ? (
            <>
              <NavLink to={`/${slug}/account/orders`}>
                {t(lang, "account.myOrders")}
              </NavLink>
              <NavLink to={`/${slug}/account/devices`}>
                {t(lang, "account.myDevices")}
              </NavLink>
              <button
                type="button"
                className="lang-toggle"
                onClick={account.signOut}
              >
                {t(lang, "account.signOut")}
              </button>
            </>
          ) : (
            <NavLink to={`/${slug}/account/sign-in`}>
              {t(lang, "account.signIn")}
            </NavLink>
          )}
          <button
            type="button"
            className="lang-toggle"
            aria-label={t(lang, "layout.langToggle")}
            // The toggle names the *other* language, in that language.
            lang={lang === "en" ? "ar" : "en"}
            onClick={() => setLang(lang === "en" ? "ar" : "en")}
          >
            {lang === "en" ? "عربي" : "EN"}
          </button>
        </nav>
      </header>
      <main className="store-page">
        {loading && <p className="status-note">{t(lang, "layout.loading")}</p>}
        {!loading && errorKey && (
          <section className="empty-state">
            <h1>{t(lang, "layout.storeNotAvailable")}</h1>
            <p>{t(lang, errorKey, { slug })}</p>
          </section>
        )}
        {!loading && !errorKey && catalog && (
          <Outlet context={{ slug, catalog, reloadCatalog } satisfies StoreContext} />
        )}
      </main>
      <footer className="store-footer">
        <p>{t(lang, "layout.footer")}</p>
      </footer>
    </div>
  );
}

function NoStore() {
  const { lang } = useLang();
  return (
    <main className="store-page">
      <section className="empty-state">
        <h1>{t(lang, "layout.landingTitle")}</h1>
        <p>
          {t(lang, "layout.landingBody")} <code>/your-store-name</code>.
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
        <Route path="account/sign-in" element={<AccountSignInPage />} />
        <Route path="account/orders" element={<AccountOrdersPage />} />
        <Route path="account/devices" element={<AccountDevicesPage />} />
      </Route>
    </Routes>
  );
}
