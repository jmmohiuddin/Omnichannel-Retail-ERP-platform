/**
 * AED money formatting from minor units (fils). Money is always integer minor
 * units end to end (CLAUDE.md); division by 100 happens only at display time.
 *
 * The formatter is deliberately pinned to `en-AE` for BOTH the English and
 * Arabic UIs: UAE retail convention is Western (Latin) numerals on price
 * tags, receipts and card terminals, so amounts must not switch to Eastern
 * Arabic digits when the interface language is Arabic (see lib/i18n.ts).
 */

const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string): Intl.NumberFormat {
  let fmt = formatters.get(currency);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-AE", { style: "currency", currency });
    formatters.set(currency, fmt);
  }
  return fmt;
}

/**
 * Format integer minor units (fils) as an en-AE currency string, e.g.
 * `formatMinor(1250)` -> "AED 12.50". Non-breaking spaces are normalized to
 * regular spaces so output is stable for receipts and tests.
 */
export function formatMinor(minor: number, currency = "AED"): string {
  if (!Number.isInteger(minor)) {
    throw new TypeError(`minor units must be an integer, got ${minor}`);
  }
  return formatterFor(currency)
    .format(minor / 100)
    .replace(/[\u00A0\u202F]/g, " ");
}
