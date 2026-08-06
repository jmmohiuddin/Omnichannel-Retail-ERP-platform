import { describe, expect, it } from "vitest";
import { decimalToMinor, formatMinor, minorToDecimal } from "./money.js";

describe("formatMinor", () => {
  it("formats fils minor units as en-AE AED currency", () => {
    const out = formatMinor(129950);
    expect(out).toContain("1,299.50");
    expect(out).toContain("AED");
  });

  it("formats zero", () => {
    expect(formatMinor(0)).toContain("0.00");
  });

  it("supports other currency codes (USD wholesale)", () => {
    const out = formatMinor(500, "USD");
    expect(out).toContain("5.00");
    expect(out).not.toContain("AED");
  });

  it("returns a dash for non-finite input", () => {
    expect(formatMinor(Number.NaN)).toBe("—");
  });
});

describe("decimalToMinor", () => {
  it("converts whole AED to fils", () => {
    expect(decimalToMinor("1299")).toBe(129900);
  });

  it("converts two-decimal amounts exactly (no float drift)", () => {
    expect(decimalToMinor("1299.50")).toBe(129950);
    expect(decimalToMinor("0.01")).toBe(1);
    // 19.99 * 100 === 1998.9999... under float math; integer math must not drift
    expect(decimalToMinor("19.99")).toBe(1999);
  });

  it("pads single-decimal input", () => {
    expect(decimalToMinor("5.5")).toBe(550);
  });

  it("trims surrounding whitespace", () => {
    expect(decimalToMinor("  12.34 ")).toBe(1234);
  });

  it("rejects malformed input", () => {
    expect(decimalToMinor("")).toBeNull();
    expect(decimalToMinor("abc")).toBeNull();
    expect(decimalToMinor("-5")).toBeNull();
    expect(decimalToMinor("1.234")).toBeNull();
    expect(decimalToMinor("1,299.50")).toBeNull();
    expect(decimalToMinor(".50")).toBeNull();
  });
});

describe("minorToDecimal", () => {
  it("round-trips with decimalToMinor", () => {
    expect(minorToDecimal(129950)).toBe("1299.50");
    expect(decimalToMinor(minorToDecimal(1999))).toBe(1999);
  });

  it("pads fractional part", () => {
    expect(minorToDecimal(5)).toBe("0.05");
    expect(minorToDecimal(100)).toBe("1.00");
  });

  it("handles negative amounts", () => {
    expect(minorToDecimal(-1250)).toBe("-12.50");
  });
});
