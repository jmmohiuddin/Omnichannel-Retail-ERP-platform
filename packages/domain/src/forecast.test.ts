import { describe, expect, it } from "vitest";
import { detectDeadStock, forecastDemand, reorderSuggestion } from "./forecast.js";

const flatWeek = (weeks: number, perDay: number) => {
  const rows = [];
  const start = Date.UTC(2026, 5, 1); // 2026-06-01, a Monday
  for (let d = 0; d < weeks * 7; d++) {
    const date = new Date(start + d * 86_400_000).toISOString().slice(0, 10);
    rows.push({ date, quantity: perDay });
  }
  return rows;
};

describe("forecastDemand", () => {
  it("flat demand forecasts flat", () => {
    const f = forecastDemand(flatWeek(8, 2), 56, 14);
    expect(f.dailyMean).toBe(2);
    expect(f.horizonTotal).toBe(28);
    expect(f.confidence).toBe("high");
  });

  it("weekend-heavy demand shows up in the horizon via weekday seasonality", () => {
    // 4 weeks: 10/day on Fridays only (2026-06-05 is a Friday)
    const rows = [];
    for (let w = 0; w < 4; w++) {
      const date = new Date(Date.UTC(2026, 5, 5) + w * 7 * 86_400_000)
        .toISOString().slice(0, 10);
      rows.push({ date, quantity: 10 });
    }
    const f = forecastDemand(rows, 28, 7);
    expect(f.dailyMean).toBeCloseTo(10 / 7, 2);
    expect(f.horizonTotal).toBeCloseTo(10, 1); // one Friday per week
    expect(f.confidence).toBe("medium");
  });

  it("sparse data is labeled low confidence", () => {
    const f = forecastDemand([{ date: "2026-08-01", quantity: 1 }], 7, 7);
    expect(f.confidence).toBe("low");
  });

  it("rejects invalid windows", () => {
    expect(() => forecastDemand([], 0, 7)).toThrow(RangeError);
  });
});

describe("reorderSuggestion", () => {
  const forecast = { dailyMean: 2, horizonTotal: 28, observedDays: 56, confidence: "high" as const };

  it("does not reorder when position is comfortably above the reorder point", () => {
    const s = reorderSuggestion(forecast, 50, 0, { leadTimeDays: 7 });
    expect(s.reorder).toBe(false);
    expect(s.suggestedQty).toBe(0);
    expect(s.daysOfCoverLeft).toBe(25);
  });

  it("reorders up to target when position is below the reorder point", () => {
    const s = reorderSuggestion(forecast, 5, 0, { leadTimeDays: 7 });
    expect(s.reorder).toBe(true);
    // target = 2×(7+7) + 1.64×√2×√7 ≈ 28 + 6.14 → order ≈ 30
    expect(s.suggestedQty).toBeGreaterThanOrEqual(28);
    expect(s.suggestedQty).toBeLessThanOrEqual(31);
    expect(s.rationale).toContain("high-confidence");
  });

  it("incoming stock counts toward the position", () => {
    const without = reorderSuggestion(forecast, 5, 0, { leadTimeDays: 7 });
    const withIncoming = reorderSuggestion(forecast, 5, 40, { leadTimeDays: 7 });
    expect(without.reorder).toBe(true);
    expect(withIncoming.reorder).toBe(false);
  });

  it("zero-demand item never triggers a reorder and has null cover", () => {
    const s = reorderSuggestion(
      { dailyMean: 0, horizonTotal: 0, observedDays: 56, confidence: "high" },
      3, 0, { leadTimeDays: 7 },
    );
    expect(s.reorder).toBe(false);
    expect(s.daysOfCoverLeft).toBeNull();
  });
});

describe("detectDeadStock", () => {
  it("flags never-sold and stale stock, sorted by tied-up value", () => {
    const dead = detectDeadStock(
      [
        { variantId: "a", onHand: 10, unitCostMinor: 1000, lastSaleDaysAgo: 120 },
        { variantId: "b", onHand: 5, unitCostMinor: 100000, lastSaleDaysAgo: null },
        { variantId: "c", onHand: 8, unitCostMinor: 500, lastSaleDaysAgo: 10 },
        { variantId: "d", onHand: 0, unitCostMinor: 999, lastSaleDaysAgo: null },
      ],
      90,
    );
    expect(dead.map((d) => d.variantId)).toEqual(["b", "a"]);
    expect(dead[0]!.stockValueMinor).toBe(500000);
  });
});
