/**
 * Demand forecasting & replenishment math (AI module's statistical baseline).
 *
 * Numeric predictions come from classical methods (moving average + weekly
 * seasonality), never from an LLM — the LLM layer (when enabled) explains and
 * narrates these numbers, it does not invent them (ADR-009). Honest-confidence
 * rule: every output carries the data-sufficiency behind it.
 */

export interface DailySales {
  /** ISO date (yyyy-mm-dd). */
  date: string;
  quantity: number;
}

export interface DemandForecast {
  /** Average expected daily demand. */
  dailyMean: number;
  /** Forecast for the next `horizonDays`, seasonality-adjusted per weekday. */
  horizonTotal: number;
  /** sample size the estimate rests on */
  observedDays: number;
  confidence: "low" | "medium" | "high";
}

export interface ReorderSuggestion {
  reorder: boolean;
  reorderPoint: number;
  suggestedQty: number;
  daysOfCoverLeft: number | null;
  rationale: string;
}

const dayOfWeek = (isoDate: string): number => {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
};

/**
 * Weekly-seasonal naive forecast: per-weekday means where data allows,
 * global mean otherwise. `sales` may omit zero-sale days; `windowDays` is the
 * observation window the series was drawn from.
 */
export function forecastDemand(
  sales: DailySales[],
  windowDays: number,
  horizonDays: number,
): DemandForecast {
  if (windowDays <= 0 || horizonDays <= 0) {
    throw new RangeError("windowDays and horizonDays must be positive");
  }
  const total = sales.reduce((s, r) => s + r.quantity, 0);
  const dailyMean = total / windowDays;

  // Per-weekday averages (zero-filled: days absent from the series sold 0).
  const perDow = new Array<number>(7).fill(0);
  for (const row of sales) perDow[dayOfWeek(row.date)]! += row.quantity;
  const weeksObserved = windowDays / 7;
  const dowMeans = perDow.map((q) => q / weeksObserved);

  let horizonTotal = 0;
  for (let i = 0; i < horizonDays; i++) {
    // Without an anchor date the horizon cycles all weekdays evenly.
    horizonTotal += weeksObserved >= 2 ? dowMeans[i % 7]! : dailyMean;
  }

  const confidence: DemandForecast["confidence"] =
    windowDays >= 56 && total >= 20 ? "high"
    : windowDays >= 28 && total >= 5 ? "medium"
    : "low";

  return {
    dailyMean: round2(dailyMean),
    horizonTotal: round2(horizonTotal),
    observedDays: windowDays,
    confidence,
  };
}

/**
 * Classic reorder point: demand over lead time + safety stock, where safety
 * stock = z × σ_daily × √leadTime. We approximate σ with √mean (Poisson-ish
 * retail demand) when the series is too sparse to estimate properly.
 */
export function reorderSuggestion(
  forecast: DemandForecast,
  onHand: number,
  incoming: number,
  opts: { leadTimeDays: number; reviewPeriodDays?: number; serviceZ?: number },
): ReorderSuggestion {
  const { leadTimeDays } = opts;
  const review = opts.reviewPeriodDays ?? 7;
  const z = opts.serviceZ ?? 1.64; // ~95% service level
  if (leadTimeDays <= 0) throw new RangeError("leadTimeDays must be positive");

  const sigmaDaily = Math.sqrt(Math.max(forecast.dailyMean, 0));
  const safety = z * sigmaDaily * Math.sqrt(leadTimeDays);
  const reorderPoint = forecast.dailyMean * leadTimeDays + safety;
  const position = onHand + incoming;

  const daysOfCoverLeft =
    forecast.dailyMean > 0 ? round2(position / forecast.dailyMean) : null;

  if (position > reorderPoint) {
    return {
      reorder: false,
      reorderPoint: round2(reorderPoint),
      suggestedQty: 0,
      daysOfCoverLeft,
      rationale: `position ${position} exceeds reorder point ${round2(reorderPoint)}`,
    };
  }
  // Order up to: demand over lead time + review period, plus safety stock.
  const target = forecast.dailyMean * (leadTimeDays + review) + safety;
  const qty = Math.max(0, Math.ceil(target - position));
  return {
    reorder: qty > 0,
    reorderPoint: round2(reorderPoint),
    suggestedQty: qty,
    daysOfCoverLeft,
    rationale:
      `position ${position} ≤ reorder point ${round2(reorderPoint)}; ` +
      `order up to ${round2(target)} (${forecast.confidence}-confidence forecast)`,
  };
}

export interface DeadStockItem {
  variantId: string;
  onHand: number;
  daysSinceLastSale: number | null; // null = never sold
  stockValueMinor: number;
}

/** Dead stock: on-hand items with no sale in `thresholdDays`. */
export function detectDeadStock(
  items: {
    variantId: string;
    onHand: number;
    unitCostMinor: number;
    lastSaleDaysAgo: number | null;
  }[],
  thresholdDays: number,
): DeadStockItem[] {
  return items
    .filter(
      (i) => i.onHand > 0 && (i.lastSaleDaysAgo === null || i.lastSaleDaysAgo >= thresholdDays),
    )
    .map((i) => ({
      variantId: i.variantId,
      onHand: i.onHand,
      daysSinceLastSale: i.lastSaleDaysAgo,
      stockValueMinor: Math.round(i.onHand * i.unitCostMinor),
    }))
    .sort((a, b) => b.stockValueMinor - a.stockValueMinor);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
