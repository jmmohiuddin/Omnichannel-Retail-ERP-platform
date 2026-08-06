import { describe, expect, it } from "vitest";
import { loyaltyApplicableMinor, planPayments } from "./payments.js";

describe("loyaltyApplicableMinor", () => {
  it("caps the loyalty deduction at the remaining due", () => {
    expect(loyaltyApplicableMinor(10_000, 50_000)).toBe(10_000);
  });

  it("caps the loyalty deduction at the customer's balance", () => {
    expect(loyaltyApplicableMinor(10_500, 4_000)).toBe(4_000);
  });

  it("never goes negative for zero/negative inputs", () => {
    expect(loyaltyApplicableMinor(0, 4_000)).toBe(0);
    expect(loyaltyApplicableMinor(10_000, 0)).toBe(0);
    expect(loyaltyApplicableMinor(10_000, -5)).toBe(0);
  });
});

describe("planPayments — loyalty split-tender math", () => {
  it("sends loyalty first and the remainder to cash", () => {
    expect(planPayments(10_500, 4_000, "cash")).toEqual([
      { method: "loyalty_points", amountMinor: 4_000 },
      { method: "cash", amountMinor: 6_500 },
    ]);
  });

  it("sends the remainder to card when card is the chosen method", () => {
    expect(planPayments(31_500_0, 100_00, "card")).toEqual([
      { method: "loyalty_points", amountMinor: 100_00 },
      { method: "card", amountMinor: 305_000 },
    ]);
  });

  it("collapses to a single loyalty payment when points cover the total", () => {
    expect(planPayments(10_000, 25_000, "cash")).toEqual([
      { method: "loyalty_points", amountMinor: 10_000 },
    ]);
  });

  it("is a plain cash/card payment when no loyalty is applied", () => {
    expect(planPayments(10_500, 0, "cash")).toEqual([{ method: "cash", amountMinor: 10_500 }]);
  });

  it("payment amounts always sum to the amount due", () => {
    for (const [total, loyalty] of [
      [10_500, 4_000],
      [10_000, 25_000],
      [999, 999],
      [1, 0],
    ] as const) {
      const sum = planPayments(total, loyalty, "cash").reduce((s, p) => s + p.amountMinor, 0);
      expect(sum).toBe(total);
    }
  });
});
