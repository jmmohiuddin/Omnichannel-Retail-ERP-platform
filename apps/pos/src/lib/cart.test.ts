import { describe, expect, it } from "vitest";
import { cartReducer, cartTotals, lineTotalMinor, type CartLine } from "./cart.js";

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
});

describe("cartTotals — 5% VAT included in retail prices", () => {
  it("returns zeros for an empty cart", () => {
    expect(cartTotals([])).toEqual({ subtotalMinor: 0, taxMinor: 0, totalMinor: 0, itemCount: 0 });
  });

  it("carves the VAT portion out of the gross total", () => {
    // Gross AED 105.00 -> net 100.00 + VAT 5.00
    const lines: CartLine[] = [{ ...cable, unitPriceMinor: 10500, quantity: 1 }];
    expect(cartTotals(lines)).toEqual({
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
    const totals = cartTotals(lines);
    expect(totals.totalMinor).toBe(2 * 315000 + 3 * 2100);
    expect(totals.subtotalMinor + totals.taxMinor).toBe(totals.totalMinor);
    expect(totals.itemCount).toBe(5);
  });

  it("rounds the VAT portion to whole fils", () => {
    // Gross 100 fils -> VAT = 100 * 5/105 = 4.7619 -> 5 fils
    const lines: CartLine[] = [{ ...cable, unitPriceMinor: 100, quantity: 1 }];
    const totals = cartTotals(lines);
    expect(totals.taxMinor).toBe(5);
    expect(totals.subtotalMinor).toBe(95);
    expect(Number.isInteger(totals.taxMinor)).toBe(true);
  });

  it("lineTotalMinor multiplies in integer minor units", () => {
    expect(lineTotalMinor({ ...phone, quantity: 3 })).toBe(945000);
  });
});
