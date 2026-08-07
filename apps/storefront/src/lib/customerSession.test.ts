import { describe, expect, it } from "vitest";
import {
  CustomerSessionStore,
  SESSION_STORAGE_PREFIX,
  formatOrderTime,
  formatWarrantyUntil,
  type SessionStorage,
  type StoredSession,
} from "./customerSession.js";

function memoryStorage(initial: Record<string, string> = {}): SessionStorage & {
  dump(): Record<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

const sample: StoredSession = {
  sessionToken: "sess-abc",
  customer: { id: "cust-1", fullName: "Aisha", email: "aisha@example.test" },
};

describe("CustomerSessionStore", () => {
  it("starts empty and persists a sign-in under a slug-scoped key", () => {
    const storage = memoryStorage();
    const store = new CustomerSessionStore("deira-mobile", storage);
    expect(store.get()).toBeNull();

    store.set(sample);
    expect(store.get()).toEqual(sample);
    expect(storage.dump()[SESSION_STORAGE_PREFIX + "deira-mobile"]).toContain("sess-abc");
    // Namespacing means another store gets its own row.
    expect(storage.dump()[SESSION_STORAGE_PREFIX + "other"]).toBeUndefined();
  });

  it("restores a stored session and ignores corrupt values", () => {
    const good = memoryStorage({
      [SESSION_STORAGE_PREFIX + "s"]: JSON.stringify(sample),
    });
    expect(new CustomerSessionStore("s", good).get()).toEqual(sample);

    const bad = memoryStorage({ [SESSION_STORAGE_PREFIX + "s"]: "not-json" });
    expect(new CustomerSessionStore("s", bad).get()).toBeNull();

    const partial = memoryStorage({
      [SESSION_STORAGE_PREFIX + "s"]: JSON.stringify({ sessionToken: "x" }),
    });
    expect(new CustomerSessionStore("s", partial).get()).toBeNull();
  });

  it("notifies subscribers on sign-in and sign-out and honours unsubscribe", () => {
    const store = new CustomerSessionStore("s", memoryStorage());
    const seen: Array<StoredSession | null> = [];
    const unsubscribe = store.subscribe(() => seen.push(store.get()));

    store.set(sample);
    store.clear();
    expect(seen).toEqual([sample, null]);

    unsubscribe();
    store.set(sample);
    expect(seen).toHaveLength(2);
  });

  it("clear() removes the localStorage row so a fresh store starts signed out", () => {
    const storage = memoryStorage();
    const store = new CustomerSessionStore("s", storage);
    store.set(sample);
    store.clear();
    expect(storage.dump()[SESSION_STORAGE_PREFIX + "s"]).toBeUndefined();

    const revived = new CustomerSessionStore("s", storage);
    expect(revived.get()).toBeNull();
  });
});

describe("presenter helpers", () => {
  it("formatOrderTime renders the timestamp in Asia/Dubai", () => {
    // 2026-08-01 06:00 UTC → 10:00 in Dubai (UTC+4). Assert the DAY didn't slip
    // and the time-zone offset was applied, without pinning the exact locale
    // punctuation (which varies by Node/ICU build).
    const rendered = formatOrderTime("2026-08-01T06:00:00Z");
    expect(rendered).toContain("2026");
    expect(rendered).toMatch(/\b1\b|\bAug\b/);
    // A midnight-UTC timestamp shifts to 04:00 in Dubai — the date stays the same.
    expect(formatOrderTime("2026-08-01T00:00:00Z")).toContain("2026");
    expect(formatOrderTime("not a date")).toBe("—");
  });

  it("formatWarrantyUntil accepts a Postgres DATE and rejects garbage", () => {
    const rendered = formatWarrantyUntil("2027-08-12");
    expect(rendered).not.toBeNull();
    expect(rendered!).toContain("2027");
    // A yyyy-mm-dd shorthand renders a date, not a time.
    expect(rendered!).not.toContain(":");

    expect(formatWarrantyUntil(null)).toBeNull();
    expect(formatWarrantyUntil("")).toBeNull();
    expect(formatWarrantyUntil("not-a-date")).toBeNull();
  });
});
