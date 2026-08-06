import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  listLocations,
  listMovements,
  listProducts,
  type LocationDto,
  type MovementDto,
} from "../lib/api.js";
import { presentMovement } from "../lib/movements.js";
import { useAsync } from "../lib/useAsync.js";

const PAGE_SIZE = 100;

interface Lookups {
  locations: LocationDto[];
  skuOf: Map<string, string>;
}

export function AuditPage() {
  const { data: lookups, error: lookupError } = useAsync<Lookups>(async () => {
    const [locations, products] = await Promise.all([listLocations(), listProducts()]);
    const skuOf = new Map<string, string>();
    for (const p of products) for (const v of p.variants) skuOf.set(v.id, v.sku);
    return { locations, skuOf };
  }, []);

  const [items, setItems] = useState<MovementDto[]>([]);
  const [cursor, setCursor] = useState<number | null>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef(new Set<number>());

  const loadPage = useCallback(async (afterSeq: number) => {
    setLoading(true);
    setError(null);
    try {
      const feed = await listMovements(afterSeq, PAGE_SIZE);
      setItems((prev) => {
        const fresh = feed.items.filter((m) => !seen.current.has(m.seq));
        for (const m of fresh) seen.current.add(m.seq);
        return [...prev, ...fresh];
      });
      setCursor(feed.nextCursor ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load ledger");
    } finally {
      setLoading(false);
    }
  }, []);

  const initialised = useRef(false);
  useEffect(() => {
    if (!initialised.current) {
      initialised.current = true;
      void loadPage(0);
    }
  }, [loadPage]);

  const rows = useMemo(() => {
    const locationName = (id: string) => lookups?.locations.find((l) => l.id === id)?.name;
    const sku = (id: string) => lookups?.skuOf.get(id);
    return [...items]
      .sort((a, b) => b.seq - a.seq)
      .map((m) => ({ movement: m, row: presentMovement(m, { locationName, sku }) }));
  }, [items, lookups]);

  return (
    <>
      <div className="page-head">
        <h1>Audit trail</h1>
        <span className="subtle">
          Append-only stock ledger · {items.length} entries loaded · times in Asia/Dubai
        </span>
      </div>

      {lookupError && (
        <div className="error-banner">Failed to load reference data: {lookupError}</div>
      )}
      {error && <div className="error-banner">{error}</div>}

      <section className="card">
        {rows.length === 0 && !loading ? (
          <p className="empty">The ledger is empty.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">Seq</th>
                  <th>Time (Dubai)</th>
                  <th>Type</th>
                  <th>SKU</th>
                  <th className="num">Qty</th>
                  <th>From → To</th>
                  <th>Actor</th>
                  <th>Reference</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ movement, row }) => (
                  <tr key={row.id}>
                    <td className="num mono">{row.seq}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{row.time}</td>
                    <td>
                      <span className={`badge ${row.tone}`}>{row.typeLabel}</span>
                    </td>
                    <td className="mono">
                      <Link to={`/inventory/${movement.variantId}`}>{row.sku}</Link>
                    </td>
                    <td className="num">{row.quantity}</td>
                    <td>{row.flow}</td>
                    <td className="mono" title={movement.actorUserId}>
                      {row.actor}
                    </td>
                    <td className="mono">{row.reference}</td>
                    <td>{row.note || <span className="faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="load-more-row">
          {cursor !== null ? (
            <button
              type="button"
              className="secondary"
              disabled={loading}
              onClick={() => void loadPage(cursor)}
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          ) : (
            rows.length > 0 && <span className="faint">End of ledger.</span>
          )}
        </div>
      </section>
    </>
  );
}
