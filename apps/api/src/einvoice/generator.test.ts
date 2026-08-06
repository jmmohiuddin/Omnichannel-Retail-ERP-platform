import { describe, expect, it } from "vitest";
import {
  bpToPercent,
  buildEInvoiceModel,
  escapeXml,
  filsToDecimal,
  renderUbl,
  validateModel,
  type ReceiptLike,
} from "./generator.js";

/** Cash sale mirroring finance.integration.test.ts numbers:
 *  1 phone @ 4199.00 + 2 chargers @ 89.00 VAT-inclusive, 5% VAT. */
const receipt = (over: Partial<ReceiptLike> = {}): ReceiptLike => ({
  orderNo: "INV-000001",
  issuedAt: new Date("2026-08-05T21:30:00Z"), // 01:30 next day in Dubai (+04)
  seller: { name: "Deira Phones LLC", trn: "100123456700003" },
  currency: "AED",
  vatRateBp: 500,
  lines: [
    {
      description: "Phone Pro (PP-1)",
      quantity: 1,
      unitPriceMinor: 419900,
      discountMinor: 0,
      taxMinor: 19995,
      totalMinor: 419900,
    },
    {
      description: "Charger (CH-1)",
      quantity: 2,
      unitPriceMinor: 8900,
      discountMinor: 0,
      taxMinor: 848,
      totalMinor: 17800,
    },
  ],
  totals: { subtotalMinor: 437700, discountMinor: 0, taxMinor: 20843, totalMinor: 437700 },
  payments: [{ method: "cash", amountMinor: 437700 }],
  ...over,
});

describe("filsToDecimal", () => {
  it("formats 0 fils", () => {
    expect(filsToDecimal(0)).toBe("0.00");
  });

  it("formats sub-dirham amounts with zero padding", () => {
    expect(filsToDecimal(1)).toBe("0.01");
    expect(filsToDecimal(99)).toBe("0.99");
  });

  it("formats exact dirhams and large amounts", () => {
    expect(filsToDecimal(100)).toBe("1.00");
    expect(filsToDecimal(419900)).toBe("4199.00");
    expect(filsToDecimal(437700)).toBe("4377.00");
  });

  it("formats negatives and rejects non-integers", () => {
    expect(filsToDecimal(-50)).toBe("-0.50");
    expect(filsToDecimal(-419901)).toBe("-4199.01");
    expect(() => filsToDecimal(1.5)).toThrow(RangeError);
    expect(() => filsToDecimal(Number.NaN)).toThrow(RangeError);
  });
});

describe("bpToPercent", () => {
  it("converts basis points to percent strings without float noise", () => {
    expect(bpToPercent(500)).toBe("5");
    expect(bpToPercent(525)).toBe("5.25");
    expect(bpToPercent(550)).toBe("5.5");
    expect(bpToPercent(0)).toBe("0");
  });
});

describe("buildEInvoiceModel", () => {
  it("maps totals with integer integrity: line nets + VAT = tax-inclusive total", () => {
    const model = buildEInvoiceModel(receipt());
    const netSum = model.lines.reduce((s, l) => s + l.lineNetMinor, 0);
    const vatSum = model.lines.reduce((s, l) => s + l.lineVatMinor, 0);
    expect(netSum).toBe(416857); // 437700 − 20843
    expect(vatSum).toBe(20843);
    expect(model.monetaryTotals.taxExclusiveMinor).toBe(416857);
    expect(model.monetaryTotals.taxInclusiveMinor).toBe(437700);
    expect(model.monetaryTotals.payableMinor).toBe(437700);
    expect(model.taxTotal.taxAmountMinor).toBe(20843);
    expect(model.monetaryTotals.taxExclusiveAmount).toBe("4168.57");
    expect(model.monetaryTotals.taxInclusiveAmount).toBe("4377.00");
    expect(model.taxTotal.taxAmount).toBe("208.43");
  });

  it("maps lines: ids, names, quantity, net amounts, category S at rate percent", () => {
    const model = buildEInvoiceModel(receipt());
    expect(model.lines).toHaveLength(2);
    const [phone, charger] = model.lines;
    expect(phone).toMatchObject({
      id: "1",
      name: "Phone Pro (PP-1)",
      quantity: "1",
      lineNet: "3999.05", // 419900 − 19995
      vatCategory: "S",
      vatRatePercent: "5",
      lineVat: "199.95",
    });
    expect(charger).toMatchObject({
      id: "2",
      quantity: "2",
      lineNet: "169.52", // 17800 − 848
      lineVat: "8.48",
      unitPriceNet: "84.76", // 16952 / 2 exact
    });
  });

  it("uses the Asia/Dubai calendar date and +04:00 offset, from the model input", () => {
    const model = buildEInvoiceModel(receipt());
    expect(model.issueDate).toBe("2026-08-06"); // 21:30Z rolls into the next Dubai day
    expect(model.issueDateTime).toBe("2026-08-06T01:30:00+04:00");
    expect(model.invoiceTypeCode).toBe("380");
    expect(model.invoiceNumber).toBe("INV-000001");
  });

  it("carries the draft profile and disclaimer honestly", () => {
    const model = buildEInvoiceModel(receipt());
    expect(model.profile).toBe("PINT-AE-draft");
    expect(model.disclaimer).toMatch(/verify against current FTA\/Peppol PINT-AE docs/);
    expect(model.customizationId).toContain("UNVERIFIED");
  });

  it("is simplified without a buyer and full with one", () => {
    const simplified = buildEInvoiceModel(receipt());
    expect(simplified.simplified).toBe(true);
    expect(simplified.buyer).toBeUndefined();

    const full = buildEInvoiceModel(receipt(), {
      buyer: { name: "Wholesale Buyer LLC", trn: "100999999900003" },
    });
    expect(full.simplified).toBe(false);
    expect(full.buyer).toEqual({ name: "Wholesale Buyer LLC", trn: "100999999900003" });
  });
});

describe("validateModel", () => {
  it("passes a consistent full invoice with no errors", () => {
    const model = buildEInvoiceModel(receipt(), { buyer: { name: "Buyer" } });
    const { errors, warnings } = validateModel(model);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("catches a corrupted total (integer fils math)", () => {
    const model = buildEInvoiceModel(receipt());
    model.monetaryTotals.taxInclusiveMinor += 1; // corrupt
    const { errors } = validateModel(model);
    expect(errors.some((e) => /tax-inclusive/.test(e))).toBe(true);
  });

  it("warns (not errors) on missing TRN — simplified invoice still allowed", () => {
    const model = buildEInvoiceModel(receipt({ seller: { name: "Shop", trn: null } }));
    const { errors, warnings } = validateModel(model);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => /TRN missing/.test(w))).toBe(true);
    expect(warnings.some((w) => /simplified tax invoice/.test(w))).toBe(true);
  });

  it("rejects a malformed TRN and a bad currency code", () => {
    const badTrn = buildEInvoiceModel(
      receipt({ seller: { name: "Shop", trn: "12345" } }),
    );
    expect(validateModel(badTrn).errors.some((e) => /15 digits/.test(e))).toBe(true);

    const badCurrency = buildEInvoiceModel(receipt({ currency: "AEDX" }));
    expect(
      validateModel(badCurrency).errors.some((e) => /3-letter ISO 4217/.test(e)),
    ).toBe(true);
  });
});

describe("renderUbl", () => {
  it("escapes XML-special characters in text content", () => {
    const model = buildEInvoiceModel(
      receipt({
        seller: { name: `Ahmed & Sons <"Deira'> Trading`, trn: "100123456700003" },
      }),
    );
    const xml = renderUbl(model);
    expect(xml).toContain(
      "Ahmed &amp; Sons &lt;&quot;Deira&apos;&gt; Trading",
    );
    expect(xml).not.toContain(`Ahmed & Sons`);
    // helper behavior directly
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  it("contains the required UBL 2.1 elements and namespaces", () => {
    const xml = renderUbl(buildEInvoiceModel(receipt()));
    expect(xml).toContain('xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"');
    expect(xml).toContain(
      'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    );
    expect(xml).toContain(
      'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"',
    );
    expect(xml).toMatch(/<cbc:ID>INV-000001<\/cbc:ID>/);
    expect(xml).toMatch(/<cbc:IssueDate>2026-08-06<\/cbc:IssueDate>/);
    expect(xml).toMatch(/<cbc:InvoiceTypeCode>380<\/cbc:InvoiceTypeCode>/);
    expect(xml).toMatch(/<cbc:DocumentCurrencyCode>AED<\/cbc:DocumentCurrencyCode>/);
    expect(xml).toContain("<cac:AccountingSupplierParty>");
    expect(xml).toContain('<cbc:CompanyID schemeID="TRN">100123456700003</cbc:CompanyID>');
    expect(xml).toContain("<cac:TaxTotal>");
    expect(xml).toContain("<cac:TaxSubtotal>");
    expect(xml).toMatch(/<cbc:TaxAmount currencyID="AED">208\.43<\/cbc:TaxAmount>/);
    expect(xml).toMatch(/<cbc:TaxableAmount currencyID="AED">4168\.57<\/cbc:TaxableAmount>/);
    expect(xml).toContain("<cac:LegalMonetaryTotal>");
    expect(xml).toMatch(
      /<cbc:TaxInclusiveAmount currencyID="AED">4377\.00<\/cbc:TaxInclusiveAmount>/,
    );
    expect(xml).toMatch(/<cbc:PayableAmount currencyID="AED">4377\.00<\/cbc:PayableAmount>/);
    expect((xml.match(/<cac:InvoiceLine>/g) ?? []).length).toBe(2);
    expect(xml).toContain("verify against current FTA/Peppol PINT-AE docs");
  });

  it("omits the customer party on simplified invoices and includes it on full ones", () => {
    const simplified = renderUbl(buildEInvoiceModel(receipt()));
    expect(simplified).not.toContain("<cac:AccountingCustomerParty>");

    const full = renderUbl(
      buildEInvoiceModel(receipt(), { buyer: { name: "Wholesale Buyer LLC" } }),
    );
    expect(full).toContain("<cac:AccountingCustomerParty>");
    expect(full).toContain("<cbc:Name>Wholesale Buyer LLC</cbc:Name>");
  });

  it("is deterministic: same model renders byte-identical XML", () => {
    const model = buildEInvoiceModel(receipt());
    expect(renderUbl(model)).toBe(renderUbl(buildEInvoiceModel(receipt())));
  });
});
