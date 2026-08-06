import { Link } from "react-router-dom";
import {
  fetchAllMovements,
  listLevels,
  listLocations,
  listProducts,
  type LocationDto,
  type MovementDto,
  type ProductDto,
} from "../lib/api.js";
import { presentMovement } from "../lib/movements.js";
import { useAsync } from "../lib/useAsync.js";
import { useT } from "../lib/useT.js";

interface DashboardData {
  locations: LocationDto[];
  products: ProductDto[];
  movements: MovementDto[];
  onHandUnits: number;
}

async function loadDashboard(): Promise<DashboardData> {
  const [locations, products, movements] = await Promise.all([
    listLocations(),
    listProducts(),
    fetchAllMovements(),
  ]);
  const levelsPerLocation = await Promise.all(locations.map((l) => listLevels(l.id)));
  const onHandUnits = levelsPerLocation
    .flat()
    .filter((lvl) => lvl.state === "on_hand")
    .reduce((sum, lvl) => sum + Number(lvl.quantity), 0);
  return { locations, products, movements, onHandUnits };
}

export function DashboardPage() {
  const { t, lang } = useT();
  const { data, error, loading } = useAsync(loadDashboard, []);

  if (loading) return <p className="empty">{t("dashboard.loading")}</p>;
  if (error) return <div className="error-banner">{t("dashboard.loadFailed", { error })}</div>;
  if (!data) return null;

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const last24h = data.movements.filter((m) => new Date(m.occurredAt).getTime() >= dayAgo).length;
  const recent = [...data.movements].sort((a, b) => b.seq - a.seq).slice(0, 10);

  const locationName = (id: string) => data.locations.find((l) => l.id === id)?.name;
  const skuOf = new Map<string, string>();
  for (const p of data.products) for (const v of p.variants) skuOf.set(v.id, v.sku);

  return (
    <>
      <div className="page-head">
        <h1>{t("nav.dashboard")}</h1>
        <span className="subtle">{t("common.timesInDubai")}</span>
      </div>

      <div className="stat-grid">
        <div className="card stat">
          <div className="label">{t("dashboard.locations")}</div>
          <div className="value">{data.locations.length}</div>
          <div className="hint">
            <Link to="/inventory">{t("dashboard.manageInventory")}</Link>
          </div>
        </div>
        <div className="card stat">
          <div className="label">{t("dashboard.products")}</div>
          <div className="value">{data.products.length}</div>
          <div className="hint">
            <Link to="/catalog">{t("dashboard.openCatalog")}</Link>
          </div>
        </div>
        <div className="card stat">
          <div className="label">{t("dashboard.unitsOnHand")}</div>
          {/* Western numerals in both languages, per UAE retail convention. */}
          <div className="value">{data.onHandUnits.toLocaleString("en-AE")}</div>
          <div className="hint">{t("dashboard.acrossLocations")}</div>
        </div>
        <div className="card stat">
          <div className="label">{t("dashboard.movements24h")}</div>
          <div className="value">{last24h}</div>
          <div className="hint">
            <Link to="/audit">{t("dashboard.fullAudit")}</Link>
          </div>
        </div>
      </div>

      <section className="card">
        <h2>{t("dashboard.recentMovements")}</h2>
        {recent.length === 0 ? (
          <p className="empty">{t("dashboard.noMovements")}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">{t("th.seq")}</th>
                  <th>{t("th.time")}</th>
                  <th>{t("th.type")}</th>
                  <th>{t("th.sku")}</th>
                  <th className="num">{t("th.qty")}</th>
                  <th>{t("th.flow")}</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((m) => {
                  const row = presentMovement(
                    m,
                    {
                      locationName,
                      sku: (id) => skuOf.get(id),
                    },
                    lang,
                  );
                  return (
                    <tr key={row.id}>
                      <td className="num mono">{row.seq}</td>
                      <td>{row.time}</td>
                      <td>
                        <span className={`badge ${row.tone}`}>{row.typeLabel}</span>
                      </td>
                      <td className="mono">
                        <Link to={`/inventory/${m.variantId}`}>{row.sku}</Link>
                      </td>
                      <td className="num">{row.quantity}</td>
                      <td>{row.flow}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
