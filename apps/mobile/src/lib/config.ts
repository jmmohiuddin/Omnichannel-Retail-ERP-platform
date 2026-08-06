/**
 * API base URL for the mobile app. React Native has no import.meta.env, so the
 * value is a plain mutable module setting: the default targets a simulator on
 * the same machine as the API; on a physical phone with Expo Go, call
 * setApiBase("http://<LAN-IP-of-dev-machine>:3001") before signing in (the
 * Login screen exposes the field).
 */

const DEFAULT_API_BASE = "http://localhost:3001";

let apiBase = DEFAULT_API_BASE;

export function getApiBase(): string {
  return apiBase;
}

/** Set the API origin. Trailing slashes are stripped so paths concatenate cleanly. */
export function setApiBase(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, "");
  apiBase = trimmed.length > 0 ? trimmed : DEFAULT_API_BASE;
}
