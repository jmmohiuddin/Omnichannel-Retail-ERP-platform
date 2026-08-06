import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listLevels, listLocations, type LevelDto } from "../lib/api.js";
import { formatQuantity } from "../lib/movements.js";
import { useAsync } from "../lib/useAsync.js";
import { useT } from "../lib/useT.js";

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
  const { t, tEnum } = useT();
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

  if (locLoading) return <p className="empty">{t("inventory.loadingLocations")}</p>;
  if (locError)
    return <div className="error-banner">{t("inventory.locationsFailed", { error: locError })}</div>;

  if (!locations || locations.length === 0) {
    return (
      <>
        <div className="page-head">
          <h1>{t("nav.inventory")}</h1>
        </div>
        <p className="empty">{t("inventory.noLocations")}</p>
      </>
    );
  }

  const groups = levels ? groupByState(levels) : new Map<string, LevelDto[]>();

  return (
    <>
      <div className="page-head">
        <h1>{t("nav.inventory")}</h1>
      </div>

      <div className="toolbar">
        <div className="field">
          <label htmlFor="inv-location">{t("inventory.location")}</label>
          <select
            id="inv-location"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.code}) — {tEnum("lockind", l.kind)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {lvlError && (
        <div className="error-banner">{t("inventory.levelsFailed", { error: lvlError })}</div>
      )}
      {lvlLoading ? (
        <p className="empty">{t("inventory.loadingLevels")}</p>
      ) : !levels || levels.length === 0 ? (
        <p className="empty">{t("inventory.noStock")}</p>
      ) : (
        <section className="card">
          {[...groups.entries()].map(([state, rows]) => (
            <div key={state}>
              <div className="group-title">
                {tEnum("state", state)}{" "}
                <span className="faint">
                  (
                  {rows.length === 1
                    ? t("inventory.skuOne")
                    : t("inventory.skuMany", { count: rows.length })}
                  )
                </span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t("th.sku")}</th>
                      <th>{t("th.product")}</th>
                      <th>{t("th.state")}</th>
                      <th className="num">{t("th.quantity")}</th>
                      <th aria-label={t("common.actions")} />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((lvl) => (
                      <tr key={`${lvl.variantId}-${lvl.state}`}>
                        <td className="mono">{lvl.sku}</td>
                        <td>{lvl.productName}</td>
                        <td>
                          <span className="badge neutral">{tEnum("state", lvl.state)}</span>
                        </td>
                        <td className="num">{formatQuantity(lvl.quantity)}</td>
                        <td>
                          <Link to={`/inventory/${lvl.variantId}?locationId=${locationId}`}>
                            {t("inventory.detail")}
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
