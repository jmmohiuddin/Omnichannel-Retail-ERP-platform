import { describe, expect, it } from "vitest";
import { formatMinor } from "./money.js";

describe("formatMinor (AED from fils)", () => {
  it("formats whole dirham amounts", () => {
    expect(formatMinor(10500)).toBe("AED 105.00");
  });

  it("formats fils as the two decimal places", () => {
    expect(formatMinor(1250)).toBe("AED 12.50");
    expect(formatMinor(1)).toBe("AED 0.01");
  });

  it("formats zero", () => {
    expect(formatMinor(0)).toBe("AED 0.00");
  });

  it("groups thousands per en-AE", () => {
    expect(formatMinor(123456789)).toBe("AED 1,234,567.89");
  });

  it("formats negative amounts (refunds)", () => {
    expect(formatMinor(-1250)).toBe("-AED 12.50");
  });

  it("supports other currencies for multi-currency price lists", () => {
    expect(formatMinor(9900, "USD")).toBe("$99.00");
  });

  it("rejects non-integer minor units — money is never a float", () => {
    expect(() => formatMinor(12.5)).toThrow(TypeError);
  });
});
