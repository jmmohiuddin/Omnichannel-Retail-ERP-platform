import { useState, type FormEvent } from "react";
import { ApiError, isNetworkError, type ApiClient } from "../lib/api.js";
import type { MessageKey, MessageParams } from "../lib/i18n.js";
import type { StoredSession } from "../lib/session.js";
import { LangToggle, useLang } from "./LangProvider.js";

interface Props {
  api: ApiClient;
  onLoggedIn: (session: StoredSession) => void;
}

/** Errors are stored as keys so they re-render when the language flips. */
type LoginError = { key: MessageKey; params?: MessageParams };

export function LoginView({ api, onLoggedIn }: Props) {
  const { t } = useLang();
  const [slug, setSlug] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LoginError | null>(null);

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
        setError(
          err.status === 401
            ? { key: "login.invalidCredentials" }
            : { key: "login.failedHttp", params: { status: err.status } },
        );
      } else if (isNetworkError(err)) {
        setError({ key: "login.network" });
      } else {
        setError({ key: "login.failedUnexpected" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="centered-screen">
      <form className="panel login-panel" onSubmit={handleSubmit}>
        <div className="panel-lang-row">
          <LangToggle />
        </div>
        <h1 className="brand">OmniRetail POS</h1>
        <p className="muted">{t("login.subtitle")}</p>

        <label className="field">
          <span>{t("login.storeSlug")}</span>
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
          <span>{t("login.email")}</span>
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
          <span>{t("login.password")}</span>
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
            {t(error.key, error.params)}
          </p>
        )}

        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? t("login.signingIn") : t("login.signIn")}
        </button>
      </form>
    </main>
  );
}
