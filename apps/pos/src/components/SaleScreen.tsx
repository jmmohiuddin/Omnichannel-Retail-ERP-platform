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
  isNetworkError,
  type ApiClient,
  type ProductSummary,
  type Receipt,
  type SalePayload,
  type VariantSummary,
} from "../lib/api.js";
import { cartReducer, cartTotals, lineTotalMinor, type CartLine } from "../lib/cart.js";
import { formatMinor } from "../lib/money.js";
import type { SaleQueue } from "../lib/saleQueue.js";
import type { StoredLocation } from "../lib/session.js";
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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [tendering, setTendering] = useState<"cash" | "card" | null>(null);
  const [saleError, setSaleError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<CompletedSale | null>(null);

  const barcodeRef = useRef<HTMLInputElement>(null);

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

  /** Exact barcode/SKU lookup — scanners type the code and send Enter. */
  const handleScan = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const code = barcode.trim();
      if (code.length === 0) return;
      setBarcodeMiss(null);
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
    [api, barcode, addVariant],
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
    async (method: "cash" | "card") => {
      if (cart.length === 0 || tendering !== null) return;
      setTendering(method);
      setSaleError(null);
      const linesSnapshot: CartLine[] = cart.map((l) => ({ ...l }));
      const totalsSnapshot = cartTotals(linesSnapshot);
      const payload: SalePayload = {
        id: crypto.randomUUID(),
        deviceId,
        locationId: location.id,
        lines: linesSnapshot.map((l) => ({
          variantId: l.variantId,
          quantity: l.quantity,
          unitPriceMinor: l.unitPriceMinor,
          ...(l.stockUnitId !== undefined ? { stockUnitId: l.stockUnitId } : {}),
        })),
        payments: [{ method, amountMinor: totalsSnapshot.totalMinor }],
      };
      try {
        const outcome = await queue.submit(payload);
        if (outcome.status === "queued") {
          setCompleted({
            mode: "offline",
            saleId: payload.id,
            totals: totalsSnapshot,
            lines: linesSnapshot,
            payment: method,
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
        setCompleted({ mode: "online", sale: outcome.result, receipt, lines: linesSnapshot, payment: method });
      } catch (err) {
        if (err instanceof ApiError) {
          setSaleError(`Sale rejected by the server (HTTP ${err.status}). Nothing was charged.`);
        } else if (isNetworkError(err)) {
          setSaleError("Network error — the sale was not submitted.");
        } else {
          setSaleError("Sale failed unexpectedly.");
        }
      } finally {
        setTendering(null);
      }
    },
    [api, cart, deviceId, location.id, queue, tendering],
  );

  const newSale = useCallback(() => {
    setCompleted(null);
    dispatch({ type: "clear" });
    setBarcode("");
    setQuery("");
    setResults([]);
    setSaleError(null);
    barcodeRef.current?.focus();
  }, []);

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
                  <span className="muted">{formatMinor(line.unitPriceMinor, line.currency)} each</span>
                </div>
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
                <span className="cart-line-total mono">{formatMinor(lineTotalMinor(line), line.currency)}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  aria-label={`Remove ${line.name}`}
                  onClick={() => dispatch({ type: "remove", variantId: line.variantId })}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

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
          </dl>

          {saleError && (
            <p className="error-text" role="alert">
              {saleError}
            </p>
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
