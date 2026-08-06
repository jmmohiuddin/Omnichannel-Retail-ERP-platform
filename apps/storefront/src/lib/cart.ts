/**
 * Storefront cart. Pure list operations (unit-testable, no I/O) plus a small
 * per-slug store that persists to Storage and notifies React subscribers.
 * Carts are keyed by tenant slug so browsing two stores never mixes lines.
 */

export interface CartLine {
  variantId: string;
  productSlug: string;
  productName: string;
  sku: string;
  /** VAT-inclusive unit price in minor units (fils). */
  priceMinor: number;
  currency: string;
  quantity: number;
}

/** Minimal Storage surface so tests can stub persistence. */
export interface CartStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY_PREFIX = "omniretail.storefront.cart.";

export function cartKey(slug: string): string {
  return KEY_PREFIX + slug;
}

// ---------------------------------------------------------------------------
// Pure operations
// ---------------------------------------------------------------------------

function normalizeQty(quantity: number): number {
  if (!Number.isFinite(quantity)) return 0;
  return Math.max(0, Math.floor(quantity));
}

/**
 * Add `quantity` of a line; merges with an existing line for the same
 * variantId (quantities accumulate, latest price/name win).
 */
export function addLine(lines: readonly CartLine[], line: Omit<CartLine, "quantity">, quantity = 1): CartLine[] {
  const qty = normalizeQty(quantity);
  if (qty === 0) return [...lines];
  const existing = lines.find((l) => l.variantId === line.variantId);
  if (existing) {
    return lines.map((l) =>
      l.variantId === line.variantId ? { ...line, quantity: l.quantity + qty } : l,
    );
  }
  return [...lines, { ...line, quantity: qty }];
}

/** Set a line's quantity; 0 (or less) removes the line. */
export function setQuantity(lines: readonly CartLine[], variantId: string, quantity: number): CartLine[] {
  const qty = normalizeQty(quantity);
  if (qty === 0) return removeLine(lines, variantId);
  return lines.map((l) => (l.variantId === variantId ? { ...l, quantity: qty } : l));
}

export function removeLine(lines: readonly CartLine[], variantId: string): CartLine[] {
  return lines.filter((l) => l.variantId !== variantId);
}

/** Cart total in minor units (prices are VAT-inclusive). Integer math only. */
export function cartTotalMinor(lines: readonly CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.priceMinor * l.quantity, 0);
}

/** Total unit count across lines (for the header badge). */
export function itemCount(lines: readonly CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.quantity, 0);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function isCartLine(value: unknown): value is CartLine {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.variantId === "string" &&
    typeof v.productSlug === "string" &&
    typeof v.productName === "string" &&
    typeof v.sku === "string" &&
    typeof v.priceMinor === "number" &&
    Number.isInteger(v.priceMinor) &&
    typeof v.currency === "string" &&
    typeof v.quantity === "number" &&
    Number.isInteger(v.quantity) &&
    v.quantity > 0
  );
}

/** Load a slug's cart; malformed or missing data yields an empty cart. */
export function loadCart(slug: string, storage: CartStorage): CartLine[] {
  let raw: string | null = null;
  try {
    raw = storage.getItem(cartKey(slug));
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCartLine);
  } catch {
    return [];
  }
}

/** Persist a slug's cart; an empty cart clears the key. */
export function saveCart(slug: string, lines: readonly CartLine[], storage: CartStorage): void {
  try {
    if (lines.length === 0) storage.removeItem(cartKey(slug));
    else storage.setItem(cartKey(slug), JSON.stringify(lines));
  } catch {
    /* storage full / unavailable — cart stays in memory for the session */
  }
}

// ---------------------------------------------------------------------------
// Store (per slug) for React
// ---------------------------------------------------------------------------

export class CartStore {
  private lines: CartLine[];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly slug: string,
    private readonly storage: CartStorage,
  ) {
    this.lines = loadCart(slug, storage);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getLines = (): CartLine[] => this.lines;

  add = (line: Omit<CartLine, "quantity">, quantity = 1): void => {
    this.commit(addLine(this.lines, line, quantity));
  };

  setQuantity = (variantId: string, quantity: number): void => {
    this.commit(setQuantity(this.lines, variantId, quantity));
  };

  remove = (variantId: string): void => {
    this.commit(removeLine(this.lines, variantId));
  };

  clear = (): void => {
    this.commit([]);
  };

  private commit(next: CartLine[]): void {
    this.lines = next;
    saveCart(this.slug, next, this.storage);
    for (const listener of this.listeners) listener();
  }
}

function browserStorage(): CartStorage {
  try {
    const s = window.localStorage;
    // Probe: some privacy modes expose localStorage but throw on write.
    const probe = KEY_PREFIX + "__probe__";
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

const stores = new Map<string, CartStore>();

/** Get (or create) the shared cart store for a tenant slug. */
export function getCartStore(slug: string): CartStore {
  let store = stores.get(slug);
  if (!store) {
    store = new CartStore(slug, browserStorage());
    stores.set(slug, store);
  }
  return store;
}
