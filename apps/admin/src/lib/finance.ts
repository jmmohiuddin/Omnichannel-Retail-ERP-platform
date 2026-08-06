/**
 * Finance-screen logic: P&L date-range defaults and the range → ISO-datetime
 * query builder. Pure functions, no I/O.
 */

/** Calendar dates as emitted by <input type="date"> (YYYY-MM-DD). */
export interface PnlRange {
  from: string;
  to: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Default P&L window: the last 30 days, ending today (UTC calendar dates). */
export function defaultPnlRange(now = new Date()): PnlRange {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { from, to };
}

/**
 * Build the /v1/finance/pnl query string. Dates expand to ISO datetimes —
 * `from` at start of day, `to` at end of day so the range is inclusive.
 * Returns null for malformed or inverted ranges.
 */
export function pnlQuery(range: PnlRange): string | null {
  if (!DATE_RE.test(range.from) || !DATE_RE.test(range.to)) return null;
  if (range.from > range.to) return null;
  return `?from=${range.from}T00:00:00.000Z&to=${range.to}T23:59:59.999Z`;
}
