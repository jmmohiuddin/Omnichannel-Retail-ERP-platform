/**
 * Register-local persistence: auth tokens, device identity, chosen location.
 * localStorage for v1 — the Tauri shell swaps in OS-keychain/SQLite later.
 */

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  tenantId: string;
  slug: string;
  email: string;
}

export interface StoredLocation {
  id: string;
  name: string;
  code: string;
}

const SESSION_KEY = "omniretail.pos.session";
const DEVICE_KEY = "omniretail.pos.deviceId";
const LOCATION_KEY = "omniretail.pos.location";

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export function loadSession(): StoredSession | null {
  const s = readJson<StoredSession>(SESSION_KEY);
  return s && typeof s.accessToken === "string" ? s : null;
}

export function saveSession(session: StoredSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

export function loadDeviceId(): string | null {
  return localStorage.getItem(DEVICE_KEY);
}

export function saveDeviceId(deviceId: string): void {
  localStorage.setItem(DEVICE_KEY, deviceId);
}

export function loadLocation(): StoredLocation | null {
  const l = readJson<StoredLocation>(LOCATION_KEY);
  return l && typeof l.id === "string" ? l : null;
}

export function saveLocation(location: StoredLocation): void {
  localStorage.setItem(LOCATION_KEY, JSON.stringify(location));
}

export function clearLocation(): void {
  localStorage.removeItem(LOCATION_KEY);
}
