/**
 * Money helpers. The platform stores money as BIGINT minor units + currency
 * code (AED minor unit = fils, x100). Never use floats for stored amounts —
 * floats appear only at the display boundary.
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

/** Format an integer minor-unit amount as an en-AE currency string. */
export function formatMinor(minor: number, currency = "AED"): string {
  if (!Number.isFinite(minor)) return "—";
  return formatterFor(currency).format(minor / 100);
}

/**
 * Parse a user-entered decimal amount (e.g. "1299.50") into integer minor
 * units, using pure integer math (no float multiplication). Returns null for
 * anything that is not a plain non-negative decimal with <= 2 fraction digits.
 */
export function decimalToMinor(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole = "0", frac = ""] = trimmed.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

/** Render integer minor units as a plain decimal string (for form defaults). */
export function minorToDecimal(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}
