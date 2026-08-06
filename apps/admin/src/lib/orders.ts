/**
 * Order-management logic: status filter tabs, list query building, row-action
 * visibility, error mapping. Pure functions, no I/O.
 */
import { ApiError, type OrderStatus } from "./api.js";
import { t, type Lang } from "./i18n.js";
import type { BadgeTone } from "./movements.js";

export const ORDER_STATUS_FILTERS = [
  "all",
  "pending",
  "confirmed",
  "fulfilled",
  "cancelled",
  "refunded",
] as const;

export type OrderStatusFilter = (typeof ORDER_STATUS_FILTERS)[number];

/** Query string for GET /v1/orders — omits `status` for the "all" tab. */
export function buildOrdersQuery(filter: OrderStatusFilter, limit = 100): string {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("status", filter);
  params.set("limit", String(limit));
  return `?${params.toString()}`;
}

/** Fulfill is offered only while an order is still open (pending/confirmed). */
export function canFulfill(status: OrderStatus | string): boolean {
  return status === "pending" || status === "confirmed";
}

/** Cancel follows the same lifecycle rule as fulfill. */
export function canCancel(status: OrderStatus | string): boolean {
  return status === "pending" || status === "confirmed";
}

export function orderStatusTone(status: string): BadgeTone {
  if (status === "confirmed" || status === "fulfilled") return "in";
  if (status === "cancelled" || status === "refunded") return "out";
  return "neutral";
}

/**
 * 409 UNIT_REQUIRED means serialized units still need to be scanned at the
 * warehouse before the order can ship — surface that instead of the raw code.
 */
export function fulfillErrorMessage(err: unknown, lang: Lang = "en"): string {
  if (err instanceof ApiError && err.status === 409 && err.code === "UNIT_REQUIRED") {
    return t(lang, "orders.unitRequired");
  }
  return err instanceof Error ? err.message : t(lang, "orders.fulfillFailed");
}
