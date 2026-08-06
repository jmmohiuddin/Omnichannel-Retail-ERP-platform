/**
 * VAT math for tax-inclusive retail pricing (UAE norm — docs/08-uae-localization.md).
 * All amounts are integer minor units (fils). Rates are basis points (500 = 5%)
 * so tax config stays integer-exact end to end.
 */

export interface LineTotals {
  /** Gross line total including VAT (what the customer pays for the line). */
  grossMinor: number;
  /** VAT portion contained in grossMinor. */
  taxMinor: number;
  /** Net (excluding VAT) = gross − tax. */
  netMinor: number;
}

export interface SaleTotals {
  subtotalMinor: number; // sum of gross line totals before order-level rounding
  taxMinor: number;
  netMinor: number;
  totalMinor: number;    // == subtotalMinor (inclusive pricing)
}

const assertMinor = (n: number, label: string): void => {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`${label} must be a non-negative integer of minor units, got ${n}`);
  }
};

/**
 * Extract the VAT contained in a tax-inclusive amount.
 * tax = gross × r / (1 + r), computed in integers: gross × bp / (10000 + bp),
 * half-up rounding (FTA permits rounding to the nearest fils per line).
 */
export function vatFromInclusive(grossMinor: number, rateBp: number): number {
  assertMinor(grossMinor, "grossMinor");
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10000) {
    throw new RangeError(`rateBp out of range: ${rateBp}`);
  }
  return Math.round((grossMinor * rateBp) / (10000 + rateBp));
}

export function lineTotals(
  unitPriceMinor: number,
  quantity: number,
  rateBp: number,
  discountMinor = 0,
): LineTotals {
  assertMinor(unitPriceMinor, "unitPriceMinor");
  assertMinor(discountMinor, "discountMinor");
  if (!(quantity > 0)) throw new RangeError("quantity must be positive");
  const grossMinor = Math.round(unitPriceMinor * quantity) - discountMinor;
  if (grossMinor < 0) throw new RangeError("discount exceeds line amount");
  const taxMinor = vatFromInclusive(grossMinor, rateBp);
  return { grossMinor, taxMinor, netMinor: grossMinor - taxMinor };
}

/** Per-line VAT summed (matches how lines print on a tax invoice). */
export function saleTotals(lines: LineTotals[]): SaleTotals {
  const subtotalMinor = lines.reduce((s, l) => s + l.grossMinor, 0);
  const taxMinor = lines.reduce((s, l) => s + l.taxMinor, 0);
  return { subtotalMinor, taxMinor, netMinor: subtotalMinor - taxMinor, totalMinor: subtotalMinor };
}
