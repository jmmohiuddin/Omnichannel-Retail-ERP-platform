import { useState, type FormEvent } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import type { StoreContext } from "../App.js";
import {
  ApiError,
  requestCustomerLink,
  verifyCustomerLink,
} from "../lib/api.js";
import { useCustomerSession } from "../lib/customerSession.js";
import { t, type MessageKey } from "../lib/i18n.js";
import { useLang } from "../lib/useLang.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Two-step passwordless sign-in.
 *   1. "email" — shopper types their email; we request a link.
 *   2. "code"  — shopper pastes the code we (dev only) show inline; we verify.
 * On success we store the session and bounce them to /:slug/account/orders.
 */
export function AccountSignInPage() {
  const { slug } = useOutletContext<StoreContext>();
  const { lang } = useLang();
  const navigate = useNavigate();
  const account = useCustomerSession(slug);

  const [stage, setStage] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [devToken, setDevToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);

  async function onRequestLink(e: FormEvent) {
    e.preventDefault();
    setErrorKey(null);
    const trimmed = email.trim();
    if (trimmed.length === 0) {
      setErrorKey("account.error.emailRequired");
      return;
    }
    if (!EMAIL_RE.test(trimmed)) {
      setErrorKey("account.error.emailInvalid");
      return;
    }
    setBusy(true);
    try {
      const result = await requestCustomerLink(slug, trimmed);
      setDevToken(result.devToken ?? null);
      setToken(result.devToken ?? "");
      setStage("code");
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        setErrorKey("account.error.storeGone");
      } else {
        setErrorKey("account.error.requestFailed");
      }
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(e: FormEvent) {
    e.preventDefault();
    setErrorKey(null);
    const trimmedToken = token.trim();
    if (trimmedToken.length === 0) {
      setErrorKey("account.error.tokenRequired");
      return;
    }
    setBusy(true);
    try {
      const result = await verifyCustomerLink(slug, email.trim(), trimmedToken);
      account.signIn({ sessionToken: result.sessionToken, customer: result.customer });
      navigate(`/${slug}/account/orders`, { replace: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.code === "LINK_CONSUMED") {
          setErrorKey("account.error.consumedCode");
        } else if (err.code === "LINK_EXPIRED") {
          setErrorKey("account.error.expiredCode");
        } else if (err.code === "INVALID_LINK") {
          setErrorKey("account.error.invalidCode");
        } else {
          setErrorKey("account.error.verifyFailed");
        }
      } else {
        setErrorKey("account.error.verifyFailed");
      }
    } finally {
      setBusy(false);
    }
  }

  function useDifferentEmail() {
    setStage("email");
    setToken("");
    setDevToken(null);
    setErrorKey(null);
  }

  return (
    <section className="checkout-form" aria-label={t(lang, "account.signIn")}>
      <h1>{t(lang, "account.signIn")}</h1>

      {stage === "email" && (
        <form onSubmit={onRequestLink} noValidate>
          <div className="field">
            <label htmlFor="acc-email">{t(lang, "account.emailLabel")}</label>
            <input
              id="acc-email"
              type="email"
              autoComplete="email"
              placeholder={t(lang, "account.emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {errorKey && (
            <div className="alert" role="alert">
              <p>{t(lang, errorKey)}</p>
            </div>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? t(lang, "account.sendingLink") : t(lang, "account.sendLink")}
          </button>
        </form>
      )}

      {stage === "code" && (
        <form onSubmit={onVerify} noValidate>
          <p className="status-note">{t(lang, "account.linkSent", { email })}</p>
          {devToken && (
            <div className="alert info" role="status">
              <p>
                <strong>{t(lang, "account.devTokenLabel")}:</strong>{" "}
                <code>{devToken}</code>
              </p>
              <p>{t(lang, "account.devTokenNotice")}</p>
            </div>
          )}
          <div className="field">
            <label htmlFor="acc-token">{t(lang, "account.enterCode")}</label>
            <input
              id="acc-token"
              type="text"
              autoComplete="one-time-code"
              placeholder={t(lang, "account.codePlaceholder")}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          {errorKey && (
            <div className="alert" role="alert">
              <p>{t(lang, errorKey)}</p>
            </div>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? t(lang, "account.verifying") : t(lang, "account.verify")}
          </button>
          <p>
            <button
              type="button"
              className="button-like secondary"
              onClick={useDifferentEmail}
              disabled={busy}
            >
              {t(lang, "account.useDifferentEmail")}
            </button>
          </p>
        </form>
      )}

      <p>
        <Link to={`/${slug}`} className="button-like secondary">
          {t(lang, "product.backToShop")}
        </Link>
      </p>
    </section>
  );
}
