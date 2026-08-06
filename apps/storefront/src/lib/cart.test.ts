import { describe, expect, it } from "vitest";
import {
  addLine,
  cartKey,
  cartTotalMinor,
  CartStore,
  itemCount,
  loadCart,
  removeLine,
  saveCart,
  setQuantity,
  type CartLine,
  type CartStorage,
} from "./cart.js";

function line(overrides: Partial<CartLine> = {}): Omit<CartLine, "quantity"> {
  return {
    variantId: "v1",
    productSlug: "iphone-15",
    productName: "iPhone 15",
    sku: "IP15-BLK-128",
    priceMinor: 329900,
    currency: "AED",
    ...overrides,
  };
}

function stubStorage(): CartStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("addLine", () => {
  it("adds a new line with the requested quantity", () => {
    const lines = addLine([], line(), 2);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.quantity).toBe(2);
  });

  it("merges quantities for the same variantId", () => {
    let lines = addLine([], line(), 1);
    lines = addLine(lines, line(), 3);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.quantity).toBe(4);
  });

  it("keeps distinct variants as separate lines", () => {
    let lines = addLine([], line(), 1);
    lines = addLine(lines, line({ variantId: "v2", sku: "IP15-BLU-256" }), 1);
    expect(lines).toHaveLength(2);
  });

  it("ignores zero and negative quantities", () => {
    expect(addLine([], line(), 0)).toHaveLength(0);
    expect(addLine([], line(), -3)).toHaveLength(0);
  });
});

describe("setQuantity / removeLine", () => {
  it("sets an explicit quantity", () => {
    const lines = setQuantity(addLine([], line(), 1), "v1", 5);
    expect(lines[0]?.quantity).toBe(5);
  });

  it("removes the line when quantity drops to zero", () => {
    const lines = setQuantity(addLine([], line(), 2), "v1", 0);
    expect(lines).toHaveLength(0);
  });

  it("removes only the targeted variant", () => {
    let lines = addLine([], line(), 1);
    lines = addLine(lines, line({ variantId: "v2" }), 1);
    lines = removeLine(lines, "v1");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.variantId).toBe("v2");
  });
});

describe("totals", () => {
  it("computes the VAT-inclusive total with integer math", () => {
    let lines = addLine([], line({ priceMinor: 329900 }), 2); // 6598.00
    lines = addLine(lines, line({ variantId: "v2", priceMinor: 4999 }), 3); // 149.97
    expect(cartTotalMinor(lines)).toBe(329900 * 2 + 4999 * 3);
  });

  it("counts items across lines", () => {
    let lines = addLine([], line(), 2);
    lines = addLine(lines, line({ variantId: "v2" }), 3);
    expect(itemCount(lines)).toBe(5);
    expect(itemCount([])).toBe(0);
  });
});

describe("persistence (stubbed storage)", () => {
  it("round-trips a cart through storage per slug", () => {
    const storage = stubStorage();
    const lines = addLine(addLine([], line(), 2), line({ variantId: "v2", priceMinor: 4999 }), 1);
    saveCart("deira-phones", lines, storage);
    expect(storage.map.has(cartKey("deira-phones"))).toBe(true);
    expect(loadCart("deira-phones", storage)).toEqual(lines);
    // Another slug's cart is independent.
    expect(loadCart("other-store", storage)).toEqual([]);
  });

  it("clears the storage key when the cart empties", () => {
    const storage = stubStorage();
    saveCart("s", addLine([], line(), 1), storage);
    saveCart("s", [], storage);
    expect(storage.map.has(cartKey("s"))).toBe(false);
  });

  it("returns an empty cart for corrupt or malformed data", () => {
    const storage = stubStorage();
    storage.setItem(cartKey("s"), "not json {{{");
    expect(loadCart("s", storage)).toEqual([]);
    storage.setItem(cartKey("s"), JSON.stringify({ hello: "world" }));
    expect(loadCart("s", storage)).toEqual([]);
    storage.setItem(cartKey("s"), JSON.stringify([{ variantId: "v1" }]));
    expect(loadCart("s", storage)).toEqual([]);
  });

  it("CartStore persists mutations and notifies subscribers", () => {
    const storage = stubStorage();
    const store = new CartStore("s", storage);
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });

    store.add(line(), 2);
    store.setQuantity("v1", 5);
    expect(notified).toBe(2);
    expect(loadCart("s", storage)[0]?.quantity).toBe(5);

    // A fresh store for the same slug rehydrates from storage.
    const rehydrated = new CartStore("s", storage);
    expect(rehydrated.getLines()).toEqual(store.getLines());

    store.clear();
    expect(store.getLines()).toEqual([]);
    expect(storage.map.has(cartKey("s"))).toBe(false);
    unsubscribe();
  });
});
