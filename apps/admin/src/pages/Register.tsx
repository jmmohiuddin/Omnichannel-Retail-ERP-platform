import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { registerTenant } from "../lib/auth.js";
import { useT } from "../lib/useT.js";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function RegisterPage() {
  const navigate = useNavigate();
  const { t } = useT();
  const [tenantName, setTenantName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function onTenantNameChange(value: string) {
    setTenantName(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await registerTenant({
        tenantName: tenantName.trim(),
        slug: slug.trim(),
        fullName: fullName.trim(),
        email: email.trim(),
        password,
      });
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("register.failed"));
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
          <p className="subtle">{t("register.subtitle")}</p>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="reg-tenant">{t("register.businessName")}</label>
            <input
              id="reg-tenant"
              value={tenantName}
              onChange={(e) => onTenantNameChange(e.target.value)}
              placeholder="Deira Mobiles LLC"
              required
              minLength={2}
            />
          </div>
          <div className="field">
            <label htmlFor="reg-slug">{t("login.slug")}</label>
            <input
              id="reg-slug"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              pattern="[a-z0-9-]{2,40}"
              title={t("register.slugPattern")}
              required
            />
            <span className="faint">{t("register.slugHint")}</span>
          </div>
          <div className="field">
            <label htmlFor="reg-name">{t("register.fullName")}</label>
            <input
              id="reg-name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              autoComplete="name"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="reg-email">{t("login.email")}</label>
            <input
              id="reg-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="reg-password">{t("login.password")}</label>
            <input
              id="reg-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={10}
              required
            />
            <span className="faint">{t("register.passwordHint")}</span>
          </div>
          <button type="submit" disabled={busy}>
            {busy ? t("register.submitting") : t("register.submit")}
          </button>
        </form>
        <p className="subtle">
          {t("register.already")} <Link to="/login">{t("login.submit")}</Link>
        </p>
      </div>
    </div>
  );
}
