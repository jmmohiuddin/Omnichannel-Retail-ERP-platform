import type { LocationSummary } from "../lib/api.js";

interface Props {
  locations: LocationSummary[];
  onPick: (location: LocationSummary) => void;
  onSignOut: () => void;
}

export function LocationPicker({ locations, onPick, onSignOut }: Props) {
  return (
    <main className="centered-screen">
      <div className="panel location-panel">
        <h1 className="brand">Choose location</h1>
        <p className="muted">Sales from this register will post to the selected location.</p>
        {locations.length === 0 ? (
          <p className="error-text">No locations found for this tenant — create one in the back office first.</p>
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
          Sign out
        </button>
      </div>
    </main>
  );
}
