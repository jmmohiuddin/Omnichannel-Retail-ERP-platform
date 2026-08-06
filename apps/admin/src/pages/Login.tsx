import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { login } from "../lib/auth.js";
import { useT } from "../lib/useT.js";

export function LoginPage() {
  const navigate = useNavigate();
  const { t } = useT();
  const [slug, setSlug] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(slug.trim(), email.trim(), password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("login.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div>
          <div className="brand" style={{ fontWeight: 700, fontSize: 18 }}>
            OmniRetail <span style={{ color: "var(--color-primary)" }}>OS</span>
          </div>
          <p className="subtle">{t("login.subtitle")}</p>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="login-slug">{t("login.slug")}</label>
            <input
              id="login-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="deira-mobiles"
              autoComplete="organization"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="login-email">{t("login.email")}</label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="login-password">{t("login.password")}</label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <button type="submit" disabled={busy}>
            {busy ? t("login.submitting") : t("login.submit")}
          </button>
        </form>
        <p className="subtle">
          {t("login.newBusiness")} <Link to="/register">{t("login.createTenant")}</Link>
        </p>
      </div>
    </div>
  );
}
