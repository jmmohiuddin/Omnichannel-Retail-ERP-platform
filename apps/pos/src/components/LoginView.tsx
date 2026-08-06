import { useState, type FormEvent } from "react";
import { ApiError, isNetworkError, type ApiClient } from "../lib/api.js";
import type { StoredSession } from "../lib/session.js";

interface Props {
  api: ApiClient;
  onLoggedIn: (session: StoredSession) => void;
}

export function LoginView({ api, onLoggedIn }: Props) {
  const [slug, setSlug] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.login({ slug: slug.trim(), email: email.trim(), password });
      onLoggedIn({ ...res, slug: slug.trim(), email: email.trim() });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.status === 401 ? "Invalid store, email or password." : `Login failed (HTTP ${err.status}).`);
      } else if (isNetworkError(err)) {
        setError("Cannot reach the server. Check the connection and try again.");
      } else {
        setError("Login failed unexpectedly.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="centered-screen">
      <form className="panel login-panel" onSubmit={handleSubmit}>
        <h1 className="brand">OmniRetail POS</h1>
        <p className="muted">Sign in to this register</p>

        <label className="field">
          <span>Store slug</span>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            autoComplete="organization"
            autoFocus
            required
            placeholder="deira-phones"
          />
        </label>

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            placeholder="cashier@example.com"
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
