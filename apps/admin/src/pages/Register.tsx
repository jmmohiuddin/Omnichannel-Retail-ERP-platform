import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { registerTenant } from "../lib/auth.js";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function RegisterPage() {
  const navigate = useNavigate();
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
      setError(err instanceof Error ? err.message : "Registration failed");
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
          <p className="subtle">Set up a new tenant</p>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="reg-tenant">Business name</label>
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
            <label htmlFor="reg-slug">Tenant slug</label>
            <input
              id="reg-slug"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              pattern="[a-z0-9-]{2,40}"
              title="Lowercase letters, digits and hyphens (2–40 chars)"
              required
            />
            <span className="faint">Used to sign in: lowercase letters, digits, hyphens.</span>
          </div>
          <div className="field">
            <label htmlFor="reg-name">Your full name</label>
            <input
              id="reg-name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              autoComplete="name"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="reg-email">Email</label>
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
            <label htmlFor="reg-password">Password</label>
            <input
              id="reg-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={10}
              required
            />
            <span className="faint">At least 10 characters.</span>
          </div>
          <button type="submit" disabled={busy}>
            {busy ? "Creating tenant…" : "Create tenant"}
          </button>
        </form>
        <p className="subtle">
          Already registered? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
