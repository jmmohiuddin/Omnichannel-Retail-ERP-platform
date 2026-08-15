/**
 * Domestic reverse charge for electronic devices — Cabinet Decision 91/2023,
 * in force 30 October 2023 (PRD R7.3 / R7.3a).
 *
 * THE RULE. Where a UAE VAT registrant supplies "electronic devices" — mobile
 * phones, smart phones, computer devices, tablets, and pieces and parts
 * thereof — to another UAE VAT registrant who is buying them **to resell, or
 * to use them to produce or manufacture such devices**, the supplier charges
 * NO VAT. The buyer accounts for it under the reverse-charge mechanism.
 *
 * Getting this wrong leaves the shop liable for the VAT it did not charge, so
 * every clause below is a gate, and the default when any gate is unproven is
 * to charge standard-rated VAT. A sale that should have been reverse-charged
 * but was taxed is a commercial annoyance; a sale that was reverse-charged
 * without entitlement is an assessment against the merchant.
 *
 * THE FOUR CONDITIONS, all required:
 *   1. The supplier is a UAE VAT registrant (has a TRN).
 *   2. The buyer is a UAE VAT registrant (has a TRN).
 *   3. The buyer has declared IN WRITING both (a) intent to resell or to use
 *      the devices to produce or manufacture such devices, and (b) that it is
 *      registered with the FTA.
 *   4. R7.3a — the supplier has VERIFIED the buyer's registration by a means
 *      approved by the FTA. **Retaining the declaration is not sufficient on
 *      its own.** This is the condition most implementations miss.
 *
 * TWO CARVE-OUTS that R7.3a states explicitly and that this module enforces
 * per line rather than per sale:
 *   * RCM does not apply where the supply is ZERO-RATED — e.g. an export
 *     under Article 45. A zero-rated line stays zero-rated.
 *   * RCM does not apply where the buyer is purchasing for its OWN BUSINESS
 *     USE rather than for resale. That is a fact about the declaration, not
 *     about the line, so it is gated at condition 3.
 *
 * And the one that follows from the definition: an accessory is not an
 * electronic device. A case, a charger or a screen protector sold on the same
 * invoice as a reverse-charged handset stays standard-rated, which is why a
 * single sale can be `mixed`.
 *
 * Pure domain code: no I/O, no framework, no database. Every rule here is
 * unit-testable and none of it may be re-implemented in an app (CLAUDE.md).
 */

import { vatFromInclusive, type LineTotals } from "./tax.js";

/* ------------------------------------------------------------------ *
 * Tax categories
 * ------------------------------------------------------------------ */

/**
 * Tax category codes as used on the invoice line. These are the UN/CEFACT
 * 5305 codes that UBL — and therefore the UAE Peppol specialisation PINT AE
 * (R7.9) — carries per line, so storing them in our own vocabulary and
 * translating at the edge would be a translation layer for nothing.
 */
export const TAX_CATEGORIES = ["S", "Z", "E", "O", "AE"] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

export const TAX_CATEGORY_LABELS: Record<TaxCategory, string> = {
  S: "Standard rated",
  Z: "Zero rated",
  E: "Exempt",
  O: "Outside scope of VAT",
  AE: "VAT reverse charge",
};

/**
 * The device classes Cabinet Decision 91/2023 lists. A product outside this
 * set — an accessory, a SIM, a service — is not an electronic device for RCM
 * purposes and is represented by the absence of a class, never by a member of
 * this union.
 */
export const RCM_DEVICE_CLASSES = [
  "mobile_phone",
  "smart_phone",
  "computer",
  "tablet",
  "part", // "pieces and parts thereof"
] as const;
export type RcmDeviceClass = (typeof RCM_DEVICE_CLASSES)[number];

export function isRcmDeviceClass(value: unknown): value is RcmDeviceClass {
  return typeof value === "string" && (RCM_DEVICE_CLASSES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * Verification of the buyer's registration (R7.3a)
 * ------------------------------------------------------------------ */

/**
 * How the supplier verified that the buyer really is FTA-registered.
 *
 * PRD Q10 is OPEN — it is not yet settled what verification means a retailer
 * has at the counter. That open question blocks the *implementation detail*,
 * not the record: whichever means the shop ends up using, the law requires
 * the supplier to have verified and to be able to show it. So the outcome and
 * the evidence are modelled now, and adding an automated lookup later becomes
 * a new member of this union rather than a schema change.
 */
export const RCM_VERIFICATION_METHODS = [
  "fta_portal", // the FTA's public TRN verification service
  "certificate", // a retained copy of the buyer's VAT registration certificate
  "other", // anything else, with evidence recorded alongside
] as const;
export type RcmVerificationMethod = (typeof RCM_VERIFICATION_METHODS)[number];

export type RcmVerificationOutcome = "verified" | "failed" | "unavailable";

export interface RcmVerification {
  readonly method: RcmVerificationMethod;
  readonly outcome: RcmVerificationOutcome;
}

/**
 * The buyer's written declaration. Both flags are required by CD 91/2023 and
 * they are deliberately two booleans rather than one: a buyer who is
 * registered but buying for own use, and a buyer who intends to resell but is
 * not registered, fail for different reasons and the cashier is told which.
 */
export interface RcmDeclaration {
  /** (a) intent to resell, or to use the devices to produce/manufacture such devices. */
  readonly declaresResaleOrManufacture: boolean;
  /** (b) the buyer confirms it is registered with the FTA. */
  readonly declaresFtaRegistered: boolean;
  /** R7.3a. Absent means the verification step was never performed. */
  readonly verification?: RcmVerification;
}

/* ------------------------------------------------------------------ *
 * Why a sale did not qualify
 * ------------------------------------------------------------------ */

export const RCM_REFUSAL_REASONS = [
  "not_requested",
  "supplier_not_registered",
  "buyer_trn_missing",
  "declaration_missing",
  "resale_intent_not_declared",
  "fta_registration_not_declared",
  "registration_not_verified",
  "no_qualifying_device_lines",
] as const;
export type RcmRefusalReason = (typeof RCM_REFUSAL_REASONS)[number];

/**
 * One sentence, for the cashier, at the till. The PRD's acceptance criteria
 * require exactly this: "the sale falls back to a standard 5% VAT sale and the
 * cashier is told why, in one sentence."
 */
export const RCM_REFUSAL_SENTENCES: Record<RcmRefusalReason, string> = {
  not_requested: "This sale was not marked as a business-to-business resale.",
  supplier_not_registered:
    "Reverse charge needs this shop's own TRN on file — add it in settings, then re-ring the sale.",
  buyer_trn_missing: "Reverse charge needs the buyer's TRN; none was captured, so VAT is charged at 5%.",
  declaration_missing:
    "Reverse charge needs the buyer's written declaration; none is on file, so VAT is charged at 5%.",
  resale_intent_not_declared:
    "The buyer did not declare the devices are for resale or manufacture, so VAT is charged at 5%.",
  fta_registration_not_declared:
    "The buyer did not confirm it is registered with the FTA, so VAT is charged at 5%.",
  registration_not_verified:
    "The buyer's FTA registration has not been verified, and a declaration alone is not enough, so VAT is charged at 5%.",
  no_qualifying_device_lines:
    "Reverse charge covers phones, computers, tablets and their parts; this sale has none, so VAT is charged at 5%.",
};

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

export interface RcmLineInput {
  /** Caller's identifier, echoed back so results can be matched to lines. */
  readonly lineId: string;
  /** Absent when the product is not an electronic device under CD 91/2023. */
  readonly deviceClass?: RcmDeviceClass | undefined;
  /** Zero-rated supply (e.g. export under Art. 45). Never reverse-charged. */
  readonly zeroRated?: boolean;
  /** Exempt supply. Never reverse-charged. */
  readonly exempt?: boolean;
}

export interface SaleTaxContext {
  /** The cashier marked this sale business-to-business with intent to resell. */
  readonly rcmRequested: boolean;
  /** The shop's own TRN. Absent means the shop is not a registrant. */
  readonly supplierTrn?: string | undefined;
  /** The buyer's TRN, as captured on the sale. */
  readonly buyerTrn?: string | undefined;
  readonly declaration?: RcmDeclaration | undefined;
  /** The tenant's standard VAT rate in basis points (500 = 5%). */
  readonly standardRateBp: number;
  readonly lines: readonly RcmLineInput[];
}

/* ------------------------------------------------------------------ *
 * Outputs
 * ------------------------------------------------------------------ */

export interface LineTaxTreatment {
  readonly lineId: string;
  readonly category: TaxCategory;
  /** Basis points actually applied. Always 0 for AE, Z, E and O. */
  readonly rateBp: number;
  readonly reverseCharge: boolean;
}

export type SaleTaxTreatmentKind = "standard" | "reverse_charge" | "mixed";

export interface SaleTaxTreatment {
  readonly kind: SaleTaxTreatmentKind;
  readonly lines: readonly LineTaxTreatment[];
  /** True when the invoice must carry the reverse-charge statement (R7.2). */
  readonly requiresReverseChargeStatement: boolean;
  /** Set when RCM was asked for and refused. Drives the cashier's message. */
  readonly refusedReason?: RcmRefusalReason;
  /** The one sentence to show the cashier. Present iff refusedReason is. */
  readonly refusedMessage?: string;
}

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

/**
 * Whether the four conditions are all met. Returns the first unmet one, in
 * the order a cashier can act on: the shop's own setup, then what the buyer
 * gave us, then what we did with it.
 */
export function rcmRefusalReason(ctx: SaleTaxContext): RcmRefusalReason | undefined {
  if (!ctx.rcmRequested) return "not_requested";
  if (!ctx.supplierTrn) return "supplier_not_registered";
  if (!ctx.buyerTrn) return "buyer_trn_missing";
  if (!ctx.declaration) return "declaration_missing";
  if (!ctx.declaration.declaresResaleOrManufacture) return "resale_intent_not_declared";
  if (!ctx.declaration.declaresFtaRegistered) return "fta_registration_not_declared";
  // R7.3a — the clause that a declaration alone does not satisfy.
  if (ctx.declaration.verification?.outcome !== "verified") return "registration_not_verified";
  // A sale of nothing but accessories cannot be reverse-charged, and telling
  // the cashier that is more useful than silently producing a standard sale.
  if (!ctx.lines.some((l) => qualifiesForRcm(l))) return "no_qualifying_device_lines";
  return undefined;
}

/** A line is eligible only if it is a device AND is not zero-rated or exempt. */
function qualifiesForRcm(line: RcmLineInput): boolean {
  if (line.zeroRated || line.exempt) return false; // R7.3a carve-out
  return line.deviceClass !== undefined;
}

/** The category a line takes when the sale is NOT reverse-charged. */
function standardCategory(line: RcmLineInput, standardRateBp: number): LineTaxTreatment {
  if (line.exempt) {
    return { lineId: line.lineId, category: "E", rateBp: 0, reverseCharge: false };
  }
  if (line.zeroRated) {
    return { lineId: line.lineId, category: "Z", rateBp: 0, reverseCharge: false };
  }
  return { lineId: line.lineId, category: "S", rateBp: standardRateBp, reverseCharge: false };
}

/**
 * Resolve the tax treatment of a whole sale, line by line.
 *
 * Refusal is all-or-nothing at the SALE level (a missing declaration cannot
 * be cured per line) but eligibility is per LINE, so a qualifying sale of a
 * handset plus a case yields `mixed`: AE on the handset, S on the case.
 */
export function resolveSaleTaxTreatment(ctx: SaleTaxContext): SaleTaxTreatment {
  if (!Number.isInteger(ctx.standardRateBp) || ctx.standardRateBp < 0 || ctx.standardRateBp > 10000) {
    throw new RangeError(`standardRateBp out of range: ${ctx.standardRateBp}`);
  }

  const refusal = rcmRefusalReason(ctx);

  if (refusal) {
    const lines = ctx.lines.map((l) => standardCategory(l, ctx.standardRateBp));
    return {
      kind: "standard",
      lines,
      requiresReverseChargeStatement: false,
      // "not_requested" is the ordinary consumer sale — there is nothing to
      // explain and no message to show. Every other reason is a refusal of
      // something the cashier asked for, and must be explained.
      ...(refusal === "not_requested"
        ? {}
        : { refusedReason: refusal, refusedMessage: RCM_REFUSAL_SENTENCES[refusal] }),
    };
  }

  const lines = ctx.lines.map((l): LineTaxTreatment =>
    qualifiesForRcm(l)
      ? { lineId: l.lineId, category: "AE", rateBp: 0, reverseCharge: true }
      : standardCategory(l, ctx.standardRateBp),
  );

  const anyRcm = lines.some((l) => l.reverseCharge);
  const allRcm = lines.every((l) => l.reverseCharge);
  return {
    kind: allRcm ? "reverse_charge" : "mixed",
    lines,
    // Any reverse-charged line puts the statement on the invoice; it does not
    // need every line to qualify.
    requiresReverseChargeStatement: anyRcm,
  };
}

/* ------------------------------------------------------------------ *
 * Money
 * ------------------------------------------------------------------ */

/**
 * Line totals for a given tax category, from the VAT-INCLUSIVE catalogue
 * price. Consumer-facing prices must be VAT-inclusive in the UAE (R7.4), so
 * the inclusive price is the one number every surface holds.
 *
 *   S       the price is what the customer pays; VAT is extracted from it.
 *   AE      the buyer pays the VAT-EXCLUSIVE amount — the 5% is stripped out
 *           and accounted for by the buyer, not charged by us. This is the
 *           subtle one: reverse charge is not "the same price with a
 *           different label", it is a cheaper invoice.
 *   Z/E/O   no VAT is contained in the price, so gross == net.
 *
 * `standardRateBp` is the rate the inclusive price was built with; it is
 * needed even for AE, because that is the VAT being removed.
 */
export function lineTotalsForCategory(
  unitPriceMinor: number,
  quantity: number,
  standardRateBp: number,
  category: TaxCategory,
  discountMinor = 0,
): LineTotals {
  if (!Number.isInteger(unitPriceMinor) || unitPriceMinor < 0) {
    throw new RangeError(`unitPriceMinor must be a non-negative integer, got ${unitPriceMinor}`);
  }
  if (!Number.isInteger(discountMinor) || discountMinor < 0) {
    throw new RangeError(`discountMinor must be a non-negative integer, got ${discountMinor}`);
  }
  if (!(quantity > 0)) throw new RangeError("quantity must be positive");

  const inclusiveMinor = Math.round(unitPriceMinor * quantity) - discountMinor;
  if (inclusiveMinor < 0) throw new RangeError("discount exceeds line amount");

  switch (category) {
    case "S": {
      const taxMinor = vatFromInclusive(inclusiveMinor, standardRateBp);
      return { grossMinor: inclusiveMinor, taxMinor, netMinor: inclusiveMinor - taxMinor };
    }
    case "AE": {
      // Strip the VAT the shelf price contains: the buyer accounts for it.
      const removed = vatFromInclusive(inclusiveMinor, standardRateBp);
      const netMinor = inclusiveMinor - removed;
      return { grossMinor: netMinor, taxMinor: 0, netMinor };
    }
    case "Z":
    case "E":
    case "O":
      return { grossMinor: inclusiveMinor, taxMinor: 0, netMinor: inclusiveMinor };
  }
}

/* ------------------------------------------------------------------ *
 * Invoice wording
 * ------------------------------------------------------------------ */

/**
 * The reverse-charge statement, bilingual. R7.2 requires the statement on the
 * invoice; R7.7 requires Arabic on a consumer invoice under Federal
 * Decree-Law 15/2020 Art. 8(4), and there is no reason to hold a B2B invoice
 * to a lower standard when the Arabic text costs nothing.
 *
 * The reference to the Cabinet Decision is part of the required wording per
 * the PRD's acceptance criteria, not decoration.
 */
export const REVERSE_CHARGE_STATEMENT = {
  en:
    "VAT to be accounted for by the recipient under the domestic reverse charge " +
    "mechanism for electronic devices (Cabinet Decision No. 91 of 2023).",
  ar:
    "تُحتسب ضريبة القيمة المضافة من قِبل المستلم بموجب آلية الاحتساب العكسي المحلية " +
    "للأجهزة الإلكترونية (قرار مجلس الوزراء رقم 91 لسنة 2023).",
} as const;

/** The declaration text the buyer agrees to. Retained verbatim with the record. */
export const RCM_DECLARATION_TEXT = {
  en:
    "I confirm that (a) the electronic devices purchased are acquired for the purpose of " +
    "resale, or for use in producing or manufacturing such devices, and (b) that I am " +
    "registered for VAT with the Federal Tax Authority of the United Arab Emirates.",
  ar:
    "أُقر بأن (أ) الأجهزة الإلكترونية المشتراة مُقتناة بغرض إعادة البيع، أو لاستخدامها في " +
    "إنتاج أو تصنيع مثل هذه الأجهزة، و(ب) أنني مُسجَّل لضريبة القيمة المضافة لدى الهيئة " +
    "الاتحادية للضرائب في دولة الإمارات العربية المتحدة.",
} as const;
