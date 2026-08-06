import { describe, expect, it } from "vitest";
import { isCheckoutValid, toCustomerPayload, validateCheckout } from "./checkout.js";

describe("validateCheckout", () => {
  it("requires a name", () => {
    const errors = validateCheckout({ name: "   ", email: "a@b.com", phone: "" });
    expect(errors.name).toBeTruthy();
    expect(isCheckoutValid(errors)).toBe(false);
  });

  it("requires at least one of email or phone", () => {
    const errors = validateCheckout({ name: "Ayesha", email: "", phone: "" });
    expect(errors.contact).toBeTruthy();
    expect(isCheckoutValid(errors)).toBe(false);
  });

  it("accepts name + email only", () => {
    const errors = validateCheckout({ name: "Ayesha", email: "ayesha@example.com", phone: "" });
    expect(errors).toEqual({});
    expect(isCheckoutValid(errors)).toBe(true);
  });

  it("accepts name + phone only", () => {
    const errors = validateCheckout({ name: "Omar", email: "", phone: "+971 50 123 4567" });
    expect(errors).toEqual({});
    expect(isCheckoutValid(errors)).toBe(true);
  });

  it("rejects a malformed email even when phone satisfies the contact rule", () => {
    const errors = validateCheckout({ name: "Omar", email: "not-an-email", phone: "+971501234567" });
    expect(errors.email).toBeTruthy();
    expect(errors.contact).toBeUndefined();
    expect(isCheckoutValid(errors)).toBe(false);
  });

  it("rejects a malformed phone", () => {
    const errors = validateCheckout({ name: "Omar", email: "", phone: "abc" });
    expect(errors.phone).toBeTruthy();
    expect(isCheckoutValid(errors)).toBe(false);
  });
});

describe("toCustomerPayload", () => {
  it("trims the name and omits blank optional fields", () => {
    expect(toCustomerPayload({ name: "  Ayesha  ", email: "", phone: "  " })).toEqual({
      name: "Ayesha",
    });
  });

  it("includes email and phone when provided", () => {
    expect(
      toCustomerPayload({ name: "Omar", email: " omar@example.com ", phone: "+971501234567" }),
    ).toEqual({ name: "Omar", email: "omar@example.com", phone: "+971501234567" });
  });
});
