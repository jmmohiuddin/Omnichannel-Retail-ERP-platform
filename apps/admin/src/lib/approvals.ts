/**
 * Presentation logic for the approvals inbox: payload summaries, request age,
 * badge tones. Pure functions, no I/O.
 */
import { formatMinor } from "./money.js";
import { humanState, shortId, type BadgeTone } from "./movements.js";

/**
 * One-line summary of an approval payload.
 * - refund: AED amount (payload.amountMinor) + the order it belongs to.
 * - stock_count: how many variances the count produced.
 */
export function summarizeApprovalPayload(kind: string, payload: Record<string, unknown>): string {
  if (kind === "refund") {
    const amountMinor = typeof payload.amountMinor === "number" ? payload.amountMinor : Number.NaN;
    const orderId = typeof payload.orderId === "string" ? payload.orderId : "";
    const amount = formatMinor(amountMinor);
    return orderId ? `Refund ${amount} on order ${shortId(orderId)}` : `Refund ${amount}`;
  }
  if (kind === "stock_count") {
    const count = Array.isArray(payload.variances)
      ? payload.variances.length
      : typeof payload.varianceCount === "number"
        ? payload.varianceCount
        : null;
    if (count === null) return "Stock count";
    return `Stock count · ${count} variance${count === 1 ? "" : "s"}`;
  }
  return humanState(kind);
}

/** "just now" | "5m ago" | "3h ago" | "2d ago" — clamped at zero for clock skew. */
export function approvalAge(requestedAtIso: string, nowMs = Date.now()): string {
  const t = new Date(requestedAtIso).getTime();
  if (Number.isNaN(t)) return "—";
  const minutes = Math.max(0, Math.floor((nowMs - t) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Refunds move money out; stock counts are neutral corrections. */
export function approvalKindTone(kind: string): BadgeTone {
  return kind === "refund" ? "out" : "neutral";
}
