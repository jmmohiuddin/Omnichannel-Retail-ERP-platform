import type { AiCompletionResult, AiGateway } from "./gateway.js";

/**
 * Daily digest prompt builder (ADR-009). The analytics layer produces every
 * number (see analytics/analyticsService.ts); the LLM only narrates them.
 * buildDailyDigestPrompt is pure so prompt content is fully unit-testable.
 */

export interface DailyDigestData {
  /** AnalyticsService.summary() output. */
  summary: Record<string, unknown>;
  /** AnalyticsService.reorderSuggestions() output. */
  reorder: unknown[];
  /** AnalyticsService.deadStock() output. */
  deadStock: unknown[];
  /** AnalyticsService.exceptions() output. */
  exceptions: Record<string, unknown>;
}

/**
 * Format a BIGINT minor-unit amount as an AED display string.
 * AED has 2 decimal places: 1234567 minor units -> "AED 12,345.67".
 */
export function formatAedMinor(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.round(minor));
  const major = Math.floor(abs / 100);
  const fils = String(abs % 100).padStart(2, "0");
  const grouped = major.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}AED ${grouped}.${fils}`;
}

const SYSTEM_PROMPT = `You are a retail operations analyst for a UAE (Dubai) retailer, writing a daily operations digest for the store owner.

Rules — follow every one of them:
- You must ONLY reference figures present in the provided JSON data. Never fabricate, estimate, or extrapolate numbers that are not in the data. If a figure is missing, say so rather than inventing one.
- All monetary values in the data are AED minor units (fils). Format them as AED with 2 decimal places and thousands separators, e.g. 1234567 minor units is ${formatAedMinor(1234567)}.
- Keep the digest to approximately 250 words.
- Forecasts are statistical baselines. Flag any low-confidence forecast as tentative and state its confidence honestly; do not present tentative numbers as certain.
- Structure: today's sales, then reorder priorities, then dead stock worth attention, then refund/approval exceptions to review.
- Plain, direct business language. No markdown headers, no preamble.`;

export function buildDailyDigestPrompt(data: DailyDigestData): {
  system: string;
  user: string;
} {
  const user = [
    "Write today's operations digest from the JSON below. Reference only these figures.",
    "",
    "## summary",
    JSON.stringify(data.summary),
    "",
    "## reorderSuggestions",
    JSON.stringify(data.reorder),
    "",
    "## deadStock",
    JSON.stringify(data.deadStock),
    "",
    "## exceptions",
    JSON.stringify(data.exceptions),
  ].join("\n");
  return { system: SYSTEM_PROMPT, user };
}

/** Generate the daily digest for a tenant via the governed AI gateway. */
export async function generateDailyDigest(
  gateway: AiGateway,
  tenantId: string,
  data: DailyDigestData,
): Promise<AiCompletionResult> {
  const { system, user } = buildDailyDigestPrompt(data);
  return gateway.narrate(tenantId, "daily_digest", system, user);
}
