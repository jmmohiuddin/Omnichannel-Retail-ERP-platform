import { describe, expect, it } from "vitest";
import { ar, en, t, unitStateLabel, type MessageKey } from "./i18n.js";

describe("i18n dictionaries — en/ar parity", () => {
  // Load-bearing: a key present in one language but not the other would render
  // `undefined` on screen for half the cashiers. Checked both directions.
  it("every English key has an Arabic translation", () => {
    const arKeys = new Set(Object.keys(ar));
    const missing = Object.keys(en).filter((k) => !arKeys.has(k));
    expect(missing).toEqual([]);
  });

  it("every Arabic key exists in English (no orphaned ar keys)", () => {
    const enKeys = new Set(Object.keys(en));
    const orphaned = Object.keys(ar).filter((k) => !enKeys.has(k));
    expect(orphaned).toEqual([]);
  });

  it("no Arabic value is empty or whitespace", () => {
    const empty = (Object.entries(ar) as [string, string][])
      .filter(([, v]) => v.trim().length === 0)
      .map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it("core retail keys are actually translated, not copied from English", () => {
    const mustDiffer: MessageKey[] = [
      "totals.subtotal",
      "totals.vat",
      "totals.total",
      "tender.cash",
      "tender.card",
      "tender.loyalty",
      "receipt.taxInvoice",
      "receipt.newSale",
      "login.signIn",
      "cart.empty",
    ];
    for (const key of mustDiffer) {
      expect(ar[key], key).not.toBe(en[key]);
    }
  });

  it("key retail terms use the expected Arabic wording", () => {
    expect(ar["totals.subtotal"]).toContain("المجموع الفرعي");
    expect(ar["totals.total"]).toBe("الإجمالي");
    expect(ar["totals.vat"]).toContain("ضريبة القيمة المضافة");
    expect(ar["tender.cash"]).toBe("نقداً");
    expect(ar["tender.card"]).toBe("بطاقة");
    expect(ar["tender.loyalty"]).toBe("نقاط الولاء");
    expect(ar["receipt.taxInvoice"]).toBe("فاتورة ضريبية");
    expect(ar["receipt.trn"]).toContain("الرقم الضريبي");
    expect(ar["receipt.orderNo"]).toContain("رقم الطلب");
  });
});

describe("t() — lookup and interpolation", () => {
  it("returns the plain string for the requested language", () => {
    expect(t("en", "totals.total")).toBe("Total");
    expect(t("ar", "totals.total")).toBe("الإجمالي");
  });

  it("interpolates {params} in both languages", () => {
    expect(t("en", "scan.noMatch", { code: "SKU-1" })).toBe("No product matches “SKU-1”.");
    expect(t("ar", "scan.noMatch", { code: "SKU-1" })).toContain("SKU-1");
    expect(t("en", "login.failedHttp", { status: 503 })).toBe("Login failed (HTTP 503).");
    expect(t("ar", "login.failedHttp", { status: 503 })).toContain("503");
  });

  it("keeps numeric params in Western digits in the Arabic UI (UAE retail convention)", () => {
    const msg = t("ar", "topbar.pendingSync", { count: 3 });
    expect(msg).toContain("3");
    expect(msg).not.toMatch(/[٠-٩]/); // no Eastern Arabic digits
  });

  it("leaves unknown placeholders verbatim instead of crashing", () => {
    expect(t("en", "scan.noMatch")).toBe("No product matches “{code}”.");
    expect(t("en", "scan.noMatch", { wrong: "x" })).toBe("No product matches “{code}”.");
  });
});

describe("unitStateLabel — serialized-unit state names", () => {
  it("localizes known states", () => {
    expect(unitStateLabel("en", "sold")).toBe("sold");
    expect(unitStateLabel("ar", "sold")).toBe("مُباعة");
    expect(unitStateLabel("en", "returned_pending")).toBe("pending return");
    expect(unitStateLabel("ar", "in_repair")).toBe("قيد الصيانة");
  });

  it("falls back to a humanized raw state for unknown states (newer server)", () => {
    expect(unitStateLabel("en", "quarantined_at_customs")).toBe("quarantined at customs");
    expect(unitStateLabel("ar", "quarantined_at_customs")).toBe("quarantined at customs");
  });
});
