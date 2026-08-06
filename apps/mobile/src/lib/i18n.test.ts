import { describe, expect, it } from "vitest";
import { ar, en, isRtl, t, type MessageKey } from "./i18n";

describe("i18n dictionaries", () => {
  it("every English key has an Arabic translation", () => {
    const arKeys = new Set(Object.keys(ar));
    const missing = Object.keys(en).filter((k) => !arKeys.has(k));
    expect(missing).toEqual([]);
  });

  it("Arabic has no extra keys beyond English", () => {
    const enKeys = new Set(Object.keys(en));
    const extra = Object.keys(ar).filter((k) => !enKeys.has(k));
    expect(extra).toEqual([]);
  });

  it("no Arabic translation is empty or whitespace", () => {
    const empty = Object.entries(ar)
      .filter(([, v]) => v.trim().length === 0)
      .map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it("sampled strings actually differ from English", () => {
    const samples: MessageKey[] = [
      "approvals.approve",
      "approvals.reject",
      "login.signIn",
      "orders.title",
      "stock.title",
    ];
    for (const key of samples) {
      expect(ar[key]).not.toBe(en[key]);
    }
    expect(t("ar", "approvals.approve")).toBe("موافقة");
    expect(t("ar", "approvals.reject")).toBe("رفض");
  });
});

describe("t interpolation", () => {
  it("replaces {token} placeholders in both languages", () => {
    expect(t("en", "approvals.reason", { reason: "damaged box" })).toBe("Reason: damaged box");
    expect(t("ar", "approvals.reason", { reason: "damaged box" })).toBe("السبب: damaged box");
    expect(
      t("en", "stock.availabilityLine", { available: 5, onHand: 7, reserved: 2, inTransit: 0 }),
    ).toBe("Available 5 · On hand 7 · Reserved 2 · In transit 0");
  });

  it("leaves unknown placeholders intact instead of crashing", () => {
    expect(t("en", "approvals.reason", { wrong: "x" })).toBe("Reason: {reason}");
    expect(t("en", "approvals.reason")).toBe("Reason: {reason}");
  });
});

describe("isRtl", () => {
  it("is true only for Arabic", () => {
    expect(isRtl("ar")).toBe(true);
    expect(isRtl("en")).toBe(false);
  });
});
