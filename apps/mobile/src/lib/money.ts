/**
 * Money display helpers. The platform stores money as BIGINT minor units +
 * currency code (AED minor unit = fils, x100). Floats appear only at this
 * display boundary — never in stored amounts.
 *
 * Deliberately locked to the `en-AE` locale even when the UI language is
 * Arabic: UAE retail convention shows amounts with Western numerals
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

/** Format integer minor units (fils) as an en-AE currency string, e.g. "AED 1,299.50". */
export function formatMinor(minor: number, currency = "AED"): string {
  if (!Number.isFinite(minor)) return "—";
  return formatterFor(currency).format(minor / 100);
}

/** Compact whole-dirham figure for dashboard cards (rounds to the dirham). */
export function formatMinorCompact(minor: number, currency = "AED"): string {
  if (!Number.isFinite(minor)) return "—";
  const dirhams = Math.round(minor / 100);
  return `${currency} ${new Intl.NumberFormat("en-AE").format(dirhams)}`;
}
