/**
 * Presentation logic for the approvals inbox: payload summaries, request age,
 * badge tones. Pure functions, no I/O.
 */
import { enumLabel, t, type Lang } from "./i18n.js";
import { formatMinor } from "./money.js";
import { shortId, type BadgeTone } from "./movements.js";

/**
 * One-line summary of an approval payload.
 * - refund: AED amount (payload.amountMinor) + the order it belongs to.
 * - stock_count: how many variances the count produced.
 */
export function summarizeApprovalPayload(
  kind: string,
  payload: Record<string, unknown>,
  lang: Lang = "en",
): string {
  if (kind === "refund") {
    const amountMinor = typeof payload.amountMinor === "number" ? payload.amountMinor : Number.NaN;
    const orderId = typeof payload.orderId === "string" ? payload.orderId : "";
    const amount = formatMinor(amountMinor);
    return orderId
      ? t(lang, "approvals.refundOn", { amount, order: shortId(orderId) })
      : t(lang, "approvals.refund", { amount });
  }
  if (kind === "stock_count") {
    const count = Array.isArray(payload.variances)
      ? payload.variances.length
      : typeof payload.varianceCount === "number"
        ? payload.varianceCount
        : null;
    if (count === null) return t(lang, "approvals.stockCount");
    return count === 1
      ? t(lang, "approvals.stockCountVarianceOne")
      : t(lang, "approvals.stockCountVariances", { count });
  }
  return enumLabel(lang, "kind", kind);
}

/** "just now" | "5m ago" | "3h ago" | "2d ago" — clamped at zero for clock skew. */
export function approvalAge(requestedAtIso: string, nowMs = Date.now(), lang: Lang = "en"): string {
  const ts = new Date(requestedAtIso).getTime();
  if (Number.isNaN(ts)) return "—";
  const minutes = Math.max(0, Math.floor((nowMs - ts) / 60_000));
  if (minutes < 1) return t(lang, "age.justNow");
  if (minutes < 60) return t(lang, "age.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(lang, "age.hours", { count: hours });
  return t(lang, "age.days", { count: Math.floor(hours / 24) });
}

/** Refunds move money out; stock counts are neutral corrections. */
export function approvalKindTone(kind: string): BadgeTone {
  return kind === "refund" ? "out" : "neutral";
}
