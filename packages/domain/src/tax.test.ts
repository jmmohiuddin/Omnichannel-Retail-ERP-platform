import { describe, expect, it } from "vitest";
import { lineTotals, saleTotals, vatFromInclusive } from "./tax.js";

describe("vatFromInclusive (UAE 5% = 500bp)", () => {
  it("extracts VAT from inclusive price", () => {
    // AED 105.00 inclusive at 5% → 5.00 VAT, 100.00 net
    expect(vatFromInclusive(10500, 500)).toBe(500);
    // AED 4199.00 phone → VAT = 4199 × 5/105 = 199.952… → 199.95
    expect(vatFromInclusive(419900, 500)).toBe(19995);
  });

  it("handles zero rate and zero amount", () => {
    expect(vatFromInclusive(10000, 0)).toBe(0);
    expect(vatFromInclusive(0, 500)).toBe(0);
  });

  it("rejects non-integer or negative input", () => {
    expect(() => vatFromInclusive(10.5, 500)).toThrow(RangeError);
    expect(() => vatFromInclusive(-1, 500)).toThrow(RangeError);
    expect(() => vatFromInclusive(100, 20000)).toThrow(RangeError);
  });
});

describe("lineTotals", () => {
  it("computes gross/tax/net with quantity", () => {
    const line = lineTotals(10500, 2, 500);
    expect(line).toEqual({ grossMinor: 21000, taxMinor: 1000, netMinor: 20000 });
  });

  it("applies line discount before VAT extraction", () => {
    const line = lineTotals(10500, 1, 500, 500); // 105.00 − 5.00 discount
    expect(line.grossMinor).toBe(10000);
    expect(line.taxMinor).toBe(476); // 100.00 × 5/105 = 4.7619 → 4.76
  });

  it("rejects discount larger than the line", () => {
    expect(() => lineTotals(1000, 1, 500, 2000)).toThrow(RangeError);
  });
});

describe("saleTotals", () => {
  it("sums per-line VAT (invoice-consistent)", () => {
    const totals = saleTotals([
      lineTotals(419900, 1, 500), // phone
      lineTotals(8900, 2, 500),   // two chargers
    ]);
    expect(totals.subtotalMinor).toBe(419900 + 17800);
    expect(totals.taxMinor).toBe(19995 + 848); // 178.00 × 5/105 = 8.476 → 8.48
    expect(totals.totalMinor).toBe(totals.subtotalMinor);
    expect(totals.netMinor + totals.taxMinor).toBe(totals.totalMinor);
  });
});
