import { useSyncExternalStore } from "react";
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { getSession, signOut, subscribe, type Session } from "./lib/auth.js";
import { LoginPage } from "./pages/Login.js";
import { RegisterPage } from "./pages/Register.js";
import { DashboardPage } from "./pages/Dashboard.js";
import { CatalogPage } from "./pages/Catalog.js";
import { InventoryPage } from "./pages/Inventory.js";
import { VariantDetailPage } from "./pages/VariantDetail.js";
import { AuditPage } from "./pages/Audit.js";

function useSession(): Session | null {
  return useSyncExternalStore(subscribe, getSession, getSession);
}

function Shell({ session }: { session: Session }) {
  return (
    <>
      <header className="topnav">
        <div className="brand">
          OmniRetail <span>OS</span>
        </div>
        <nav aria-label="Primary">
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/catalog">Catalog</NavLink>
          <NavLink to="/inventory">Inventory</NavLink>
          <NavLink to="/audit">Audit</NavLink>
        </nav>
        <div className="session">
          <span className="tenant-chip" title={`Tenant ${session.tenantId}`}>
            {session.slug}
          </span>
          <button type="button" className="secondary" onClick={() => signOut()}>
            Sign out
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
        <Route path="/audit" element={<AuditPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
