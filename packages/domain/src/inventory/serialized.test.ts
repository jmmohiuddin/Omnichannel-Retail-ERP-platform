import { describe, expect, it } from "vitest";
import { SerializedInventory, isValidImei } from "./serialized.js";
import { LedgerError } from "./types.js";

// 490154203237518 is the canonical GSMA example IMEI (valid Luhn).
const IMEI_A = "490154203237518";
const IMEI_B = "352099001761481";

describe("IMEI validation", () => {
  it("accepts valid 15-digit IMEIs and 16-digit IMEISVs", () => {
    expect(isValidImei(IMEI_A)).toBe(true);
    expect(isValidImei(IMEI_B)).toBe(true);
    expect(isValidImei("4901542032375189".slice(0, 16))).toBe(true); // IMEISV form
  });

  it("rejects wrong length, non-digits, and bad check digits", () => {
    expect(isValidImei("49015420323751")).toBe(false); // 14 digits
    expect(isValidImei("49015420323751x")).toBe(false);
    expect(isValidImei("490154203237519")).toBe(false); // wrong Luhn digit
  });
});

describe("SerializedInventory uniqueness", () => {
  it("never permits duplicate IMEIs, across imei1 and imei2", () => {
    const inv = new SerializedInventory();
    inv.register({ id: "u1", variantId: "v1", imei1: IMEI_A, state: "in_stock" });

    expect(() =>
      inv.register({ id: "u2", variantId: "v1", imei1: IMEI_A, state: "in_stock" }),
    ).toThrowError(/already belongs/);

    expect(() =>
      inv.register({ id: "u3", variantId: "v1", imei1: IMEI_B, imei2: IMEI_A, state: "in_stock" }),
    ).toThrowError(/already belongs/);
  });

  it("rejects invalid IMEIs at registration", () => {
    const inv = new SerializedInventory();
    expect(() =>
      inv.register({ id: "u1", variantId: "v1", imei1: "123", state: "in_stock" }),
    ).toThrow(LedgerError);
  });

  it("looks up a unit by either IMEI (POS scan path)", () => {
    const inv = new SerializedInventory();
    inv.register({ id: "u1", variantId: "v1", imei1: IMEI_A, imei2: IMEI_B, state: "in_stock" });
    expect(inv.byImei(IMEI_A)?.id).toBe("u1");
    expect(inv.byImei(IMEI_B)?.id).toBe("u1");
  });
});

describe("unit state machine", () => {
  it("follows the legal sales path", () => {
    const inv = new SerializedInventory();
    inv.register({ id: "u1", variantId: "v1", imei1: IMEI_A, state: "in_stock" });
    inv.transition("u1", "reserved");
    inv.transition("u1", "sold");
    inv.transition("u1", "returned_pending");
    inv.transition("u1", "in_stock");
    expect(inv.get("u1")?.state).toBe("in_stock");
  });

  it("blocks illegal jumps (a sold phone cannot silently return to stock)", () => {
    const inv = new SerializedInventory();
    inv.register({ id: "u1", variantId: "v1", imei1: IMEI_A, state: "in_stock" });
    inv.transition("u1", "sold");
    expect(() => inv.transition("u1", "in_stock")).toThrowError(/illegal state transition/);
  });

  it("written_off is terminal", () => {
    const inv = new SerializedInventory();
    inv.register({ id: "u1", variantId: "v1", state: "damaged" });
    inv.transition("u1", "written_off");
    for (const next of ["in_stock", "sold", "damaged"] as const) {
      expect(() => inv.transition("u1", next)).toThrow(LedgerError);
    }
  });
});
