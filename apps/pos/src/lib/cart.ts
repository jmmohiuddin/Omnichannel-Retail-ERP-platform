/**
 * Pure cart state + VAT-inclusive totals (docs/08-uae-localization.md §2):
 * retail prices are VAT-inclusive, so the line total IS the gross amount and
 * the 5% VAT portion is carved out of it for display/reporting.
 */

export const VAT_RATE_BPS = 500; // 5.00% in basis points — table-driven later

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
}

export type CartAction =
  | { type: "add"; line: Omit<CartLine, "quantity"> }
  | { type: "increment"; variantId: string }
  | { type: "decrement"; variantId: string }
  | { type: "remove"; variantId: string }
  | { type: "clear" };

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
      return lines.filter((l) => l.variantId !== action.variantId);
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
  /** The 5% VAT carved out of the VAT-inclusive total, in fils. */
  taxMinor: number;
  /** Sum of VAT-inclusive line totals — what the customer pays, in fils. */
  totalMinor: number;
  itemCount: number;
}

export function cartTotals(lines: readonly CartLine[]): CartTotals {
  const totalMinor = lines.reduce((sum, l) => sum + lineTotalMinor(l), 0);
  // VAT included: tax = gross × r/(1+r), with r in basis points.
  const taxMinor = Math.round((totalMinor * VAT_RATE_BPS) / (10_000 + VAT_RATE_BPS));
  return {
    subtotalMinor: totalMinor - taxMinor,
    taxMinor,
    totalMinor,
    itemCount: lines.reduce((sum, l) => sum + l.quantity, 0),
  };
}
