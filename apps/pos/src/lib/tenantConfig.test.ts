import { afterEach, describe, expect, it, vi } from "vitest";
import { cartTotals, type CartLine } from "./cart.js";
import {
  clearTenantConfig,
  formatRateBp,
  isValidVatRateBp,
  loadTenantConfig,
  resolveVatRate,
  saveTenantConfig,
  STATUTORY_VAT_RATE_BP,
  type ConfigStorage,
} from "./tenantConfig.js";

/** Stand-in for localStorage — the POS test env is node, with no DOM. */
function memoryStorage(seed: Record<string, string> = {}): ConfigStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isValidVatRateBp", () => {
  it("accepts whole basis points from 0 to 10000", () => {
    for (const bp of [0, 1, 500, 750, 1000, 10_000]) expect(isValidVatRateBp(bp)).toBe(true);
  });

  it("refuses anything that is not integer basis points", () => {
    for (const bad of [-1, 10_001, 5.5, "500", null, undefined, NaN, Infinity]) {
      expect(isValidVatRateBp(bad)).toBe(false);
    }
  });
});

describe("saveTenantConfig / loadTenantConfig", () => {
  it("round-trips the tenant's rate", () => {
    const storage = memoryStorage();
    expect(saveTenantConfig({ vatRateBp: 750 }, storage)).toBe(true);
    expect(loadTenantConfig(storage)).toEqual({ vatRateBp: 750 });
  });

  it("refuses to persist an invalid rate rather than caching a wrong one", () => {
    const storage = memoryStorage();
    expect(saveTenantConfig({ vatRateBp: 5 as number }, storage)).toBe(true); // 0.05% is odd but legal
    expect(saveTenantConfig({ vatRateBp: 12_000 }, storage)).toBe(false);
    expect(loadTenantConfig(storage)).toEqual({ vatRateBp: 5 });
  });

  it("treats corrupt or foreign storage entries as no rate at all", () => {
    for (const raw of ["not json", "null", '{"vatRateBp":"500"}', '{"vatRateBp":5.5}', "{}"]) {
      const storage = memoryStorage({ "omniretail.pos.tenantConfig": raw });
      expect(loadTenantConfig(storage)).toBeNull();
    }
  });

  it("survives storage that throws (quota, private mode) without taking the till down", () => {
    const throwing: ConfigStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(saveTenantConfig({ vatRateBp: 500 }, throwing)).toBe(false);
    expect(loadTenantConfig(throwing)).toBeNull();
    expect(() => clearTenantConfig(throwing)).not.toThrow();
  });

  it("clearTenantConfig drops the rate, so the next tenant cannot inherit it", () => {
    const storage = memoryStorage();
    saveTenantConfig({ vatRateBp: 1000 }, storage);
    clearTenantConfig(storage);
    expect(loadTenantConfig(storage)).toBeNull();
  });
});

describe("resolveVatRate", () => {
  it("reports a cached rate as coming from the tenant", () => {
    const storage = memoryStorage();
    saveTenantConfig({ vatRateBp: 1000 }, storage);
    expect(resolveVatRate(storage)).toEqual({ rateBp: 1000, source: "tenant" });
  });

  it("falls back to the statutory rate, flagged and logged, when none was ever issued", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveVatRate(memoryStorage())).toEqual({
      rateBp: STATUTORY_VAT_RATE_BP,
      source: "fallback",
    });
    // Never silent: the defect this fixes was a silent assumption of 5%.
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("the rate survives a reload — an offline shift keeps pricing correctly (R3.11)", () => {
  it("re-reads the tenant rate from register-local storage after a restart", () => {
    // Sign-in on a 7.5% tenant, online.
    const disk = memoryStorage();
    saveTenantConfig({ vatRateBp: 750 }, disk);

    // The register reboots mid-shift with no network. Nothing but storage
    // survives; a fresh module read is all the till has.
    const afterReload = resolveVatRate(memoryStorage(Object.fromEntries(disk.map)));

    expect(afterReload).toEqual({ rateBp: 750, source: "tenant" });

    // And the cart still prices at 7.5%, not the statutory default.
    const lines: CartLine[] = [
      { variantId: "v", sku: "S", name: "Item", unitPriceMinor: 10750, quantity: 1, currency: "AED" },
    ];
    expect(cartTotals(lines, afterReload.rateBp)).toEqual({
      subtotalMinor: 10000,
      taxMinor: 750,
      totalMinor: 10750,
      itemCount: 1,
    });
  });
});

describe("formatRateBp", () => {
  it("prints basis points as a percentage without float artefacts", () => {
    expect(formatRateBp(0)).toBe("0");
    expect(formatRateBp(500)).toBe("5");
    expect(formatRateBp(750)).toBe("7.5");
    expect(formatRateBp(510)).toBe("5.1");
    expect(formatRateBp(505)).toBe("5.05");
    expect(formatRateBp(1000)).toBe("10");
    expect(formatRateBp(10_000)).toBe("100");
  });

  it("refuses to render a rate that is not valid basis points", () => {
    expect(() => formatRateBp(5.5)).toThrow(RangeError);
    expect(() => formatRateBp(-100)).toThrow(RangeError);
  });
});
