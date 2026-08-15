/**
 * UAE tax core (docs/08-uae-localization.md): VAT math for tax-inclusive
 * retail pricing, and the emirate a supply is attributed to (R7.6).
 * All amounts are integer minor units (fils). Rates are basis points (500 = 5%)
 * so tax config stays integer-exact end to end.
 */

/* ------------------------------------------------------------------ *
 * Emirate of the supply (R7.6)
 * ------------------------------------------------------------------ */

/**
 * The seven emirates, as ISO 3166-2:AE subdivision codes — the same seven
 * values the `emirate_code` SQL domain constrains (packages/db/sql/030_emirate.sql).
 * Order follows the VAT return's Box 1 lines 1a–1g.
 */
export const EMIRATES = ["AZ", "DU", "SH", "AJ", "UQ", "RK", "FU"] as const;

export type Emirate = (typeof EMIRATES)[number];

/** Box 1 of the FTA VAT return (form 201) is reported per emirate, 1a–1g. */
export type VatReturnBox = "1a" | "1b" | "1c" | "1d" | "1e" | "1f" | "1g";

/**
 * Which fact attributed the supply to its emirate.
 *
 * `fixed_establishment` — the default and, for this business, the only one
 * that applies: the emirate of the establishment most closely connected to
 * the supply, i.e. the branch making the sale, never the customer's address.
 *
 * `customer_location` — the narrow exception: e-commerce supplies by a
 * "qualifying registrant" (over AED 100m of e-commerce supplies in a calendar
 * year) are reported by where the customer receives the supply. Far above
 * this business's scale; represented so that reaching it is a configuration
 * change rather than a migration.
 */
export type EmirateBasis = "fixed_establishment" | "customer_location";

export interface EmirateInfo {
  code: Emirate;
  /** English name, as it appears on the VAT return. */
  en: string;
  /** Arabic name — invoices must be in Arabic (Federal Decree-Law 15/2020 Art. 8(4)). */
  ar: string;
  /** Full ISO 3166-2 subdivision code, e.g. "AE-DU". */
  iso: string;
  /** The VAT return Box 1 line this emirate's standard-rated supplies land on. */
  vatReturnBox: VatReturnBox;
}

const EMIRATE_INFO: Readonly<Record<Emirate, EmirateInfo>> = {
  AZ: { code: "AZ", en: "Abu Dhabi",     ar: "أبوظبي",      iso: "AE-AZ", vatReturnBox: "1a" },
  DU: { code: "DU", en: "Dubai",         ar: "دبي",         iso: "AE-DU", vatReturnBox: "1b" },
  SH: { code: "SH", en: "Sharjah",       ar: "الشارقة",     iso: "AE-SH", vatReturnBox: "1c" },
  AJ: { code: "AJ", en: "Ajman",         ar: "عجمان",       iso: "AE-AJ", vatReturnBox: "1d" },
  UQ: { code: "UQ", en: "Umm Al Quwain", ar: "أم القيوين",  iso: "AE-UQ", vatReturnBox: "1e" },
  RK: { code: "RK", en: "Ras Al Khaimah", ar: "رأس الخيمة", iso: "AE-RK", vatReturnBox: "1f" },
  FU: { code: "FU", en: "Fujairah",      ar: "الفجيرة",     iso: "AE-FU", vatReturnBox: "1g" },
};

export function isEmirate(value: unknown): value is Emirate {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(EMIRATE_INFO, value);
}

/** Narrow an untrusted value (DB column, API payload) to an Emirate, or throw. */
export function assertEmirate(value: unknown, label = "emirate"): Emirate {
  if (!isEmirate(value)) {
    throw new RangeError(`${label} must be one of ${EMIRATES.join(", ")}, got ${String(value)}`);
  }
  return value;
}

/** Names and codes for one emirate. Frozen — callers must not mutate it. */
export function emirateInfo(code: Emirate): EmirateInfo {
  return { ...EMIRATE_INFO[assertEmirate(code)] };
}

/** The VAT return Box 1 line (1a–1g) an emirate's supplies are reported on. */
export function vatReturnBox(code: Emirate): VatReturnBox {
  return EMIRATE_INFO[assertEmirate(code)].vatReturnBox;
}

export interface SupplyEmirateContext {
  /**
   * Emirate of the fixed establishment making (or receiving) the supply —
   * the selling branch. Required: there is no supply without one.
   */
  branchEmirate: Emirate;
  /** Where the customer receives the supply. Only consulted in the exception below. */
  customerEmirate?: Emirate | undefined;
  /**
   * True only when BOTH hold: the supply is e-commerce, and the seller is a
   * "qualifying registrant" (over AED 100m of e-commerce supplies in the
   * calendar year). Anything less stays on the branch rule.
   */
  qualifyingRegistrantEcommerce?: boolean | undefined;
}

export interface SupplyEmirate {
  emirate: Emirate;
  basis: EmirateBasis;
}

/**
 * Resolve which emirate a supply is reported in.
 *
 * The rule, and the reason this helper exists rather than an inline `??`:
 * the emirate is the fixed establishment most closely connected to the supply
 * — the BRANCH, not the buyer. A customer's address in another emirate is not
 * a reason to move the supply, and this function will not do so.
 *
 * The exception applies only to a qualifying registrant's e-commerce supplies
 * and only when the customer's emirate is actually known; with the flag set
 * but no customer emirate, it falls back to the branch rather than inventing
 * an attribution.
 */
export function resolveSupplyEmirate(ctx: SupplyEmirateContext): SupplyEmirate {
  const branch = assertEmirate(ctx.branchEmirate, "branchEmirate");
  if (ctx.qualifyingRegistrantEcommerce === true && ctx.customerEmirate !== undefined) {
    return {
      emirate: assertEmirate(ctx.customerEmirate, "customerEmirate"),
      basis: "customer_location",
    };
  }
  return { emirate: branch, basis: "fixed_establishment" };
}

/* ------------------------------------------------------------------ *
 * VAT math
 * ------------------------------------------------------------------ */

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
