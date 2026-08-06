import { describe, expect, it } from "vitest";
import { ar, en, t, type MessageKey } from "./i18n.js";

describe("i18n dictionaries", () => {
  it("every English key has an Arabic translation", () => {
    const enKeys = Object.keys(en).sort();
    const arKeys = Object.keys(ar).sort();
    const missing = enKeys.filter((k) => !arKeys.includes(k));
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

  it("sampled commerce strings actually differ from English", () => {
    const samples: MessageKey[] = [
      "product.addToCart",
      "cart.checkout",
      "catalog.inStock",
      "catalog.outOfStock",
      "confirm.payNow",
      "confirm.orderNumber",
    ];
    for (const key of samples) {
      expect(ar[key]).not.toBe(en[key]);
    }
    expect(t("ar", "product.addToCart")).toBe("أضف إلى السلة");
    expect(t("en", "product.addToCart")).toBe("Add to cart");
  });
});

describe("t interpolation", () => {
  it("replaces {token} placeholders in both languages", () => {
    expect(t("en", "catalog.noMatches", { query: "iphone" })).toBe(
      "No products match “iphone”.",
    );
    expect(t("ar", "catalog.noMatches", { query: "iphone" })).toContain("iphone");
    expect(
      t("en", "checkout.shortageOnlyLeft", {
        name: "iPhone 15",
        sku: "IP15-BLK",
        requested: 3,
        available: 1,
      }),
    ).toBe("iPhone 15 (SKU IP15-BLK) — requested 3, only 1 left");
  });

  it("leaves unknown placeholders intact instead of crashing", () => {
    expect(t("en", "catalog.noMatches", { wrong: "x" })).toBe("No products match “{query}”.");
    expect(t("en", "catalog.noMatches")).toBe("No products match “{query}”.");
  });
});
