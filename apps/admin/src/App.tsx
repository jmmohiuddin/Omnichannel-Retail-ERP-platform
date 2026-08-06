import { useSyncExternalStore } from "react";
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { getSession, signOut, subscribe, type Session } from "./lib/auth.js";
import { toggleLang } from "./lib/langStore.js";
import { useT } from "./lib/useT.js";
import { LoginPage } from "./pages/Login.js";
import { RegisterPage } from "./pages/Register.js";
import { DashboardPage } from "./pages/Dashboard.js";
import { CatalogPage } from "./pages/Catalog.js";
import { InventoryPage } from "./pages/Inventory.js";
import { VariantDetailPage } from "./pages/VariantDetail.js";
import { AuditPage } from "./pages/Audit.js";
import { ApprovalsPage } from "./pages/Approvals.js";
import { OrdersPage } from "./pages/Orders.js";
import { FinancePage } from "./pages/Finance.js";
import { DigestPage } from "./pages/Digest.js";

function useSession(): Session | null {
  return useSyncExternalStore(subscribe, getSession, getSession);
}

/** Header EN / عربي switch — the active language is emphasized. */
export function LangToggle() {
  const { lang, t } = useT();
  return (
    <button
      type="button"
      className="secondary"
      aria-label={t("nav.language")}
      onClick={() => toggleLang()}
    >
      <span style={{ fontWeight: lang === "en" ? 700 : 400 }}>EN</span>
      {" / "}
      <span style={{ fontWeight: lang === "ar" ? 700 : 400 }}>عربي</span>
    </button>
  );
}

function Shell({ session }: { session: Session }) {
  const { t } = useT();
  return (
    <>
      <header className="topnav">
        <div className="brand">
          OmniRetail <span>OS</span>
        </div>
        <nav aria-label={t("nav.primary")}>
          <NavLink to="/" end>
            {t("nav.dashboard")}
          </NavLink>
          <NavLink to="/catalog">{t("nav.catalog")}</NavLink>
          <NavLink to="/inventory">{t("nav.inventory")}</NavLink>
          <NavLink to="/orders">{t("nav.orders")}</NavLink>
          <NavLink to="/approvals">{t("nav.approvals")}</NavLink>
          <NavLink to="/finance">{t("nav.finance")}</NavLink>
          <NavLink to="/digest">{t("nav.digest")}</NavLink>
          <NavLink to="/audit">{t("nav.audit")}</NavLink>
        </nav>
        <div className="session">
          <span className="tenant-chip" title={t("nav.tenantTitle", { id: session.tenantId })}>
            {session.slug}
          </span>
          <LangToggle />
          <button type="button" className="secondary" onClick={() => signOut()}>
            {t("nav.signOut")}
          </button>
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </>
  );
}

export function App() {
  const session = useSession();
  const location = useLocation();

  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname }} />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Shell session={session} />}>
        <Route index element={<DashboardPage />} />
        <Route path="/catalog" element={<CatalogPage />} />
        <Route path="/inventory" element={<InventoryPage />} />
        <Route path="/inventory/:variantId" element={<VariantDetailPage />} />
        <Route path="/orders" element={<OrdersPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/finance" element={<FinancePage />} />
        <Route path="/digest" element={<DigestPage />} />
        <Route path="/audit" element={<AuditPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
