import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createApiClient, type LocationSummary } from "./lib/api.js";
import { SaleQueue } from "./lib/saleQueue.js";
import {
  clearSession,
  loadDeviceId,
  loadLocation,
  loadSession,
  saveDeviceId,
  saveLocation,
  saveSession,
  type StoredLocation,
  type StoredSession,
} from "./lib/session.js";
import { LoginView } from "./components/LoginView.js";
import { LocationPicker } from "./components/LocationPicker.js";
import { SaleScreen } from "./components/SaleScreen.js";

type Phase =
  | { name: "login" }
  | { name: "setup"; message: string }
  | { name: "pick-location"; locations: LocationSummary[] }
  | { name: "sale"; deviceId: string; location: StoredLocation };

export function App() {
  const [session, setSession] = useState<StoredSession | null>(() => loadSession());
  const [phase, setPhase] = useState<Phase>(session ? { name: "setup", message: "Starting…" } : { name: "login" });
  const [setupError, setSetupError] = useState<string | null>(null);

  // Token lives in a ref so the api client closure always sees the latest.
  const tokenRef = useRef<string | null>(session?.accessToken ?? null);
  tokenRef.current = session?.accessToken ?? null;
  const api = useMemo(() => createApiClient(() => tokenRef.current), []);

  const queue = useMemo(
    () =>
      new SaleQueue({
        storage: localStorage,
        post: (payload) => api.submitSale(payload),
      }),
    [api],
  );
  useEffect(() => {
    queue.start();
    return () => queue.stop();
  }, [queue]);

  const logout = useCallback(() => {
    clearSession();
    setSession(null);
    setPhase({ name: "login" });
  }, []);

  /** Post-login bootstrap: register device on first run, resolve location. */
  const bootstrap = useCallback(async () => {
    setSetupError(null);
    try {
      let deviceId = loadDeviceId();
      if (!deviceId) {
        setPhase({ name: "setup", message: "Registering this register…" });
        const device = await api.registerDevice(`POS Register — ${navigator.platform || "desktop"}`);
        deviceId = device.id;
        saveDeviceId(deviceId);
      }
      setPhase({ name: "setup", message: "Loading locations…" });
      const { items } = await api.listLocations();
      const saved = loadLocation();
      const match = saved ? items.find((l) => l.id === saved.id) : undefined;
      if (match) {
        setPhase({ name: "sale", deviceId, location: { id: match.id, name: match.name, code: match.code } });
      } else {
        setPhase({ name: "pick-location", locations: items });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Setup failed";
      setSetupError(message);
      setPhase({ name: "setup", message: "Setup failed" });
    }
  }, [api]);

  useEffect(() => {
    if (session && phase.name === "setup" && setupError === null) void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const handleLoggedIn = useCallback((s: StoredSession) => {
    saveSession(s);
    setSession(s);
    setPhase({ name: "setup", message: "Starting…" });
  }, []);

  const handleLocationPicked = useCallback((loc: LocationSummary) => {
    const stored: StoredLocation = { id: loc.id, name: loc.name, code: loc.code };
    saveLocation(stored);
    const deviceId = loadDeviceId();
    if (deviceId) setPhase({ name: "sale", deviceId, location: stored });
  }, []);

  if (!session || phase.name === "login") {
    return <LoginView api={api} onLoggedIn={handleLoggedIn} />;
  }

  if (phase.name === "setup") {
    return (
      <main className="centered-screen">
        <div className="panel setup-panel">
          <h1 className="brand">OmniRetail POS</h1>
          <p role="status">{phase.message}</p>
          {setupError && (
            <>
              <p className="error-text">{setupError}</p>
              <div className="row-gap">
                <button type="button" className="btn" onClick={() => void bootstrap()}>
                  Retry
                </button>
                <button type="button" className="btn btn-ghost" onClick={logout}>
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    );
  }

  if (phase.name === "pick-location") {
    return <LocationPicker locations={phase.locations} onPick={handleLocationPicked} onSignOut={logout} />;
  }

  return (
    <SaleScreen
      api={api}
      queue={queue}
      deviceId={phase.deviceId}
      location={phase.location}
      cashierEmail={session.email}
      onSignOut={logout}
    />
  );
}
