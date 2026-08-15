import { lineTotals, saleTotals } from "@omniretail/domain";
import { describe, expect, it } from "vitest";
import { cartReducer, cartTotals, hasStockUnit, lineTotalMinor, type CartLine } from "./cart.js";

const phone = {
  variantId: "v-phone",
  sku: "IP15-128-BLK",
  name: "iPhone 15 128GB Black",
  unitPriceMinor: 315000, // AED 3,150.00 VAT-inclusive
  currency: "AED",
};

const cable = {
  variantId: "v-cable",
  sku: "CBL-USBC",
  name: "USB-C Cable",
  unitPriceMinor: 2100, // AED 21.00
  currency: "AED",
};

describe("cartReducer", () => {
  it("adds a new line with quantity 1", () => {
    const cart = cartReducer([], { type: "add", line: phone });
    expect(cart).toHaveLength(1);
    expect(cart[0]).toMatchObject({ variantId: "v-phone", quantity: 1 });
  });

  it("increments quantity when the same variant is added again", () => {
    let cart = cartReducer([], { type: "add", line: phone });
    cart = cartReducer(cart, { type: "add", line: phone });
    expect(cart).toHaveLength(1);
    expect(cart[0]!.quantity).toBe(2);
  });

  it("keeps distinct variants as separate lines", () => {
    let cart = cartReducer([], { type: "add", line: phone });
    cart = cartReducer(cart, { type: "add", line: cable });
    expect(cart).toHaveLength(2);
  });

  it("increment/decrement adjust quantity", () => {
    let cart = cartReducer([], { type: "add", line: cable });
    cart = cartReducer(cart, { type: "increment", variantId: "v-cable" });
    cart = cartReducer(cart, { type: "increment", variantId: "v-cable" });
    expect(cart[0]!.quantity).toBe(3);
    cart = cartReducer(cart, { type: "decrement", variantId: "v-cable" });
    expect(cart[0]!.quantity).toBe(2);
  });

  it("decrementing to zero removes the line", () => {
    let cart = cartReducer([], { type: "add", line: cable });
    cart = cartReducer(cart, { type: "decrement", variantId: "v-cable" });
    expect(cart).toHaveLength(0);
  });

  it("remove drops the line regardless of quantity", () => {
    let cart = cartReducer([], { type: "add", line: phone });
    cart = cartReducer(cart, { type: "increment", variantId: "v-phone" });
    cart = cartReducer(cart, { type: "remove", variantId: "v-phone" });
    expect(cart).toHaveLength(0);
  });

  it("clear empties the cart", () => {
    let cart = cartReducer([], { type: "add", line: phone });
    cart = cartReducer(cart, { type: "add", line: cable });
    expect(cartReducer(cart, { type: "clear" })).toHaveLength(0);
  });

  it("serialized lines (stockUnitId) are unique and never increment", () => {
    const serialized = { ...phone, stockUnitId: "unit-1" };
    let cart = cartReducer([], { type: "add", line: serialized });
    cart = cartReducer(cart, { type: "add", line: serialized });
    expect(cart).toHaveLength(1);
    expect(cart[0]!.quantity).toBe(1);
    cart = cartReducer(cart, { type: "increment", variantId: "v-phone" });
    expect(cart[0]!.quantity).toBe(1);
  });

  it("decrement never touches a serialized line — qty stays locked at 1", () => {
    const serialized = { ...phone, stockUnitId: "unit-1", imei: "490154203237518" };
    let cart = cartReducer([], { type: "add", line: serialized });
    cart = cartReducer(cart, { type: "decrement", variantId: "v-phone" });
    expect(cart).toHaveLength(1);
    expect(cart[0]!.quantity).toBe(1);
    expect(cart[0]!.imei).toBe("490154203237518");
  });

  it("two different units of the same variant are separate lines", () => {
    let cart = cartReducer([], { type: "add", line: { ...phone, stockUnitId: "unit-1" } });
    cart = cartReducer(cart, { type: "add", line: { ...phone, stockUnitId: "unit-2" } });
    expect(cart).toHaveLength(2);
    expect(cart.every((l) => l.quantity === 1)).toBe(true);
  });

  it("remove with stockUnitId removes only that unit's line", () => {
    let cart = cartReducer([], { type: "add", line: { ...phone, stockUnitId: "unit-1" } });
    cart = cartReducer(cart, { type: "add", line: { ...phone, stockUnitId: "unit-2" } });
    cart = cartReducer(cart, { type: "remove", variantId: "v-phone", stockUnitId: "unit-1" });
    expect(cart).toHaveLength(1);
    expect(cart[0]!.stockUnitId).toBe("unit-2");
  });

  it("hasStockUnit is the duplicate-unit guard for scan handling", () => {
    const cart = cartReducer([], { type: "add", line: { ...phone, stockUnitId: "unit-1" } });
    expect(hasStockUnit(cart, "unit-1")).toBe(true);
    expect(hasStockUnit(cart, "unit-2")).toBe(false);
    expect(hasStockUnit([], "unit-1")).toBe(false);
  });
});

describe("cartTotals — VAT included in retail prices, at the tenant's rate", () => {
  it("returns zeros for an empty cart", () => {
    expect(cartTotals([], 500)).toEqual({
      subtotalMinor: 0,
      taxMinor: 0,
      totalMinor: 0,
      itemCount: 0,
    });
  });

  it("carves the VAT portion out of the gross total", () => {
    // Gross AED 105.00 -> net 100.00 + VAT 5.00
    const lines: CartLine[] = [{ ...cable, unitPriceMinor: 10500, quantity: 1 }];
    expect(cartTotals(lines, 500)).toEqual({
      subtotalMinor: 10000,
      taxMinor: 500,
      totalMinor: 10500,
      itemCount: 1,
    });
  });

  it("total is the exact sum of line totals (customer pays the sticker price)", () => {
    const lines: CartLine[] = [
      { ...phone, quantity: 2 },
      { ...cable, quantity: 3 },
    ];
    const totals = cartTotals(lines, 500);
    expect(totals.totalMinor).toBe(2 * 315000 + 3 * 2100);
    expect(totals.subtotalMinor + totals.taxMinor).toBe(totals.totalMinor);
    expect(totals.itemCount).toBe(5);
  });

  it("rounds the VAT portion to whole fils", () => {
    // Gross 100 fils -> VAT = 100 * 5/105 = 4.7619 -> 5 fils
    const lines: CartLine[] = [{ ...cable, unitPriceMinor: 100, quantity: 1 }];
    const totals = cartTotals(lines, 500);
    expect(totals.taxMinor).toBe(5);
    expect(totals.subtotalMinor).toBe(95);
    expect(Number.isInteger(totals.taxMinor)).toBe(true);
  });

  /* ---------------- R7.4: the rate is the tenant's, not 5% ---------------- */

  it("uses the tenant's rate: a 10% tenant carves 10%, not 5%", () => {
    // Gross AED 110.00 at 1000 bp -> net 100.00 + VAT 10.00.
    // Under the old hardcoded 500 bp this returned 524 fils of VAT.
    const lines: CartLine[] = [{ ...cable, unitPriceMinor: 11000, quantity: 1 }];
    expect(cartTotals(lines, 1000)).toEqual({
      subtotalMinor: 10000,
      taxMinor: 1000,
      totalMinor: 11000,
      itemCount: 1,
    });
  });

  it("a rate change changes only the tax split, never what the customer pays", () => {
    const lines: CartLine[] = [{ ...phone, quantity: 1 }];
    const at5 = cartTotals(lines, 500);
    const at75 = cartTotals(lines, 750);
    expect(at75.totalMinor).toBe(at5.totalMinor); // sticker price is the sticker price
    expect(at75.taxMinor).toBeGreaterThan(at5.taxMinor);
    expect(at75.subtotalMinor + at75.taxMinor).toBe(at75.totalMinor);
    // 315000 * 750 / 10750 = 21976.74 -> 21977
    expect(at75.taxMinor).toBe(21977);
  });

  it("a zero-rated tenant is charged no VAT at all", () => {
    const lines: CartLine[] = [{ ...cable, quantity: 2 }];
    expect(cartTotals(lines, 0)).toEqual({
      subtotalMinor: 4200,
      taxMinor: 0,
      totalMinor: 4200,
      itemCount: 2,
    });
  });

  it("sums VAT per line, exactly as the server bills it", () => {
    // Three 100-fils lines: per line 5+5+5 = 15 (what SalesService computes).
    // Carving from the 300-fils aggregate would give round(14.28) = 14 — a
    // till screen that disagreed with the customer's tax invoice by a fils.
    const lines: CartLine[] = [
      { ...cable, variantId: "a", unitPriceMinor: 100, quantity: 1 },
      { ...cable, variantId: "b", unitPriceMinor: 100, quantity: 1 },
      { ...cable, variantId: "c", unitPriceMinor: 100, quantity: 1 },
    ];
    expect(cartTotals(lines, 500).taxMinor).toBe(15);
  });

  it("agrees with the domain tax core the server bills with", () => {
    const lines: CartLine[] = [
      { ...phone, quantity: 2 },
      { ...cable, quantity: 3 },
    ];
    for (const rateBp of [0, 500, 750, 1000]) {
      const expected = saleTotals(
        lines.map((l) => lineTotals(l.unitPriceMinor, l.quantity, rateBp)),
      );
      const actual = cartTotals(lines, rateBp);
      expect(actual.taxMinor).toBe(expected.taxMinor);
      expect(actual.totalMinor).toBe(expected.totalMinor);
      expect(actual.subtotalMinor).toBe(expected.netMinor);
    }
  });

  it("holds no rate of its own — the constant is gone and cannot return as a default", async () => {
    // The defect was a module-level VAT_RATE_BPS = 500.
    const cartModule: Record<string, unknown> = await import("./cart.js");
    expect(Object.keys(cartModule)).not.toContain("VAT_RATE_BPS");
    // Arity 2: a default value for vatRateBp would report 1, and would be the
    // same defect back again — every caller must state the tenant's rate.
    expect(cartTotals.length).toBe(2);
  });

  it("lineTotalMinor multiplies in integer minor units", () => {
    expect(lineTotalMinor({ ...phone, quantity: 3 })).toBe(945000);
  });
});
