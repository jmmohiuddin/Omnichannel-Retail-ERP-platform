import { describe, expect, it } from "vitest";
import { classifyScanToken, isImeiToken } from "./scan.js";

// 490154203237518 is the canonical Luhn-valid test IMEI (GSMA TS.06).
const VALID_IMEI = "490154203237518";

describe("isImeiToken / classifyScanToken — scan-input routing", () => {
  it("routes a Luhn-valid 15-digit IMEI to the stock-unit lookup", () => {
    expect(isImeiToken(VALID_IMEI)).toBe(true);
    expect(classifyScanToken(VALID_IMEI)).toBe("stock-unit");
  });

  it("routes a 16-digit IMEISV to the stock-unit lookup (no Luhn check)", () => {
    expect(classifyScanToken("4901542032375181")).toBe("stock-unit");
  });

  it("routes a 14-digit numeric barcode to the normal product search", () => {
    expect(isImeiToken("49015420323751")).toBe(false);
    expect(classifyScanToken("49015420323751")).toBe("product");
  });

  it("routes a 15-digit token with a bad Luhn check digit to product search", () => {
    expect(isImeiToken("490154203237519")).toBe(false);
    expect(classifyScanToken("490154203237519")).toBe("product");
  });

  it("routes SKUs, EAN-13s and 17+ digit strings to product search", () => {
    expect(classifyScanToken("IP15-128-BLK")).toBe("product");
    expect(classifyScanToken("6291041500213")).toBe("product"); // EAN-13
    expect(classifyScanToken("49015420323751812")).toBe("product");
    expect(classifyScanToken(`${VALID_IMEI} `)).toBe("product"); // caller trims first
  });
});

describe("scan-input digit handling is language-independent", () => {
  // Scanners emit Western (ASCII) digits regardless of the UI language; the
  // Arabic UI must not remap or reinterpret them (lib/i18n.ts file header).
  it("Western-digit IMEIs and barcodes route identically with the Arabic UI active", async () => {
    const { applyLangToDocument } = await import("./langStore.js");
    applyLangToDocument("ar"); // no-op in node, but exercises the code path
    expect(isImeiToken(VALID_IMEI)).toBe(true);
    expect(classifyScanToken(VALID_IMEI)).toBe("stock-unit");
    expect(classifyScanToken("6291041500213")).toBe("product");
  });

  it("Eastern Arabic digit strings are never IMEI tokens (no digit conversion)", () => {
    const easternDigits = "٤٩٠١٥٤٢٠٣٢٣٧٥١٨"; // ٠-٩ rendering of the valid IMEI
    expect(isImeiToken(easternDigits)).toBe(false);
    expect(classifyScanToken(easternDigits)).toBe("product");
  });
});
