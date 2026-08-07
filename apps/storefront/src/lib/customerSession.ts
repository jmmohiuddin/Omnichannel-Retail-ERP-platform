/**
 * Storefront customer session store: persists the shopper's opaque session
 * token and profile to localStorage, notifies React subscribers (via
 * useSyncExternalStore in useCustomerSession), and exposes a couple of
 * presenter helpers for the "My Orders" / "My Devices" screens.
 *
 * The token is opaque and issued by the API (see customerAuthService.ts) —
 * this file only stores it and attaches it to outgoing requests. It is
 * scoped by tenant slug because a single browser might visit multiple stores
 * and each has its own session.
 */
import { useSyncExternalStore } from "react";

export const SESSION_STORAGE_PREFIX = "omniretail.storefront.customerSession.";

export interface StoredCustomer {
  id: string;
  fullName: string;
  email: string;
}

export interface StoredSession {
  sessionToken: string;
  customer: StoredCustomer;
}

/** Minimal Storage surface so tests can stub persistence. */
export interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function keyFor(slug: string): string {
  return SESSION_STORAGE_PREFIX + slug;
}

function parseStored(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" && parsed !== null &&
      typeof (parsed as { sessionToken?: unknown }).sessionToken === "string" &&
      typeof (parsed as { customer?: unknown }).customer === "object"
    ) {
      const s = parsed as StoredSession;
      if (
        typeof s.customer.id === "string" &&
        typeof s.customer.email === "string" &&
        typeof s.customer.fullName === "string"
      ) {
        return s;
      }
    }
  } catch {
    /* stored value was corrupted — treat as signed out */
  }
  return null;
}

export class CustomerSessionStore {
  private session: StoredSession | null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly slug: string,
    private readonly storage: SessionStorage,
  ) {
    let raw: string | null = null;
    try {
      raw = storage.getItem(keyFor(slug));
    } catch {
      /* storage unavailable — treat as signed out */
    }
    this.session = parseStored(raw);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get = (): StoredSession | null => this.session;

  set = (next: StoredSession): void => {
    this.session = next;
    try {
      this.storage.setItem(keyFor(this.slug), JSON.stringify(next));
    } catch {
      /* storage full / private mode — kept in memory for this session */
    }
    this.notify();
  };

  clear = (): void => {
    this.session = null;
    try {
      this.storage.removeItem(keyFor(this.slug));
    } catch {
      /* ignore — clearing the in-memory value is what matters */
    }
    this.notify();
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function browserStorage(): SessionStorage {
  try {
    const s = window.localStorage;
    const probe = SESSION_STORAGE_PREFIX + "__probe__";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => void mem.set(k, v),
      removeItem: (k) => void mem.delete(k),
    };
  }
}

const stores = new Map<string, CustomerSessionStore>();

/** Per-slug shared session store (created lazily). */
export function getCustomerSessionStore(slug: string): CustomerSessionStore {
  let store = stores.get(slug);
  if (!store) {
    store = new CustomerSessionStore(slug, browserStorage());
    stores.set(slug, store);
  }
  return store;
}

/** Test-only escape hatch to reset the shared registry between cases. */
export function __resetCustomerSessionStores(): void {
  stores.clear();
}

export interface CustomerSessionView {
  session: StoredSession | null;
  signIn: (next: StoredSession) => void;
  signOut: () => void;
}

/** Subscribe to the shopper's customer session for a given tenant slug. */
export function useCustomerSession(slug: string): CustomerSessionView {
  const store = getCustomerSessionStore(slug);
  const session = useSyncExternalStore(store.subscribe, store.get, store.get);
  return { session, signIn: store.set, signOut: store.clear };
}

// ---- Presenter helpers ---------------------------------------------------
//
// The storefront targets UAE shoppers; timestamps and warranty dates render
// in Asia/Dubai so a customer in Sharjah reading their order history sees the
// same day they placed the order. Format strings are locale-agnostic — the
// AR/EN toggle governs UI copy but numerals stay Western (see money.ts).

const dateTimeFormatter = new Intl.DateTimeFormat("en-AE", {
  timeZone: "Asia/Dubai",
  dateStyle: "medium",
  timeStyle: "short",
});
const dateFormatter = new Intl.DateTimeFormat("en-AE", {
  timeZone: "Asia/Dubai",
  dateStyle: "medium",
});

/** Format an ISO order timestamp in Asia/Dubai for the "My Orders" list. */
export function formatOrderTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  return dateTimeFormatter.format(d);
}

/**
 * Format a warranty-until date. Warranty rows carry a plain calendar date
 * (Postgres DATE) — we parse the yyyy-mm-dd into a stable local date and
 * render "12 Aug 2027". Returns null (not a placeholder) so callers can
 * decide whether to hide the row.
 */
export function formatWarrantyUntil(value: string | null | undefined): string | null {
  if (!value) return null;
  // Guard against arbitrary strings — accept yyyy-mm-dd or an ISO timestamp.
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  const iso = `${y}-${m}-${d}T00:00:00Z`;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return null;
  return dateFormatter.format(dt);
}
