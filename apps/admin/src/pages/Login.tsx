import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { login } from "../lib/auth.js";

export function LoginPage() {
  const navigate = useNavigate();
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
      setError(err instanceof Error ? err.message : "Sign-in failed");
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
          <p className="subtle">Sign in to your admin portal</p>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="login-slug">Tenant slug</label>
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
            <label htmlFor="login-email">Email</label>
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
            <label htmlFor="login-password">Password</label>
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
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="subtle">
          New business? <Link to="/register">Create a tenant</Link>
        </p>
      </div>
    </div>
  );
}
