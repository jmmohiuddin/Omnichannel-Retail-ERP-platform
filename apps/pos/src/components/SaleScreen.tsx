import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ApiError,
  apiErrorCode,
  apiErrorMessage,
  isNetworkError,
  type ApiClient,
  type ProductSummary,
  type Receipt,
  type SalePayload,
  type TenderMethod,
  type VariantSummary,
} from "../lib/api.js";
import { cartReducer, cartTotals, hasStockUnit, lineTotalMinor, type CartLine } from "../lib/cart.js";
import { customerPanelReducer, initialCustomerPanelState } from "../lib/customer.js";
import { formatMinor } from "../lib/money.js";
import { loyaltyApplicableMinor, planPayments } from "../lib/payments.js";
import type { SaleQueue } from "../lib/saleQueue.js";
import { isImeiToken } from "../lib/scan.js";
import type { StoredLocation } from "../lib/session.js";
import { CustomerPanel } from "./CustomerPanel.js";
import { ReceiptModal, type CompletedSale } from "./ReceiptModal.js";

interface Props {
  api: ApiClient;
  queue: SaleQueue;
  deviceId: string;
  location: StoredLocation;
  cashierEmail: string;
  onSignOut: () => void;
}

const SEARCH_DEBOUNCE_MS = 250;

export function SaleScreen({ api, queue, deviceId, location, cashierEmail, onSignOut }: Props) {
  const [cart, dispatch] = useReducer(cartReducer, []);
  const totals = cartTotals(cart);
  const currency = cart[0]?.currency ?? "AED";

  const [barcode, setBarcode] = useState("");
  const [barcodeMiss, setBarcodeMiss] = useState<string | null>(null);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [tendering, setTendering] = useState<TenderMethod | null>(null);
  const [saleError, setSaleError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<CompletedSale | null>(null);

  const [customer, customerDispatch] = useReducer(customerPanelReducer, initialCustomerPanelState);
  const attachedCustomer = customer.attached;

  const barcodeRef = useRef<HTMLInputElement>(null);
  const focusScan = useCallback(() => barcodeRef.current?.focus(), []);

  /** Fetch (or re-fetch after INSUFFICIENT_POINTS) the loyalty balance. */
  const refreshLoyalty = useCallback(async () => {
    if (!attachedCustomer) return;
    try {
      const balance = await api.getLoyalty(attachedCustomer.id);
      customerDispatch({ type: "loyalty-loaded", balance });
    } catch {
      /* loyalty endpoint unavailable — the LOYALTY tender stays disabled */
    }
  }, [api, attachedCustomer]);

  useEffect(() => {
    void refreshLoyalty();
  }, [refreshLoyalty]);

  useEffect(() => queue.subscribe(setPendingCount), [queue]);

  // Debounced product search.
  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      api
        .searchProducts(q)
        .then((res) => setResults(res.items))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [api, query]);

  const addVariant = useCallback((product: ProductSummary, variant: VariantSummary) => {
    dispatch({
      type: "add",
      line: {
        variantId: variant.id,
        sku: variant.sku,
        name: product.variants.length > 1 ? `${product.name} (${variant.sku})` : product.name,
        unitPriceMinor: variant.priceMinor,
        currency: variant.currency,
      },
    });
  }, []);

  /**
   * Scan entry — scanners type the code and send Enter. An IMEI-shaped token
   * (15–16 digits, Luhn-valid) is looked up as a serialized stock unit first;
   * a 404 there falls through to the normal barcode/SKU lookup.
   */
  const handleScan = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const code = barcode.trim();
      if (code.length === 0) return;
      setBarcodeMiss(null);
      setScanNotice(null);
      if (isImeiToken(code)) {
        try {
          const unit = await api.getStockUnitByImei(code);
          if (unit.state !== "in_stock") {
            setScanNotice(`Unit is ${unit.state.replace(/_/g, " ")} — it cannot be sold.`);
            setBarcode("");
            return;
          }
          if (hasStockUnit(cart, unit.id)) {
            setScanNotice("Unit already in cart.");
            setBarcode("");
            return;
          }
          dispatch({
            type: "add",
            line: {
              variantId: unit.variantId,
              sku: unit.sku,
              name: unit.productName,
              unitPriceMinor: unit.priceMinor,
              currency: unit.currency,
              stockUnitId: unit.id,
              imei: unit.imei1 ?? code,
            },
          });
          setBarcode("");
          return;
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 404)) {
            setScanNotice("Unit lookup failed — check the connection and rescan.");
            return;
          }
          // 404: no unit carries this IMEI — fall through to product lookup.
        }
      }
      try {
        const { items } = await api.searchProducts(code);
        for (const product of items) {
          const variant = product.variants.find((v) => v.barcode === code || v.sku === code);
          if (variant) {
            addVariant(product, variant);
            setBarcode("");
            return;
          }
        }
        setBarcodeMiss(code);
      } catch {
        setBarcodeMiss(code);
      }
    },
    [api, barcode, cart, addVariant],
  );

  const handleResultKeyDown = useCallback(
    (e: ReactKeyboardEvent, product: ProductSummary, variant: VariantSummary) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addVariant(product, variant);
      }
    },
    [addVariant],
  );

  const tender = useCallback(
    async (method: TenderMethod) => {
      if (cart.length === 0 || tendering !== null) return;
      setTendering(method);
      setSaleError(null);
      const linesSnapshot: CartLine[] = cart.map((l) => ({ ...l }));
      const totalsSnapshot = cartTotals(linesSnapshot);
      const loyaltyValueMinor =
        customer.loyaltyApplied && customer.loyalty !== null ? customer.loyalty.valueMinor : 0;
      const payments = planPayments(totalsSnapshot.totalMinor, loyaltyValueMinor, method);
      const payload: SalePayload = {
        id: crypto.randomUUID(),
        deviceId,
        locationId: location.id,
        ...(customer.attached !== null ? { customerId: customer.attached.id } : {}),
        lines: linesSnapshot.map((l) => ({
          variantId: l.variantId,
          quantity: l.quantity,
          unitPriceMinor: l.unitPriceMinor,
          ...(l.stockUnitId !== undefined ? { stockUnitId: l.stockUnitId } : {}),
        })),
        payments,
      };
      try {
        const outcome = await queue.submit(payload);
        if (outcome.status === "queued") {
          setCompleted({
            mode: "offline",
            saleId: payload.id,
            totals: totalsSnapshot,
            lines: linesSnapshot,
            payments,
            currency: linesSnapshot[0]?.currency ?? "AED",
          });
          return;
        }
        let receipt: Receipt | null = null;
        try {
          receipt = await api.getReceipt(outcome.result.orderId);
        } catch {
          /* receipt endpoint unavailable — fall back to sale totals */
        }
        setCompleted({ mode: "online", sale: outcome.result, receipt, lines: linesSnapshot, payments });
      } catch (err) {
        if (err instanceof ApiError) {
          // Surface the server's own message (SERIALIZED_REQUIRED,
          // INSUFFICIENT_POINTS, …) when it sent one.
          setSaleError(
            apiErrorMessage(err, `Sale rejected by the server (HTTP ${err.status}). Nothing was charged.`),
          );
          if (apiErrorCode(err) === "INSUFFICIENT_POINTS") void refreshLoyalty();
        } else if (isNetworkError(err)) {
          setSaleError("Network error — the sale was not submitted.");
        } else {
          setSaleError("Sale failed unexpectedly.");
        }
      } finally {
        setTendering(null);
      }
    },
    [api, cart, customer, deviceId, location.id, queue, refreshLoyalty, tendering],
  );

  const newSale = useCallback(() => {
    setCompleted(null);
    dispatch({ type: "clear" });
    customerDispatch({ type: "reset" });
    setBarcode("");
    setBarcodeMiss(null);
    setScanNotice(null);
    setQuery("");
    setResults([]);
    setSaleError(null);
    barcodeRef.current?.focus();
  }, []);

  // Loyalty preview: what an armed LOYALTY tender would deduct right now.
  const loyaltyAppliedMinor = customer.loyaltyApplied
    ? loyaltyApplicableMinor(totals.totalMinor, customer.loyalty?.valueMinor ?? 0)
    : 0;
  const dueMinor = totals.totalMinor - loyaltyAppliedMinor;
  const loyaltyReady = customer.loyalty !== null && customer.loyalty.valueMinor > 0;

  return (
    <div className="pos-shell">
      <header className="pos-topbar">
        <span className="brand">OmniRetail POS</span>
        <span className="topbar-info">
          {location.name} · {cashierEmail}
        </span>
        <span className="topbar-spacer" />
        {pendingCount > 0 && (
          <span className="badge badge-pending" title="Sales saved offline, waiting to sync">
            {pendingCount} pending sync
          </span>
        )}
        <button type="button" className="btn btn-ghost btn-small" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      <div className="pos-body">
        <section className="pos-left" aria-label="Product search">
          <form className="scan-form" onSubmit={handleScan}>
            <input
              ref={barcodeRef}
              className="scan-input"
              value={barcode}
              onChange={(e) => {
                setBarcode(e.target.value);
                setBarcodeMiss(null);
              }}
              placeholder="Scan barcode or type SKU, then Enter"
              autoFocus
              inputMode="text"
              autoComplete="off"
              aria-label="Barcode"
            />
          </form>
          {barcodeMiss && (
            <p className="error-text" role="alert">
              No product matches “{barcodeMiss}”.
            </p>
          )}
          {scanNotice && (
            <p className="warn-text" role="alert">
              {scanNotice}
            </p>
          )}

          <input
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products by name…"
            autoComplete="off"
            aria-label="Product search"
          />

          <div className="search-results" role="listbox" aria-label="Search results">
            {searching && <p className="muted result-hint">Searching…</p>}
            {!searching && query.trim().length > 0 && results.length === 0 && (
              <p className="muted result-hint">No products found.</p>
            )}
            {results.flatMap((product) =>
              product.variants.map((variant) => (
                <button
                  type="button"
                  key={variant.id}
                  className="result-row"
                  onClick={() => addVariant(product, variant)}
                  onKeyDown={(e) => handleResultKeyDown(e, product, variant)}
                >
                  <span className="result-name">
                    {product.name}
                    <span className="muted result-sku"> {variant.sku}</span>
                  </span>
                  <span className="mono">{formatMinor(variant.priceMinor, variant.currency)}</span>
                </button>
              )),
            )}
          </div>
        </section>

        <section className="pos-right" aria-label="Cart">
          <div className="cart-lines">
            {cart.length === 0 && <p className="muted cart-empty">Cart is empty — scan an item to start.</p>}
            {cart.map((line) => (
              <div className="cart-line" key={line.stockUnitId ?? line.variantId}>
                <div className="cart-line-main">
                  <span className="cart-line-name">{line.name}</span>
                  {line.imei !== undefined && (
                    <span className="muted mono cart-line-imei">IMEI {line.imei}</span>
                  )}
                  <span className="muted">{formatMinor(line.unitPriceMinor, line.currency)} each</span>
                </div>
                {line.stockUnitId !== undefined ? (
                  /* Serialized unit — quantity is locked to exactly 1. */
                  <div className="qty-controls">
                    <span className="qty mono" aria-label={`Quantity of ${line.name} (serialized)`}>
                      1
                    </span>
                  </div>
                ) : (
                  <div className="qty-controls">
                    <button
                      type="button"
                      className="btn btn-qty"
                      aria-label={`Decrease quantity of ${line.name}`}
                      onClick={() => dispatch({ type: "decrement", variantId: line.variantId })}
                    >
                      −
                    </button>
                    <span className="qty mono">{line.quantity}</span>
                    <button
                      type="button"
                      className="btn btn-qty"
                      aria-label={`Increase quantity of ${line.name}`}
                      onClick={() => dispatch({ type: "increment", variantId: line.variantId })}
                    >
                      +
                    </button>
                  </div>
                )}
                <span className="cart-line-total mono">{formatMinor(lineTotalMinor(line), line.currency)}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  aria-label={`Remove ${line.name}`}
                  onClick={() =>
                    dispatch({
                      type: "remove",
                      variantId: line.variantId,
                      ...(line.stockUnitId !== undefined ? { stockUnitId: line.stockUnitId } : {}),
                    })
                  }
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <CustomerPanel api={api} state={customer} dispatch={customerDispatch} onSettled={focusScan} />

          <dl className="totals">
            <div>
              <dt>Subtotal (excl. VAT)</dt>
              <dd className="mono">{formatMinor(totals.subtotalMinor, currency)}</dd>
            </div>
            <div>
              <dt>VAT 5% (included)</dt>
              <dd className="mono">{formatMinor(totals.taxMinor, currency)}</dd>
            </div>
            <div className="grand-total">
              <dt>Total</dt>
              <dd className="mono">{formatMinor(totals.totalMinor, currency)}</dd>
            </div>
            {loyaltyAppliedMinor > 0 && (
              <>
                <div>
                  <dt>Loyalty points</dt>
                  <dd className="mono">−{formatMinor(loyaltyAppliedMinor, currency)}</dd>
                </div>
                <div>
                  <dt>Remaining due</dt>
                  <dd className="mono">{formatMinor(dueMinor, currency)}</dd>
                </div>
              </>
            )}
          </dl>

          {saleError && (
            <p className="error-text" role="alert">
              {saleError}
            </p>
          )}

          {attachedCustomer !== null && (
            <div className="loyalty-row">
              <button
                type="button"
                className={customer.loyaltyApplied ? "btn btn-loyalty btn-loyalty-active" : "btn btn-loyalty"}
                aria-pressed={customer.loyaltyApplied}
                disabled={cart.length === 0 || tendering !== null || !loyaltyReady}
                onClick={() => customerDispatch({ type: "toggle-loyalty" })}
              >
                {customer.loyaltyApplied
                  ? `LOYALTY APPLIED — ${dueMinor > 0 ? `${formatMinor(dueMinor, currency)} due by cash/card` : "fully covered"}`
                  : "LOYALTY"}
              </button>
            </div>
          )}

          <div className="tender-row">
            <button
              type="button"
              className="btn btn-tender btn-cash"
              disabled={cart.length === 0 || tendering !== null}
              onClick={() => void tender("cash")}
            >
              {tendering === "cash" ? "Processing…" : "CASH"}
            </button>
            <button
              type="button"
              className="btn btn-tender btn-card"
              disabled={cart.length === 0 || tendering !== null}
              onClick={() => void tender("card")}
            >
              {tendering === "card" ? "Processing…" : "CARD"}
            </button>
          </div>
        </section>
      </div>

      {completed && <ReceiptModal completed={completed} onNewSale={newSale} />}
    </div>
  );
}
