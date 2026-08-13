import { describe, expect, it } from "vitest";
import {
  EMIRATES,
  assertEmirate,
  emirateInfo,
  isEmirate,
  lineTotals,
  resolveSupplyEmirate,
  saleTotals,
  vatFromInclusive,
  vatReturnBox,
  type Emirate,
} from "./tax.js";

describe("Emirate", () => {
  it("is exactly the seven emirates, in VAT return Box 1 order", () => {
    expect(EMIRATES).toEqual(["AZ", "DU", "SH", "AJ", "UQ", "RK", "FU"]);
    expect(new Set(EMIRATES).size).toBe(7);
    expect(EMIRATES.map((e) => vatReturnBox(e))).toEqual([
      "1a", "1b", "1c", "1d", "1e", "1f", "1g",
    ]);
  });

  it("recognises valid codes and rejects everything else", () => {
    for (const code of EMIRATES) expect(isEmirate(code)).toBe(true);
    // Common wrong guesses: full names, lowercase, ISO-prefixed, other countries.
    for (const bad of ["Dubai", "du", "AE-DU", "XX", "", null, undefined, 7, {}]) {
      expect(isEmirate(bad)).toBe(false);
    }
    // Inherited Object properties must not pass as codes.
    expect(isEmirate("toString")).toBe(false);
    expect(isEmirate("constructor")).toBe(false);
  });

  it("assertEmirate narrows or throws with the allowed values named", () => {
    const narrowed: Emirate = assertEmirate("SH");
    expect(narrowed).toBe("SH");
    expect(() => assertEmirate("Dubai", "branchEmirate")).toThrow(RangeError);
    expect(() => assertEmirate("Dubai", "branchEmirate")).toThrow(/branchEmirate.*AZ, DU/s);
  });

  it("carries English, Arabic and ISO 3166-2 identifiers for every emirate", () => {
    for (const code of EMIRATES) {
      const info = emirateInfo(code);
      expect(info.code).toBe(code);
      expect(info.iso).toBe(`AE-${code}`);
      expect(info.en.length).toBeGreaterThan(0);
      // Arabic is mandatory on a UAE consumer invoice — the name must be Arabic script.
      expect(info.ar).toMatch(/^[؀-ۿ\s]+$/);
    }
    expect(emirateInfo("DU")).toMatchObject({ en: "Dubai", iso: "AE-DU", vatReturnBox: "1b" });
    expect(emirateInfo("UQ").en).toBe("Umm Al Quwain");
  });

  it("returns a copy, so a caller cannot corrupt the table", () => {
    const first = emirateInfo("DU");
    first.en = "Sharjah";
    expect(emirateInfo("DU").en).toBe("Dubai");
  });
});

describe("resolveSupplyEmirate", () => {
  it("uses the selling branch, NOT the customer's address", () => {
    // The rule that is easy to get wrong: a Dubai branch selling to a
    // Sharjah-resident customer is a Dubai supply.
    expect(resolveSupplyEmirate({ branchEmirate: "DU", customerEmirate: "SH" })).toEqual({
      emirate: "DU",
      basis: "fixed_establishment",
    });
  });

  it("ignores the customer's emirate for an ordinary e-commerce sale", () => {
    // Not a qualifying registrant → still the branch, even for a web order.
    expect(
      resolveSupplyEmirate({
        branchEmirate: "AZ",
        customerEmirate: "FU",
        qualifyingRegistrantEcommerce: false,
      }),
    ).toEqual({ emirate: "AZ", basis: "fixed_establishment" });
  });

  it("reports by customer location only for a qualifying registrant's e-commerce supply", () => {
    expect(
      resolveSupplyEmirate({
        branchEmirate: "DU",
        customerEmirate: "RK",
        qualifyingRegistrantEcommerce: true,
      }),
    ).toEqual({ emirate: "RK", basis: "customer_location" });
  });

  it("falls back to the branch when the exception applies but the customer emirate is unknown", () => {
    expect(
      resolveSupplyEmirate({ branchEmirate: "DU", qualifyingRegistrantEcommerce: true }),
    ).toEqual({ emirate: "DU", basis: "fixed_establishment" });
  });

  it("rejects an unknown branch emirate rather than defaulting one", () => {
    expect(() =>
      resolveSupplyEmirate({ branchEmirate: "Dubai" as Emirate }),
    ).toThrow(RangeError);
    expect(() =>
      resolveSupplyEmirate({
        branchEmirate: "DU",
        customerEmirate: "ABU" as Emirate,
        qualifyingRegistrantEcommerce: true,
      }),
    ).toThrow(RangeError);
  });
});

describe("vatFromInclusive (UAE 5% = 500bp)", () => {
  it("extracts VAT from inclusive price", () => {
    // AED 105.00 inclusive at 5% → 5.00 VAT, 100.00 net
    expect(vatFromInclusive(10500, 500)).toBe(500);
    // AED 4199.00 phone → VAT = 4199 × 5/105 = 199.952… → 199.95
    expect(vatFromInclusive(419900, 500)).toBe(19995);
  });

  it("handles zero rate and zero amount", () => {
    expect(vatFromInclusive(10000, 0)).toBe(0);
    expect(vatFromInclusive(0, 500)).toBe(0);
  });

  it("rejects non-integer or negative input", () => {
    expect(() => vatFromInclusive(10.5, 500)).toThrow(RangeError);
    expect(() => vatFromInclusive(-1, 500)).toThrow(RangeError);
    expect(() => vatFromInclusive(100, 20000)).toThrow(RangeError);
  });
});

describe("lineTotals", () => {
  it("computes gross/tax/net with quantity", () => {
    const line = lineTotals(10500, 2, 500);
    expect(line).toEqual({ grossMinor: 21000, taxMinor: 1000, netMinor: 20000 });
  });

  it("applies line discount before VAT extraction", () => {
    const line = lineTotals(10500, 1, 500, 500); // 105.00 − 5.00 discount
    expect(line.grossMinor).toBe(10000);
    expect(line.taxMinor).toBe(476); // 100.00 × 5/105 = 4.7619 → 4.76
  });

  it("rejects discount larger than the line", () => {
    expect(() => lineTotals(1000, 1, 500, 2000)).toThrow(RangeError);
  });
});

describe("saleTotals", () => {
  it("sums per-line VAT (invoice-consistent)", () => {
    const totals = saleTotals([
      lineTotals(419900, 1, 500), // phone
      lineTotals(8900, 2, 500),   // two chargers
    ]);
    expect(totals.subtotalMinor).toBe(419900 + 17800);
    expect(totals.taxMinor).toBe(19995 + 848); // 178.00 × 5/105 = 8.476 → 8.48
    expect(totals.totalMinor).toBe(totals.subtotalMinor);
    expect(totals.netMinor + totals.taxMinor).toBe(totals.totalMinor);
  });
});
