import { describe, expect, it } from "vitest";
import { ar, en, enumLabel, t, type MessageKey } from "./i18n.js";

describe("dictionary parity (load-bearing)", () => {
  it("every en key exists in ar", () => {
    const arKeys = new Set(Object.keys(ar));
    const missing = Object.keys(en).filter((k) => !arKeys.has(k));
    expect(missing).toEqual([]);
  });

  it("every ar key exists in en (no orphan Arabic keys)", () => {
    const enKeys = new Set(Object.keys(en));
    const orphans = Object.keys(ar).filter((k) => !enKeys.has(k));
    expect(orphans).toEqual([]);
  });

  it("no ar value is empty or whitespace-only", () => {
    const empty = (Object.entries(ar) as [string, string][])
      .filter(([, v]) => v.trim().length === 0)
      .map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it("ar templates keep exactly the same {param} placeholders as en", () => {
    const placeholders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();
    const mismatched = (Object.keys(en) as MessageKey[]).filter(
      (k) => placeholders(en[k]).join(",") !== placeholders(ar[k]).join(","),
    );
    expect(mismatched).toEqual([]);
  });
});

describe("ar is actually translated (catches copy-paste English)", () => {
  const SAMPLE: MessageKey[] = [
    "nav.dashboard",
    "nav.inventory",
    "nav.orders",
    "nav.approvals",
    "nav.signOut",
    "finance.trialBalance",
    "th.vat",
    "login.submit",
    "kind.refund",
    "status.pending",
    "state.on_hand",
    "audit.title",
  ];

  it.each(SAMPLE)("ar[%s] differs from en and contains Arabic script", (key) => {
    expect(ar[key]).not.toBe(en[key]);
    expect(ar[key]).toMatch(/[؀-ۿ]/);
  });
});

describe("t() interpolation", () => {
  it("substitutes {name}-style params in both languages", () => {
    const enOut = t("en", "approvals.refundOn", { amount: "AED 1,299.50", order: "77777777" });
    expect(enOut).toBe("Refund AED 1,299.50 on order 77777777");

    const arOut = t("ar", "approvals.refundOn", { amount: "AED 1,299.50", order: "77777777" });
    expect(arOut).toContain("استرداد");
    expect(arOut).toContain("AED 1,299.50");
    expect(arOut).toContain("77777777");
  });

  it("stringifies numeric params", () => {
    expect(t("en", "catalog.countProducts", { count: 7 })).toBe("7 products");
    expect(t("ar", "catalog.countProducts", { count: 7 })).toBe("7 منتج");
  });

  it("leaves unknown placeholders verbatim instead of rendering undefined", () => {
    expect(t("en", "approvals.refund", {})).toBe("Refund {amount}");
    expect(t("en", "nav.dashboard", { bogus: "x" })).toBe("Dashboard");
  });
});

describe("enumLabel()", () => {
  it("resolves known server enum values per language", () => {
    expect(enumLabel("en", "status", "pending")).toBe("Pending");
    expect(enumLabel("ar", "status", "pending")).toBe("قيد الانتظار");
    expect(enumLabel("ar", "state", "on_hand")).toBe("متوفر");
    expect(enumLabel("ar", "mtype", "transfer_out")).toBe("تحويل صادر");
  });

  it("falls back to a humanized label for unknown values (never blank)", () => {
    expect(enumLabel("en", "status", "half_shipped")).toBe("Half shipped");
    expect(enumLabel("ar", "mtype", "quantum_leap")).toBe("Quantum leap");
  });
});
