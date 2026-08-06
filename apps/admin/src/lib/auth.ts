/**
 * Auth session store: tokens live in memory (fast path) and are mirrored to
 * localStorage so a page reload keeps the operator signed in. No framework
 * dependency — React subscribes via `subscribe`/`getSession`
 * (useSyncExternalStore-compatible).
 */
import { API_BASE } from "./config.js";

const STORAGE_KEY = "omniretail.admin.session";

export interface Session {
  accessToken: string;
  refreshToken: string;
  userId: string;
  tenantId: string;
  slug: string;
  email: string;
}

export class AuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${code} (HTTP ${status})`);
    this.name = "AuthApiError";
  }
}

let current: Session | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

function storage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function isSession(v: unknown): v is Session {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.accessToken === "string" &&
    typeof s.refreshToken === "string" &&
    typeof s.userId === "string" &&
    typeof s.tenantId === "string" &&
    typeof s.slug === "string" &&
    typeof s.email === "string"
  );
}

/** Current session — hydrates from localStorage on first call. */
export function getSession(): Session | null {
  if (!hydrated) {
    hydrated = true;
    const raw = storage()?.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        current = isSession(parsed) ? parsed : null;
      } catch {
        current = null;
      }
    }
  }
  return current;
}

export function setSession(session: Session | null): void {
  hydrated = true;
  current = session;
  if (session) storage()?.setItem(STORAGE_KEY, JSON.stringify(session));
  else storage()?.removeItem(STORAGE_KEY);
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function accessToken(): string | null {
  return getSession()?.accessToken ?? null;
}

export function signOut(): void {
  setSession(null);
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  userId: string;
  tenantId: string;
}

async function postAuth(path: string, body: unknown): Promise<TokenResponse> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let code = "AUTH_FAILED";
    try {
      const payload = (await res.json()) as { error?: string };
      if (payload?.error) code = payload.error;
    } catch {
      /* non-JSON error body */
    }
    throw new AuthApiError(res.status, code);
  }
  return (await res.json()) as TokenResponse;
}

export async function login(slug: string, email: string, password: string): Promise<Session> {
  const tokens = await postAuth("/v1/auth/login", { slug, email, password });
  const session: Session = { ...tokens, slug, email };
  setSession(session);
  return session;
}

export interface RegisterInput {
  tenantName: string;
  slug: string;
  fullName: string;
  email: string;
  password: string;
}

export async function registerTenant(input: RegisterInput): Promise<Session> {
  const tokens = await postAuth("/v1/auth/register", input);
  const session: Session = { ...tokens, slug: input.slug, email: input.email };
  setSession(session);
  return session;
}

/** Test hook: reset module state between test cases. */
export function resetAuthForTests(): void {
  current = null;
  hydrated = false;
  listeners.clear();
}
