/**
 * Pure-logic guard for the Arabic-overlay mapper used by the Catalog page.
 * The mapper decides how a product row pre-fills the Arabic editor, so a
 * regression here would silently reset operator-entered translations.
 */
import { describe, expect, it } from "vitest";
import { readArabicOverlay } from "./Catalog.js";

describe("readArabicOverlay", () => {
  it("returns empty strings when a product has no translations at all", () => {
    expect(readArabicOverlay(undefined)).toEqual({ name: "", description: "" });
    expect(readArabicOverlay({})).toEqual({ name: "", description: "" });
  });

  it("returns empty strings when only other languages exist", () => {
    expect(readArabicOverlay({ fr: { name: "Chargeur" } })).toEqual({
      name: "",
      description: "",
    });
  });

  it("pre-fills only the fields the tenant has authored", () => {
    expect(readArabicOverlay({ ar: { name: "شاحن" } })).toEqual({
      name: "شاحن",
      description: "",
    });
    expect(readArabicOverlay({ ar: { description: "وصف" } })).toEqual({
      name: "",
      description: "وصف",
    });
  });

  it("returns both fields when the Arabic overlay is complete", () => {
    expect(
      readArabicOverlay({ ar: { name: "شاحن", description: "شاحن سريع" } }),
    ).toEqual({ name: "شاحن", description: "شاحن سريع" });
  });
});
