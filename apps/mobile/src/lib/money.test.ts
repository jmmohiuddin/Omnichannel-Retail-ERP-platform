import { describe, expect, it } from "vitest";
import { formatMinor, formatMinorCompact } from "./money";

/** Intl uses NBSP/narrow-NBSP between symbol and number — normalize for assertions. */
const norm = (s: string) => s.replace(/[\u00A0\u202F]/g, " ");

describe("money", () => {
  it("formats fils as AED via the en-AE locale", () => {
    expect(norm(formatMinor(129950))).toBe("AED 1,299.50");
    expect(norm(formatMinor(5))).toBe("AED 0.05");
    expect(norm(formatMinor(0))).toBe("AED 0.00");
  });

  it("supports other currency codes", () => {
    expect(norm(formatMinor(10000, "USD"))).toContain("100.00");
  });

  it("renders a dash for non-finite input instead of NaN garbage", () => {
    expect(formatMinor(Number.NaN)).toBe("—");
    expect(formatMinor(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatMinorCompact(Number.NaN)).toBe("—");
  });

  it("compact form rounds to whole dirhams for dashboard cards", () => {
    expect(norm(formatMinorCompact(129950))).toBe("AED 1,300");
    expect(norm(formatMinorCompact(129949))).toBe("AED 1,299");
  });
});
