/**
 * Money helpers. The platform stores money as BIGINT minor units + currency
 * code (AED minor unit = fils, x100). Floats appear only at the display
 * boundary — never in stored or transmitted amounts.
 *
 * Deliberately locked to the `en-AE` locale even when the UI language is
 * Arabic: UAE retail convention shows prices with Western numerals
 * ("AED 1,299.50") in both languages, so currency formatting does not follow
 * the i18n language toggle.
 */

const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string): Intl.NumberFormat {
  let f = formatters.get(currency);
  if (!f) {
    f = new Intl.NumberFormat("en-AE", { style: "currency", currency });
    formatters.set(currency, f);
  }
  return f;
}

/** Format an integer minor-unit amount (fils) as an en-AE currency string. */
export function formatMinor(minor: number, currency = "AED"): string {
  if (!Number.isFinite(minor)) return "—";
  return formatterFor(currency).format(minor / 100);
}

/**
 * Display-only VAT breakdown of a VAT-inclusive total at the UAE 5% standard
 * rate: round(total x 500 / 10500). The server's per-line tax ledger is
 * authoritative; this exists only for the "Includes 5% VAT" cart note.
 */
export function vatPortionMinor(totalInclusiveMinor: number): number {
  if (!Number.isFinite(totalInclusiveMinor)) return 0;
  return Math.round((totalInclusiveMinor * 500) / 10500);
}
