import { describe, expect, it } from "vitest";
import { formatMinor, vatPortionMinor } from "./money.js";

describe("formatMinor", () => {
  it("formats fils as en-AE AED currency", () => {
    const out = formatMinor(329950);
    expect(out).toContain("3,299.50");
    expect(out).toContain("AED");
  });

  it("formats zero and small amounts", () => {
    expect(formatMinor(0)).toContain("0.00");
    expect(formatMinor(5)).toContain("0.05");
  });

  it("supports other currency codes", () => {
    const out = formatMinor(500, "USD");
    expect(out).toContain("5.00");
    expect(out).not.toContain("AED");
  });

  it("returns a dash for non-finite input", () => {
    expect(formatMinor(Number.NaN)).toBe("—");
    expect(formatMinor(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("vatPortionMinor (display-only 5% VAT breakdown)", () => {
  it("extracts the VAT portion from a VAT-inclusive total", () => {
    // AED 105.00 inclusive → AED 5.00 VAT
    expect(vatPortionMinor(10500)).toBe(500);
    // AED 1,050.00 inclusive → AED 50.00 VAT
    expect(vatPortionMinor(105000)).toBe(5000);
  });

  it("rounds to the nearest fil", () => {
    // 9999 * 500 / 10500 = 476.142... → 476
    expect(vatPortionMinor(9999)).toBe(476);
    // 100 * 500 / 10500 = 4.7619... → 5
    expect(vatPortionMinor(100)).toBe(5);
  });

  it("is zero for an empty cart and non-finite input", () => {
    expect(vatPortionMinor(0)).toBe(0);
    expect(vatPortionMinor(Number.NaN)).toBe(0);
  });
});
