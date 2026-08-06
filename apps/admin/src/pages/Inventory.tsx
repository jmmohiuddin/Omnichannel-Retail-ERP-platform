import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listLevels, listLocations, type LevelDto } from "../lib/api.js";
import { formatQuantity, humanState } from "../lib/movements.js";
import { useAsync } from "../lib/useAsync.js";

const STATE_ORDER = ["on_hand", "reserved", "in_transit", "damaged", "returned_pending"];

function groupByState(levels: LevelDto[]): Map<string, LevelDto[]> {
  const groups = new Map<string, LevelDto[]>();
  const order = [...STATE_ORDER, ...levels.map((l) => l.state)];
  for (const state of order) if (!groups.has(state)) groups.set(state, []);
  for (const lvl of levels) groups.get(lvl.state)?.push(lvl);
  for (const [state, rows] of groups) if (rows.length === 0) groups.delete(state);
  return groups;
}

export function InventoryPage() {
  const { data: locations, error: locError, loading: locLoading } = useAsync(listLocations, []);
  const [locationId, setLocationId] = useState<string>("");

  useEffect(() => {
    const first = locations?.[0];
    if (first && !locationId) setLocationId(first.id);
  }, [locations, locationId]);

  const {
    data: levels,
    error: lvlError,
    loading: lvlLoading,
  } = useAsync(
    () => (locationId ? listLevels(locationId) : Promise.resolve([])),
    [locationId],
  );

  if (locLoading) return <p className="empty">Loading locations…</p>;
  if (locError) return <div className="error-banner">Failed to load locations: {locError}</div>;

  if (!locations || locations.length === 0) {
    return (
      <>
        <div className="page-head">
          <h1>Inventory</h1>
        </div>
        <p className="empty">No locations yet — create a store or warehouse first.</p>
      </>
    );
  }

  const groups = levels ? groupByState(levels) : new Map<string, LevelDto[]>();

  return (
    <>
      <div className="page-head">
        <h1>Inventory</h1>
      </div>

      <div className="toolbar">
        <div className="field">
          <label htmlFor="inv-location">Location</label>
          <select
            id="inv-location"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.code}) — {l.kind}
              </option>
            ))}
          </select>
        </div>
      </div>

      {lvlError && <div className="error-banner">Failed to load stock levels: {lvlError}</div>}
      {lvlLoading ? (
        <p className="empty">Loading stock levels…</p>
      ) : !levels || levels.length === 0 ? (
        <p className="empty">No stock at this location.</p>
      ) : (
        <section className="card">
          {[...groups.entries()].map(([state, rows]) => (
            <div key={state}>
              <div className="group-title">
                {humanState(state)}{" "}
                <span className="faint">
                  ({rows.length} SKU{rows.length === 1 ? "" : "s"})
                </span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Product</th>
                      <th>State</th>
                      <th className="num">Quantity</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((lvl) => (
                      <tr key={`${lvl.variantId}-${lvl.state}`}>
                        <td className="mono">{lvl.sku}</td>
                        <td>{lvl.productName}</td>
                        <td>
                          <span className="badge neutral">{humanState(lvl.state)}</span>
                        </td>
                        <td className="num">{formatQuantity(lvl.quantity)}</td>
                        <td>
                          <Link to={`/inventory/${lvl.variantId}?locationId=${locationId}`}>
                            Detail
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
