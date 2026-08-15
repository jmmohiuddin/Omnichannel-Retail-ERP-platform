/**
 * Pure cart state + VAT-inclusive totals (docs/08-uae-localization.md §2):
 * retail prices are VAT-inclusive, so the line total IS the gross amount and
 * the VAT portion is carved out of it for display/reporting.
 *
 * The rate is a PARAMETER, never a constant here (R7.4). It comes from
 * `tenant.vat_rate_bp` via lib/tenantConfig.ts. This module used to hardcode
 * 500 bp, which put the till screen and the printed offline receipt at odds
 * with the server's tax invoice for any tenant not on 5%.
 *
 * The math itself is not implemented here either: `lineTotals`/`saleTotals`
 * from `@omniretail/domain` are the same functions the server bills with
 * (SalesService), so the amount on the screen is the amount on the invoice,
 * down to the last fils.
 */
import { lineTotals, saleTotals } from "@omniretail/domain";

export interface CartLine {
  variantId: string;
  sku: string;
  name: string;
  /** VAT-inclusive unit price in fils. */
  unitPriceMinor: number;
  quantity: number;
  currency: string;
  /** Present for serialized (IMEI-tracked) items — qty locked to 1. */
  stockUnitId?: string;
  /** The IMEI shown on serialized lines and receipts. */
  imei?: string;
}

export type CartAction =
  | { type: "add"; line: Omit<CartLine, "quantity"> }
  | { type: "increment"; variantId: string }
  | { type: "decrement"; variantId: string }
  /** stockUnitId scopes removal to one serialized line of the variant. */
  | { type: "remove"; variantId: string; stockUnitId?: string }
  | { type: "clear" };

/** Duplicate-unit guard: a serialized unit may be in the cart at most once. */
export function hasStockUnit(lines: readonly CartLine[], stockUnitId: string): boolean {
  return lines.some((l) => l.stockUnitId === stockUnitId);
}

export function cartReducer(lines: readonly CartLine[], action: CartAction): CartLine[] {
  switch (action.type) {
    case "add": {
      const existing = lines.find(
        (l) => l.variantId === action.line.variantId && l.stockUnitId === action.line.stockUnitId,
      );
      if (existing && existing.stockUnitId === undefined) {
        return lines.map((l) => (l === existing ? { ...l, quantity: l.quantity + 1 } : l));
      }
      if (existing) return [...lines]; // serialized unit can be in the cart once
      return [...lines, { ...action.line, quantity: 1 }];
    }
    case "increment":
      return lines.map((l) =>
        l.variantId === action.variantId && l.stockUnitId === undefined
          ? { ...l, quantity: l.quantity + 1 }
          : l,
      );
    case "decrement":
      return lines
        .map((l) =>
          l.variantId === action.variantId && l.stockUnitId === undefined
            ? { ...l, quantity: l.quantity - 1 }
            : l,
        )
        .filter((l) => l.quantity > 0);
    case "remove":
      return lines.filter(
        (l) => !(l.variantId === action.variantId && l.stockUnitId === action.stockUnitId),
      );
    case "clear":
      return [];
  }
}

export function lineTotalMinor(line: CartLine): number {
  return line.unitPriceMinor * line.quantity;
}

export interface CartTotals {
  /** Net of VAT (gross − VAT portion), in fils. */
  subtotalMinor: number;
  /** The VAT carved out of the VAT-inclusive total, in fils. */
  taxMinor: number;
  /** Sum of VAT-inclusive line totals — what the customer pays, in fils. */
  totalMinor: number;
  itemCount: number;
}

/**
 * @param vatRateBp the tenant's rate in basis points (500 = 5%). Required —
 *   there is deliberately no default, so no code path can quietly assume 5%.
 *
 * VAT is summed PER LINE, matching `SalesService` and the way lines print on a
 * tax invoice. Carving it out of the cart total instead can differ by a fils
 * on carts with several odd-priced lines, which would show the cashier one
 * VAT figure and the customer's invoice another.
 */
export function cartTotals(lines: readonly CartLine[], vatRateBp: number): CartTotals {
  const totals = saleTotals(
    lines.map((l) => lineTotals(l.unitPriceMinor, l.quantity, vatRateBp)),
  );
  return {
    subtotalMinor: totals.netMinor,
    taxMinor: totals.taxMinor,
    totalMinor: totals.totalMinor,
    itemCount: lines.reduce((sum, l) => sum + l.quantity, 0),
  };
}
