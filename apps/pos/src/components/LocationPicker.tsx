import type { LocationSummary } from "../lib/api.js";
import { LangToggle, useLang } from "./LangProvider.js";

interface Props {
  locations: LocationSummary[];
  onPick: (location: LocationSummary) => void;
  onSignOut: () => void;
}

export function LocationPicker({ locations, onPick, onSignOut }: Props) {
  const { t } = useLang();
  return (
    <main className="centered-screen">
      <div className="panel location-panel">
        <div className="panel-lang-row">
          <LangToggle />
        </div>
        <h1 className="brand">{t("location.title")}</h1>
        <p className="muted">{t("location.subtitle")}</p>
        {locations.length === 0 ? (
          <p className="error-text">{t("location.none")}</p>
        ) : (
          <ul className="location-list">
            {locations.map((loc) => (
              <li key={loc.id}>
                <button type="button" className="btn location-btn" onClick={() => onPick(loc)}>
                  <span className="location-name">{loc.name}</span>
                  <span className="muted">
                    {loc.code} · {loc.kind}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="btn btn-ghost" onClick={onSignOut}>
          {t("common.signOut")}
        </button>
      </div>
    </main>
  );
}
