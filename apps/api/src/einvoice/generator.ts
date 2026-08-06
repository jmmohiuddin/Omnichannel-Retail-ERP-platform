/**
 * UAE e-invoice document generation — pure functions, no I/O.
 *
 * HONESTY / STATUS NOTE: the UAE e-billing mandate (Peppol PINT-AE, phased
 * 2026–2027) is still phasing in and the final AE specification (including
 * the official CustomizationID/ProfileID values and AE-specific rules) is
 * NOT locked here. This module produces a *structurally faithful draft*
 * (profile "PINT-AE-draft") following the public Peppol PINT / UBL 2.1
 * Invoice structure, intended as the input to an accredited-service-provider
 * integration. Every document must be validated against the current
 * FTA/Peppol PINT-AE documentation before transmission — do not transmit
 * these documents as-is. Fields whose exact identifier is not confirmed are
 * flagged UNVERIFIED below.
 */

/** Draft profile marker — deliberately not a real Peppol profile id. */
export const EINVOICE_PROFILE = "PINT-AE-draft" as const;

/**
 * UNVERIFIED placeholder: the real PINT-AE CustomizationID is assigned by
 * the Peppol/FTA specification — verify against current FTA/Peppol PINT-AE
 * docs before transmission.
 */
export const CUSTOMIZATION_ID_PLACEHOLDER =
  "urn:peppol:pint:billing-1@ae-1:UNVERIFIED-draft";

/** UNVERIFIED placeholder ProfileID (Peppol billing process). */
export const PROFILE_ID_PLACEHOLDER = "urn:peppol:bis:billing:UNVERIFIED-draft";

export const EINVOICE_DISCLAIMER =
  "DRAFT — structurally-faithful UAE e-invoice draft (profile PINT-AE-draft) generated per " +
  "public Peppol PINT / UBL 2.1 structure for the accredited-service-provider integration. " +
  "The UAE e-billing mandate is still phasing in: verify against current FTA/Peppol PINT-AE " +
  "docs and validate against the final AE specification before transmission.";

/** Receipt-shaped input (matches SalesService.receipt / the e-invoice re-query). */
export interface ReceiptLikeLine {
  description: string;
  quantity: number;
  /** Tax-INCLUSIVE unit price in fils (catalog convention, docs/08 §2). */
  unitPriceMinor: number;
  discountMinor: number;
  taxMinor: number;
  /** Tax-inclusive line total in fils (after discount). */
  totalMinor: number;
}

export interface ReceiptLike {
  orderNo: string;
  issuedAt: Date | string;
  seller: { name: string; trn: string | null };
  currency: string;
  vatRateBp: number;
  lines: ReceiptLikeLine[];
  totals: {
    subtotalMinor: number;
    discountMinor: number;
    taxMinor: number;
    totalMinor: number;
  };
  payments: { method: string; amountMinor: number }[];
}

export interface BuildOptions {
  /** Buyer party. Absent → simplified tax invoice (FTA threshold rules). */
  buyer?: { name: string; trn?: string } | undefined;
}

export interface EInvoiceParty {
  name: string;
  /**
   * 15-digit FTA Tax Registration Number, carried as cbc:CompanyID with
   * schemeID "TRN" — UNVERIFIED scheme identifier: confirm the PINT-AE
   * scheme id for TRNs before transmission.
   */
  trn: string | null;
}

export interface EInvoiceLine {
  id: string;
  name: string;
  quantity: string;
  /** Net (tax-exclusive) unit price, 2-dp decimal string. Informational —
   *  the authoritative amount is lineNet (LineExtensionAmount). */
  unitPriceNet: string;
  lineNet: string;
  lineNetMinor: number;
  vatCategory: "S";
  vatRatePercent: string;
  lineVat: string;
  lineVatMinor: number;
}

export interface EInvoiceModel {
  profile: typeof EINVOICE_PROFILE;
  disclaimer: string;
  customizationId: string;
  profileId: string;
  invoiceNumber: string;
  /** Calendar date in Asia/Dubai (GMT+4, no DST), YYYY-MM-DD. */
  issueDate: string;
  /** Full ISO timestamp with the +04:00 Dubai offset. */
  issueDateTime: string;
  invoiceTypeCode: "380";
  currency: string;
  /** True when no buyer party is attached (simplified tax invoice). */
  simplified: boolean;
  seller: EInvoiceParty;
  buyer?: EInvoiceParty;
  taxTotal: {
    taxAmount: string;
    taxAmountMinor: number;
    subtotals: {
      taxableAmount: string;
      taxableAmountMinor: number;
      taxAmount: string;
      taxAmountMinor: number;
      category: "S";
      ratePercent: string;
    }[];
  };
  monetaryTotals: {
    /** Sum of line nets (tax-exclusive). */
    lineExtensionAmount: string;
    taxExclusiveAmount: string;
    taxExclusiveMinor: number;
    taxInclusiveAmount: string;
    taxInclusiveMinor: number;
    payableAmount: string;
    payableMinor: number;
  };
  lines: EInvoiceLine[];
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * Convert integer fils (minor units) to a 2-dp decimal string using pure
 * string/integer math — no floating point involved, so no drift ever.
 * 419900 → "4199.00", 1 → "0.01", 0 → "0.00", -50 → "-0.50".
 */
export function filsToDecimal(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`filsToDecimal requires a safe integer, got ${minor}`);
  }
  const sign = minor < 0 ? "-" : "";
  const digits = Math.abs(minor).toString(); // integer → exact decimal digits
  const padded = digits.padStart(3, "0"); // at least "0" + 2 fraction digits
  const whole = padded.slice(0, -2);
  const frac = padded.slice(-2);
  return `${sign}${whole}.${frac}`;
}

/** Basis points → percent string: 500 → "5", 525 → "5.25", 0 → "0". */
export function bpToPercent(bp: number): string {
  if (!Number.isSafeInteger(bp) || bp < 0) {
    throw new RangeError(`bpToPercent requires a non-negative integer, got ${bp}`);
  }
  const whole = Math.trunc(bp / 100);
  const frac = bp % 100;
  if (frac === 0) return String(whole);
  const fracStr = String(frac).padStart(2, "0").replace(/0$/, "");
  return `${whole}.${fracStr}`;
}

/** Escape text for use as XML element content or attribute value. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000; // Asia/Dubai is fixed GMT+4 (no DST)

function toDubaiIso(issuedAt: Date | string): { date: string; dateTime: string } {
  const at = issuedAt instanceof Date ? issuedAt : new Date(issuedAt);
  if (Number.isNaN(at.getTime())) {
    throw new RangeError(`invalid issuedAt: ${String(issuedAt)}`);
  }
  const shifted = new Date(at.getTime() + DUBAI_OFFSET_MS);
  const iso = shifted.toISOString(); // wall-clock in Dubai, rendered as if UTC
  const date = iso.slice(0, 10);
  const dateTime = `${iso.slice(0, 19)}+04:00`;
  return { date, dateTime };
}

/** Format a NUMERIC(14,3)-style quantity without float noise. */
function formatQuantity(quantity: number): string {
  const scaled = Math.round(quantity * 1000);
  if (scaled % 1000 === 0) return String(scaled / 1000);
  const sign = scaled < 0 ? "-" : "";
  const abs = Math.abs(scaled).toString().padStart(4, "0");
  return `${sign}${abs.slice(0, -3)}.${abs.slice(-3).replace(/0+$/, "")}`;
}

/**
 * Net unit price in fils. Exact when the line net divides evenly by the
 * quantity; otherwise rounded to the nearest fils (informational only — the
 * authoritative amount is the line net itself).
 */
function unitNetMinor(lineNetMinor: number, quantity: number): number {
  if (quantity <= 0) throw new RangeError(`quantity must be > 0, got ${quantity}`);
  if (Number.isInteger(quantity) && lineNetMinor % quantity === 0) {
    return lineNetMinor / quantity;
  }
  return Math.round(lineNetMinor / quantity);
}

/**
 * Map a receipt (SalesService.receipt shape) to a typed e-invoice model.
 * Pure and deterministic — the issue date comes from the receipt, never
 * from the clock.
 */
export function buildEInvoiceModel(
  receipt: ReceiptLike,
  opts: BuildOptions = {},
): EInvoiceModel {
  const { date, dateTime } = toDubaiIso(receipt.issuedAt);
  const ratePercent = bpToPercent(receipt.vatRateBp);

  const lines: EInvoiceLine[] = receipt.lines.map((l, i) => {
    const lineNetMinor = l.totalMinor - l.taxMinor;
    return {
      id: String(i + 1),
      name: l.description,
      quantity: formatQuantity(l.quantity),
      unitPriceNet: filsToDecimal(unitNetMinor(lineNetMinor, l.quantity)),
      lineNet: filsToDecimal(lineNetMinor),
      lineNetMinor,
      vatCategory: "S",
      vatRatePercent: ratePercent,
      lineVat: filsToDecimal(l.taxMinor),
      lineVatMinor: l.taxMinor,
    };
  });

  const taxExclusiveMinor = receipt.totals.totalMinor - receipt.totals.taxMinor;
  const taxInclusiveMinor = receipt.totals.totalMinor;
  const taxMinor = receipt.totals.taxMinor;

  const buyer: EInvoiceParty | undefined = opts.buyer
    ? { name: opts.buyer.name, trn: opts.buyer.trn ?? null }
    : undefined;

  return {
    profile: EINVOICE_PROFILE,
    disclaimer: EINVOICE_DISCLAIMER,
    customizationId: CUSTOMIZATION_ID_PLACEHOLDER,
    profileId: PROFILE_ID_PLACEHOLDER,
    invoiceNumber: receipt.orderNo,
    issueDate: date,
    issueDateTime: dateTime,
    invoiceTypeCode: "380",
    currency: receipt.currency,
    simplified: buyer === undefined,
    seller: { name: receipt.seller.name, trn: receipt.seller.trn ?? null },
    ...(buyer ? { buyer } : {}),
    taxTotal: {
      taxAmount: filsToDecimal(taxMinor),
      taxAmountMinor: taxMinor,
      subtotals: [
        {
          taxableAmount: filsToDecimal(taxExclusiveMinor),
          taxableAmountMinor: taxExclusiveMinor,
          taxAmount: filsToDecimal(taxMinor),
          taxAmountMinor: taxMinor,
          category: "S",
          ratePercent,
        },
      ],
    },
    monetaryTotals: {
      lineExtensionAmount: filsToDecimal(taxExclusiveMinor),
      taxExclusiveAmount: filsToDecimal(taxExclusiveMinor),
      taxExclusiveMinor,
      taxInclusiveAmount: filsToDecimal(taxInclusiveMinor),
      taxInclusiveMinor,
      payableAmount: filsToDecimal(taxInclusiveMinor),
      payableMinor: taxInclusiveMinor,
    },
    lines,
  };
}

const TRN_PATTERN = /^\d{15}$/;

/**
 * Structural consistency checks (integer fils math throughout).
 * Errors block generation-for-transmission; warnings are advisory
 * (e.g. missing TRN → only a simplified invoice is permissible).
 */
export function validateModel(model: EInvoiceModel): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const lineNetSum = model.lines.reduce((s, l) => s + l.lineNetMinor, 0);
  const lineVatSum = model.lines.reduce((s, l) => s + l.lineVatMinor, 0);

  if (lineNetSum !== model.monetaryTotals.taxExclusiveMinor) {
    errors.push(
      `line nets (${lineNetSum}) do not sum to tax-exclusive total (${model.monetaryTotals.taxExclusiveMinor})`,
    );
  }
  if (lineVatSum !== model.taxTotal.taxAmountMinor) {
    errors.push(
      `line VAT (${lineVatSum}) does not sum to tax total (${model.taxTotal.taxAmountMinor})`,
    );
  }
  if (
    model.monetaryTotals.taxExclusiveMinor + model.taxTotal.taxAmountMinor !==
    model.monetaryTotals.taxInclusiveMinor
  ) {
    errors.push(
      `tax-exclusive (${model.monetaryTotals.taxExclusiveMinor}) + tax (${model.taxTotal.taxAmountMinor}) ` +
        `does not equal tax-inclusive total (${model.monetaryTotals.taxInclusiveMinor})`,
    );
  }
  if (model.monetaryTotals.payableMinor !== model.monetaryTotals.taxInclusiveMinor) {
    errors.push(
      `payable (${model.monetaryTotals.payableMinor}) does not equal tax-inclusive total ` +
        `(${model.monetaryTotals.taxInclusiveMinor})`,
    );
  }

  if (!/^[A-Z]{3}$/.test(model.currency)) {
    errors.push(`currency must be a 3-letter ISO 4217 code, got "${model.currency}"`);
  }

  if (model.seller.trn === null || model.seller.trn === "") {
    warnings.push(
      "seller TRN missing: only a simplified tax invoice is permissible; " +
        "set the tenant TRN (15 digits) before issuing full tax invoices",
    );
  } else if (!TRN_PATTERN.test(model.seller.trn)) {
    errors.push(`seller TRN must be exactly 15 digits, got "${model.seller.trn}"`);
  }

  if (model.buyer?.trn && !TRN_PATTERN.test(model.buyer.trn)) {
    errors.push(`buyer TRN must be exactly 15 digits, got "${model.buyer.trn}"`);
  }

  if (model.simplified) {
    warnings.push(
      "no buyer party: document is a simplified tax invoice (allowed under the FTA threshold)",
    );
  }

  return { errors, warnings };
}

function partyXml(tag: "AccountingSupplierParty" | "AccountingCustomerParty", party: EInvoiceParty): string {
  const trnXml = party.trn
    ? `
      <cac:PartyTaxScheme>
        <!-- schemeID "TRN" is UNVERIFIED — confirm the PINT-AE scheme id -->
        <cbc:CompanyID schemeID="TRN">${escapeXml(party.trn)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>`
    : "";
  return `  <cac:${tag}>
    <cac:Party>
      <cac:PartyName>
        <cbc:Name>${escapeXml(party.name)}</cbc:Name>
      </cac:PartyName>${trnXml}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(party.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:${tag}>`;
}

/**
 * Render the model as a UBL 2.1 Invoice document. Deterministic: identical
 * models render byte-identical XML (no clocks, no randomness).
 */
export function renderUbl(model: EInvoiceModel): string {
  const cur = escapeXml(model.currency);

  const lineXml = model.lines
    .map(
      (l) => `  <cac:InvoiceLine>
    <cbc:ID>${escapeXml(l.id)}</cbc:ID>
    <!-- unitCode "C62" (each) is UNVERIFIED for PINT-AE unit handling -->
    <cbc:InvoicedQuantity unitCode="C62">${escapeXml(l.quantity)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${cur}">${l.lineNet}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${escapeXml(l.name)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${l.vatCategory}</cbc:ID>
        <cbc:Percent>${l.vatRatePercent}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${cur}">${l.unitPriceNet}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`,
    )
    .join("\n");

  const subtotalXml = model.taxTotal.subtotals
    .map(
      (s) => `    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${cur}">${s.taxableAmount}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${cur}">${s.taxAmount}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${s.category}</cbc:ID>
        <cbc:Percent>${s.ratePercent}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  ${escapeXml(model.disclaimer)}
-->
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <!-- CustomizationID/ProfileID are UNVERIFIED placeholders (profile ${model.profile}) -->
  <cbc:CustomizationID>${escapeXml(model.customizationId)}</cbc:CustomizationID>
  <cbc:ProfileID>${escapeXml(model.profileId)}</cbc:ProfileID>
  <cbc:ID>${escapeXml(model.invoiceNumber)}</cbc:ID>
  <cbc:IssueDate>${escapeXml(model.issueDate)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>${model.invoiceTypeCode}</cbc:InvoiceTypeCode>
  <cbc:Note>${escapeXml(model.disclaimer)}</cbc:Note>
  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>
${partyXml("AccountingSupplierParty", model.seller)}
${model.buyer ? partyXml("AccountingCustomerParty", model.buyer) + "\n" : ""}  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${cur}">${model.taxTotal.taxAmount}</cbc:TaxAmount>
${subtotalXml}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${cur}">${model.monetaryTotals.lineExtensionAmount}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${cur}">${model.monetaryTotals.taxExclusiveAmount}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${cur}">${model.monetaryTotals.taxInclusiveAmount}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${cur}">${model.monetaryTotals.payableAmount}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${lineXml}
</Invoice>
`;
}
