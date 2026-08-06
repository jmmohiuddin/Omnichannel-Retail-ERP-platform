import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  fetchAllMovements,
  getAvailability,
  listLocations,
  listProducts,
  type LocationDto,
  type MovementDto,
  type VariantDto,
} from "../lib/api.js";
import { formatMinor } from "../lib/money.js";
import { presentMovement } from "../lib/movements.js";
import { useAsync } from "../lib/useAsync.js";
import { useT } from "../lib/useT.js";

interface DetailData {
  locations: LocationDto[];
  locationId: string | null;
  availability: Record<string, unknown> | null;
  movements: MovementDto[];
  variant: (VariantDto & { productName: string }) | null;
}

async function loadDetail(variantId: string, requestedLocationId: string | null): Promise<DetailData> {
  const [locations, products, allMovements] = await Promise.all([
    listLocations(),
    listProducts(),
    fetchAllMovements(),
  ]);

  let variant: DetailData["variant"] = null;
  for (const p of products) {
    const v = p.variants.find((x) => x.id === variantId);
    if (v) {
      variant = { ...v, productName: p.name };
      break;
    }
  }

  const locationId = requestedLocationId ?? locations[0]?.id ?? null;
  let availability: Record<string, unknown> | null = null;
  if (locationId) {
    try {
      availability = await getAvailability(variantId, locationId);
    } catch {
      availability = null; // no stock rows yet is not an error worth blocking the page
    }
  }

  const movements = allMovements
    .filter((m) => m.variantId === variantId)
    .sort((a, b) => b.seq - a.seq);

  return { locations, locationId, availability, movements, variant };
}

function AvailabilityCard({ availability }: { availability: Record<string, unknown> }) {
  const { tEnum } = useT();
  const entries = Object.entries(availability).filter(
    ([, v]) => typeof v === "number" || typeof v === "string",
  );
  if (entries.length === 0) return null;
  return (
    <div className="kv-grid">
      {entries.map(([key, value]) => (
        <div className="stat" key={key}>
          <div className="label">
            {tEnum("state", key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase())}
          </div>
          <div className="value">{String(value)}</div>
        </div>
      ))}
    </div>
  );
}

export function VariantDetailPage() {
  const { t, lang } = useT();
  const { variantId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const requestedLocationId = params.get("locationId");

  const { data, error, loading } = useAsync(
    () => loadDetail(variantId, requestedLocationId),
    [variantId, requestedLocationId],
  );

  if (loading) return <p className="empty">{t("variant.loading")}</p>;
  if (error) return <div className="error-banner">{t("variant.loadFailed", { error })}</div>;
  if (!data) return null;

  const locationName = (id: string) => data.locations.find((l) => l.id === id)?.name;
  const title = data.variant ? data.variant.sku : variantId;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="subtle" style={{ marginBlock: 0 }}>
            <Link to="/inventory">{t("nav.inventory")}</Link> / {t("variant.breadcrumb")}
          </p>
          <h1 className="mono">{title}</h1>
          {data.variant && (
            <p className="subtle" style={{ marginBlock: 0 }}>
              {data.variant.productName} ·{" "}
              {formatMinor(data.variant.priceMinor, data.variant.currency)}
              {data.variant.barcode ? (
                <>
                  {" "}
                  · {t("variant.barcode")} <span className="mono">{data.variant.barcode}</span>
                </>
              ) : null}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="vd-location">{t("variant.availabilityAt")}</label>
          <select
            id="vd-location"
            value={data.locationId ?? ""}
            onChange={(e) => setParams({ locationId: e.target.value })}
          >
            {data.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.code})
              </option>
            ))}
          </select>
        </div>
      </div>

      <section className="card">
        <h2>{t("variant.availability")}</h2>
        {data.availability ? (
          <AvailabilityCard availability={data.availability} />
        ) : (
          <p className="empty">{t("variant.noAvailability")}</p>
        )}
      </section>

      <section className="card" style={{ marginBlockStart: "var(--space-4)" }}>
        <h2>{t("variant.movementHistory")}</h2>
        {data.movements.length === 0 ? (
          <p className="empty">{t("variant.noMovements")}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">{t("th.seq")}</th>
                  <th>{t("th.time")}</th>
                  <th>{t("th.type")}</th>
                  <th className="num">{t("th.qty")}</th>
                  <th>{t("th.flow")}</th>
                  <th>{t("th.reference")}</th>
                  <th>{t("th.note")}</th>
                </tr>
              </thead>
              <tbody>
                {data.movements.map((m) => {
                  const row = presentMovement(m, { locationName }, lang);
                  return (
                    <tr key={row.id}>
                      <td className="num mono">{row.seq}</td>
                      <td>{row.time}</td>
                      <td>
                        <span className={`badge ${row.tone}`}>{row.typeLabel}</span>
                      </td>
                      <td className="num">{row.quantity}</td>
                      <td>{row.flow}</td>
                      <td className="mono">{row.reference}</td>
                      <td>{row.note || <span className="faint">—</span>}</td>
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
