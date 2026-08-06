import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { apiErrorMessage, type ApiClient, type CustomerSummary } from "../lib/api.js";
import type { CustomerPanelAction, CustomerPanelState } from "../lib/customer.js";
import { formatMinor } from "../lib/money.js";
import { useLang } from "./LangProvider.js";

interface Props {
  api: ApiClient;
  state: CustomerPanelState;
  dispatch: (action: CustomerPanelAction) => void;
  /** Called after attach/detach so the caller can refocus the scan input. */
  onSettled: () => void;
}

const SEARCH_DEBOUNCE_MS = 250;

/**
 * Customer attach panel above the totals: search by phone or name, attach one
 * customer (chip with name + points), or quick-create when nobody matches.
 * Keyboard-first: Enter in the search field attaches the first result.
 */
export function CustomerPanel({ api, state, dispatch, onSettled }: Props) {
  const { t } = useLang();
  const [phone, setPhone] = useState("");
  const [creating, setCreating] = useState(false);
  // Server-authored message, or null; empty string = localized fallback.
  const [createError, setCreateError] = useState<string | null>(null);

  const query = state.query;

  // Debounced customer search, mirroring the product search above it.
  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) return;
    const t = setTimeout(() => {
      api
        .searchCustomers(q)
        .then((res) => dispatch({ type: "results", items: res.items }))
        .catch(() => dispatch({ type: "search-failed" }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [api, dispatch, query]);

  function attach(customer: CustomerSummary) {
    dispatch({ type: "attach", customer });
    setPhone("");
    setCreateError(null);
    onSettled();
  }

  async function create() {
    const fullName = query.trim();
    if (fullName.length === 0 || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const trimmedPhone = phone.trim();
      const customer = await api.createCustomer({
        fullName,
        ...(trimmedPhone.length > 0 ? { phone: trimmedPhone } : {}),
      });
      attach(customer);
    } catch (err) {
      setCreateError(apiErrorMessage(err, ""));
    } finally {
      setCreating(false);
    }
  }

  function handleSearchKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const first = state.results[0];
    if (first) attach(first);
  }

  if (state.attached) {
    return (
      <section className="customer-panel" aria-label={t("customer.sectionAria")}>
        <div className="customer-chip">
          <span className="customer-chip-name">{state.attached.fullName}</span>
          <span className="muted customer-chip-points">
            {state.loyalty
              ? t("customer.pointsWorth", {
                  points: state.loyalty.points,
                  value: formatMinor(state.loyalty.valueMinor),
                })
              : t("customer.points", { points: state.attached.loyaltyPoints })}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            aria-label={t("customer.detachAria", { name: state.attached.fullName })}
            onClick={() => {
              dispatch({ type: "detach" });
              onSettled();
            }}
          >
            ✕
          </button>
        </div>
      </section>
    );
  }

  const q = query.trim();
  return (
    <section className="customer-panel" aria-label={t("customer.sectionAria")}>
      <input
        className="search-input customer-search"
        value={query}
        onChange={(e) => dispatch({ type: "query", query: e.target.value })}
        onKeyDown={handleSearchKeyDown}
        placeholder={t("customer.searchPlaceholder")}
        autoComplete="off"
        aria-label={t("customer.searchAria")}
      />
      {q.length > 0 && (
        <div className="customer-results" role="listbox" aria-label={t("customer.resultsAria")}>
          {state.searching && <p className="muted result-hint">{t("search.searching")}</p>}
          {!state.searching && state.results.length === 0 && (
            <p className="muted result-hint">{t("customer.noneFound")}</p>
          )}
          {state.results.map((c) => (
            <button type="button" key={c.id} className="result-row" onClick={() => attach(c)}>
              <span className="result-name">
                {c.fullName}
                {c.phone && <span className="muted result-sku"> {c.phone}</span>}
              </span>
              <span className="muted mono">{t("customer.pts", { points: c.loyaltyPoints })}</span>
            </button>
          ))}
          <div className="customer-create-row">
            <input
              className="search-input customer-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={t("customer.phonePlaceholder")}
              autoComplete="off"
              aria-label={t("customer.newPhoneAria")}
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={creating}
              onClick={() => void create()}
            >
              {creating ? t("customer.creating") : t("customer.create", { name: q })}
            </button>
          </div>
          {createError !== null && (
            <p className="error-text" role="alert">
              {createError.length > 0 ? createError : t("customer.createFailed")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
