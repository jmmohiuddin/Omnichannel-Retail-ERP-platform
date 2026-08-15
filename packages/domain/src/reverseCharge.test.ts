import { describe, expect, it } from "vitest";
import {
  RCM_REFUSAL_SENTENCES,
  REVERSE_CHARGE_STATEMENT,
  isRcmDeviceClass,
  lineTotalsForCategory,
  rcmRefusalReason,
  resolveSaleTaxTreatment,
  type RcmLineInput,
  type SaleTaxContext,
} from "./reverseCharge.js";

const HANDSET: RcmLineInput = { lineId: "handset", deviceClass: "smart_phone" };
const CASE: RcmLineInput = { lineId: "case" }; // an accessory: not a device
const EXPORTED: RcmLineInput = { lineId: "export", deviceClass: "tablet", zeroRated: true };

/** A context where all four CD 91/2023 conditions are satisfied. */
const qualifying = (overrides: Partial<SaleTaxContext> = {}): SaleTaxContext => ({
  rcmRequested: true,
  supplierTrn: "100123456700003",
  buyerTrn: "100987654300003",
  declaration: {
    declaresResaleOrManufacture: true,
    declaresFtaRegistered: true,
    verification: { method: "fta_portal", outcome: "verified" },
  },
  standardRateBp: 500,
  lines: [HANDSET],
  ...overrides,
});

describe("the four conditions of CD 91/2023", () => {
  it("applies reverse charge when every condition is met", () => {
    const result = resolveSaleTaxTreatment(qualifying());

    expect(result.kind).toBe("reverse_charge");
    expect(result.lines[0]).toEqual({
      lineId: "handset",
      category: "AE",
      rateBp: 0,
      reverseCharge: true,
    });
    expect(result.requiresReverseChargeStatement).toBe(true);
    expect(result.refusedReason).toBeUndefined();
  });

  it("refuses when the shop has no TRN of its own", () => {
    const result = resolveSaleTaxTreatment(qualifying({ supplierTrn: undefined }));
    expect(result.kind).toBe("standard");
    expect(result.refusedReason).toBe("supplier_not_registered");
  });

  it("refuses when the buyer's TRN was not captured", () => {
    const result = resolveSaleTaxTreatment(qualifying({ buyerTrn: undefined }));
    expect(result.refusedReason).toBe("buyer_trn_missing");
  });

  it("refuses when there is no declaration at all", () => {
    const result = resolveSaleTaxTreatment(qualifying({ declaration: undefined }));
    expect(result.refusedReason).toBe("declaration_missing");
  });

  it("distinguishes the two halves of the declaration", () => {
    // Registered, but buying for own business use — R7.3a's second carve-out.
    expect(
      resolveSaleTaxTreatment(
        qualifying({
          declaration: {
            declaresResaleOrManufacture: false,
            declaresFtaRegistered: true,
            verification: { method: "fta_portal", outcome: "verified" },
          },
        }),
      ).refusedReason,
    ).toBe("resale_intent_not_declared");

    // Intends to resell, but has not confirmed FTA registration.
    expect(
      resolveSaleTaxTreatment(
        qualifying({
          declaration: {
            declaresResaleOrManufacture: true,
            declaresFtaRegistered: false,
            verification: { method: "fta_portal", outcome: "verified" },
          },
        }),
      ).refusedReason,
    ).toBe("fta_registration_not_declared");
  });

  it("R7.3a: a complete declaration is NOT enough without verification", () => {
    // This is the clause implementations miss. Both declaration flags are
    // true and the TRNs are present — only the supplier-side verification of
    // the buyer's registration is absent, and that alone must refuse.
    const result = resolveSaleTaxTreatment(
      qualifying({
        declaration: { declaresResaleOrManufacture: true, declaresFtaRegistered: true },
      }),
    );

    expect(result.kind).toBe("standard");
    expect(result.refusedReason).toBe("registration_not_verified");
    expect(result.lines[0]!.category).toBe("S");
    expect(result.lines[0]!.rateBp).toBe(500);
  });

  it.each(["failed", "unavailable"] as const)(
    "refuses when verification came back %s",
    (outcome) => {
      const result = resolveSaleTaxTreatment(
        qualifying({
          declaration: {
            declaresResaleOrManufacture: true,
            declaresFtaRegistered: true,
            verification: { method: "fta_portal", outcome },
          },
        }),
      );
      expect(result.refusedReason).toBe("registration_not_verified");
    },
  );

  it("refuses a sale with no qualifying device lines", () => {
    const result = resolveSaleTaxTreatment(qualifying({ lines: [CASE] }));
    expect(result.refusedReason).toBe("no_qualifying_device_lines");
  });
});

describe("the cashier's one sentence", () => {
  it("explains every refusal of something the cashier asked for", () => {
    const result = resolveSaleTaxTreatment(
      qualifying({
        declaration: { declaresResaleOrManufacture: true, declaresFtaRegistered: true },
      }),
    );
    expect(result.refusedMessage).toBe(RCM_REFUSAL_SENTENCES.registration_not_verified);
    // One sentence, per the PRD's acceptance criteria.
    expect(result.refusedMessage!.split(". ").filter(Boolean)).toHaveLength(1);
  });

  it("says nothing on an ordinary consumer sale", () => {
    // A walk-in cash sale never asked for reverse charge, so there is no
    // refusal to explain and no message to put in front of the cashier.
    const result = resolveSaleTaxTreatment(
      qualifying({ rcmRequested: false, buyerTrn: undefined, declaration: undefined }),
    );
    expect(result.kind).toBe("standard");
    expect(result.refusedReason).toBeUndefined();
    expect(result.refusedMessage).toBeUndefined();
    expect(result.lines[0]!.category).toBe("S");
  });

  it("has a sentence for every reason code", () => {
    for (const [reason, sentence] of Object.entries(RCM_REFUSAL_SENTENCES)) {
      expect(sentence.length, reason).toBeGreaterThan(20);
      expect(sentence.trim().endsWith("."), reason).toBe(true);
    }
  });
});

describe("per-line eligibility", () => {
  it("mixes AE devices with standard-rated accessories on one invoice", () => {
    const result = resolveSaleTaxTreatment(qualifying({ lines: [HANDSET, CASE] }));

    expect(result.kind).toBe("mixed");
    expect(result.lines).toEqual([
      { lineId: "handset", category: "AE", rateBp: 0, reverseCharge: true },
      { lineId: "case", category: "S", rateBp: 500, reverseCharge: false },
    ]);
    // One reverse-charged line is enough to require the statement.
    expect(result.requiresReverseChargeStatement).toBe(true);
  });

  it("R7.3a: a zero-rated export line stays zero-rated, never AE", () => {
    const result = resolveSaleTaxTreatment(qualifying({ lines: [HANDSET, EXPORTED] }));

    expect(result.lines[1]).toEqual({
      lineId: "export",
      category: "Z",
      rateBp: 0,
      reverseCharge: false,
    });
  });

  it("an exempt line stays exempt", () => {
    const result = resolveSaleTaxTreatment(
      qualifying({ lines: [HANDSET, { lineId: "x", deviceClass: "part", exempt: true }] }),
    );
    expect(result.lines[1]!.category).toBe("E");
  });

  it("a sale of only zero-rated devices has no qualifying line", () => {
    // Every line is a device, but the carve-out removes them all, so there is
    // nothing left to reverse-charge.
    expect(rcmRefusalReason(qualifying({ lines: [EXPORTED] }))).toBe("no_qualifying_device_lines");
  });
});

describe("lineTotalsForCategory", () => {
  it("standard rated: VAT is extracted from the inclusive shelf price", () => {
    // AED 2,100.00 inclusive at 5% → 100.00 VAT, 2,000.00 net.
    expect(lineTotalsForCategory(210_000, 1, 500, "S")).toEqual({
      grossMinor: 210_000,
      taxMinor: 10_000,
      netMinor: 200_000,
    });
  });

  it("reverse charge: the buyer pays the VAT-exclusive amount", () => {
    // The subtle one — RCM is not the same price with a different label. The
    // shelf price of 2,100.00 becomes an invoice for 2,000.00 with no VAT.
    expect(lineTotalsForCategory(210_000, 1, 500, "AE")).toEqual({
      grossMinor: 200_000,
      taxMinor: 0,
      netMinor: 200_000,
    });
  });

  it("charges no VAT on zero-rated, exempt and out-of-scope lines", () => {
    for (const category of ["Z", "E", "O"] as const) {
      expect(lineTotalsForCategory(210_000, 1, 500, category)).toEqual({
        grossMinor: 210_000,
        taxMinor: 0,
        netMinor: 210_000,
      });
    }
  });

  it("applies quantity and discount before the tax split", () => {
    // 3 × 210.00 = 630.00, less a 30.00 discount = 600.00 inclusive.
    expect(lineTotalsForCategory(21_000, 3, 500, "S", 3_000)).toEqual({
      grossMinor: 60_000,
      taxMinor: 2_857, // round(60000 × 500 / 10500)
      netMinor: 57_143,
    });
  });

  it("keeps money in integers", () => {
    // A price that does not divide evenly must still produce whole fils.
    const totals = lineTotalsForCategory(33_333, 7, 500, "S");
    for (const value of Object.values(totals)) {
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(totals.netMinor + totals.taxMinor).toBe(totals.grossMinor);
  });

  it("rejects a discount larger than the line", () => {
    expect(() => lineTotalsForCategory(10_000, 1, 500, "S", 20_000)).toThrow(RangeError);
  });

  it("rejects non-integer money", () => {
    expect(() => lineTotalsForCategory(10_000.5, 1, 500, "S")).toThrow(RangeError);
  });
});

describe("guards and constants", () => {
  it("rejects an out-of-range standard rate", () => {
    expect(() => resolveSaleTaxTreatment(qualifying({ standardRateBp: 10_001 }))).toThrow(RangeError);
    expect(() => resolveSaleTaxTreatment(qualifying({ standardRateBp: -1 }))).toThrow(RangeError);
  });

  it("recognises only the CD 91/2023 device classes", () => {
    expect(isRcmDeviceClass("smart_phone")).toBe(true);
    expect(isRcmDeviceClass("part")).toBe(true);
    expect(isRcmDeviceClass("charger")).toBe(false);
    expect(isRcmDeviceClass(undefined)).toBe(false);
  });

  it("cites the Cabinet Decision in both languages", () => {
    // The PRD's acceptance criteria require the statement to reference
    // CD 91/2023 by name; a generic "reverse charge applies" is not enough.
    expect(REVERSE_CHARGE_STATEMENT.en).toContain("91 of 2023");
    // Western digits on purpose: UAE legal and tax documents in Arabic write
    // decision numbers this way, and mixing numeral systems across the two
    // language versions of one invoice invites a transcription error.
    expect(REVERSE_CHARGE_STATEMENT.ar).toContain("91");
    expect(REVERSE_CHARGE_STATEMENT.ar).toContain("2023");
    expect(REVERSE_CHARGE_STATEMENT.ar).toContain("مجلس الوزراء");
  });
});
