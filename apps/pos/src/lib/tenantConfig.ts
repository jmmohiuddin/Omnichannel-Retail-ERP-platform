/**
 * Register-local copy of the tenant's fiscal configuration (R7.4).
 *
 * The VAT rate is a tenant column (`tenant.vat_rate_bp`), not a constant: the
 * FTA changes VAT by decree, not by deploy. The till used to hardcode 500 bp,
 * so a tenant on any other rate saw one number on screen and a different one
 * on the server's tax invoice. Under UAE law the displayed price is
 * VAT-inclusive and the receipt is a tax document, so that divergence is a
 * compliance defect.
 *
 * The rate arrives with the token pair (login/refresh) and is cached here, in
 * the same register-local storage as the session and the chosen location. It
 * MUST be read from cache and never fetched at cart time: the till has to
 * price and print a full eight-hour cash shift with no network (R3.11), and a
 * network read on the tender path would break exactly that.
 */

/** Minimal storage surface — localStorage in the app, in-memory in tests. */
export type ConfigStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const TENANT_CONFIG_KEY = "omniretail.pos.tenantConfig";

/**
 * The current UAE statutory rate, used ONLY as a last-resort fallback when the
 * till has never been told its tenant's rate. It is deliberately not the
 * default of any function that computes tax: silently assuming 5% is what
 * caused this defect. Every use of it is reported as `source: "fallback"` so
 * the caller can (and does) put it in front of the cashier.
 */
export const STATUTORY_VAT_RATE_BP = 500;

export interface TenantConfig {
  /** VAT rate in basis points (500 = 5%), as issued by the server. */
  vatRateBp: number;
}

/** `tenant` = the server told us. `fallback` = we are guessing, visibly. */
export type VatRateSource = "tenant" | "fallback";

export interface VatRate {
  rateBp: number;
  source: VatRateSource;
}

/**
 * Basis points, integer, 0–10000. Anything else (a float, a percent someone
 * mistook for bp, a string from a stale storage entry) is refused rather than
 * coerced — a wrong rate is worse than a known-missing one.
 */
export function isValidVatRateBp(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000;
}

function browserStorage(): ConfigStorage {
  return localStorage;
}

export function loadTenantConfig(storage: ConfigStorage = browserStorage()): TenantConfig | null {
  try {
    const raw = storage.getItem(TENANT_CONFIG_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const { vatRateBp } = parsed as { vatRateBp?: unknown };
    return isValidVatRateBp(vatRateBp) ? { vatRateBp } : null;
  } catch {
    return null;
  }
}

/**
 * Persist the rate the server issued. Refuses an invalid rate rather than
 * writing it, so a bad server payload cannot poison the till's cache; the
 * caller sees `false` and the till stays on whatever it already knew.
 */
export function saveTenantConfig(
  config: TenantConfig,
  storage: ConfigStorage = browserStorage(),
): boolean {
  if (!isValidVatRateBp(config.vatRateBp)) return false;
  try {
    storage.setItem(TENANT_CONFIG_KEY, JSON.stringify({ vatRateBp: config.vatRateBp }));
    return true;
  } catch {
    return false; // storage full/blocked — the in-memory rate still applies
  }
}

export function clearTenantConfig(storage: ConfigStorage = browserStorage()): void {
  try {
    storage.removeItem(TENANT_CONFIG_KEY);
  } catch {
    /* nothing to do — a stale rate is corrected at the next login anyway */
  }
}

/**
 * The rate the till should charge right now.
 *
 * With no cached rate it falls back to the statutory 5% and says so. The
 * alternative — refusing to sell — turns a config-delivery hiccup into a shop
 * that cannot trade, which is the worse failure for a cash till; but the
 * fallback is never silent: it is logged here and rendered as a standing alert
 * on the sale screen, and the printed offline document remains a sale record
 * rather than a tax invoice.
 */
export function resolveVatRate(storage: ConfigStorage = browserStorage()): VatRate {
  const config = loadTenantConfig(storage);
  if (config !== null) return { rateBp: config.vatRateBp, source: "tenant" };
  console.warn(
    "[pos] no tenant VAT rate cached — falling back to the statutory " +
      `${STATUTORY_VAT_RATE_BP} bp. Sign in again to sync the tenant's rate.`,
  );
  return { rateBp: STATUTORY_VAT_RATE_BP, source: "fallback" };
}

/**
 * Basis points as a percentage for display, e.g. 500 -> "5", 750 -> "7.5".
 * Integer arithmetic only: the rate must read exactly as configured, and a
 * float divide would eventually print something like "7.499999999999999".
 */
export function formatRateBp(rateBp: number): string {
  if (!isValidVatRateBp(rateBp)) throw new RangeError(`invalid VAT rate in bp: ${rateBp}`);
  const whole = Math.trunc(rateBp / 100);
  const fraction = rateBp % 100;
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}
