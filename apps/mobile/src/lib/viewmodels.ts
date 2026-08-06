/**
 * Per-screen view-models: pure functions mapping API DTOs to display-ready
 * structures. All formatting decisions live here so screens stay thin and the
 * mapping is unit-testable in node.
 */
import type { AnalyticsSummary, ApprovalDto, ProductDto } from "./api";
import { formatMinor } from "./money";

// ---- Dashboard ----

export type DashboardCardTone = "revenue" | "neutral" | "stock";

export interface DashboardCard {
  key: string;
  label: string;
  value: string;
  hint?: string;
  tone: DashboardCardTone;
}

/** Owner-home card list from GET /v1/analytics/summary ("the 11 pm check"). */
export function dashboardCards(summary: AnalyticsSummary): DashboardCard[] {
  const cards: DashboardCard[] = [
    {
      key: "today-revenue",
      label: "Today's sales",
      value: formatMinor(summary.today.revenueMinor),
      hint: `${summary.today.orders} order${summary.today.orders === 1 ? "" : "s"} · VAT ${formatMinor(summary.today.vatMinor)}`,
      tone: "revenue",
    },
    {
      key: "week-revenue",
      label: "Last 7 days",
      value: formatMinor(summary.last7Days.revenueMinor),
      hint: `${summary.last7Days.orders} order${summary.last7Days.orders === 1 ? "" : "s"}`,
      tone: "revenue",
    },
    {
      key: "stock-value",
      label: "Stock value (cost)",
      value: formatMinor(summary.stockValueMinor),
      hint: `${summary.onHandUnits} units on hand`,
      tone: "stock",
    },
  ];

  const top = summary.topSellers30Days[0];
  if (top) {
    cards.push({
      key: "top-seller",
      label: "Top seller (30d)",
      value: top.description ?? top.variantId,
      hint: `${top.units} units · ${formatMinor(top.revenue)}`,
      tone: "neutral",
    });
  }

  return cards;
}

// ---- Approvals ----

export interface ApprovalRow {
  id: string;
  kindLabel: string;
  /** One-line payload summary, AED amounts included for refunds. */
  summary: string;
  reason: string;
  requestedBy: string;
  age: string;
  /** Refunds move money out; everything else is a neutral correction. */
  urgent: boolean;
}

/** First 8 chars of a UUID — enough to identify, short enough for a phone row. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
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

function approvalSummary(kind: string, payload: Record<string, unknown>): string {
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
  return kind.replace(/_/g, " ");
}

/** Display row for the approvals inbox (EMP-004: decision with full context). */
export function approvalRow(approval: ApprovalDto, nowMs = Date.now()): ApprovalRow {
  return {
    id: approval.id,
    kindLabel: approval.kind === "stock_count" ? "Stock count" : capitalize(approval.kind),
    summary: approvalSummary(approval.kind, approval.payload),
    reason: approval.reason || "—",
    requestedBy: shortId(approval.requestedBy),
    age: approvalAge(approval.requested_at, nowMs),
    urgent: approval.kind === "refund",
  };
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

// ---- Stock lookup ----

export interface StockSearchRow {
  productId: string;
  productName: string;
  variantId: string;
  sku: string;
  barcode: string | null;
  price: string;
  tracking: string;
}

/** Flatten product search results to one tappable row per variant. */
export function stockSearchResults(products: ProductDto[]): StockSearchRow[] {
  const rows: StockSearchRow[] = [];
  for (const product of products) {
    for (const variant of product.variants) {
      rows.push({
        productId: product.id,
        productName: product.name,
        variantId: variant.id,
        sku: variant.sku,
        barcode: variant.barcode ?? null,
        price: formatMinor(variant.priceMinor, variant.currency),
        tracking: product.tracking,
      });
    }
  }
  return rows;
}
