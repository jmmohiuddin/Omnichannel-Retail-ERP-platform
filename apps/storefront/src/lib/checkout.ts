/**
 * Checkout form validation: name required, at least one of email/phone.
 * Errors are i18n message keys — the page renders them via t(lang, key) so
 * validation copy follows the shopper's language.
 */
import type { MessageKey } from "./i18n.js";

export interface CheckoutInput {
  name: string;
  email: string;
  phone: string;
}

export interface CheckoutErrors {
  name?: MessageKey;
  contact?: MessageKey;
  email?: MessageKey;
  phone?: MessageKey;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()-]{5,20}$/;

/** Returns an errors map; an empty map means the input is valid. */
export function validateCheckout(input: CheckoutInput): CheckoutErrors {
  const errors: CheckoutErrors = {};
  const name = input.name.trim();
  const email = input.email.trim();
  const phone = input.phone.trim();

  if (name.length === 0) errors.name = "checkout.error.nameRequired";
  if (email.length === 0 && phone.length === 0) {
    errors.contact = "checkout.error.contactRequired";
  }
  if (email.length > 0 && !EMAIL_RE.test(email)) {
    errors.email = "checkout.error.email";
  }
  if (phone.length > 0 && !PHONE_RE.test(phone)) {
    errors.phone = "checkout.error.phone";
  }
  return errors;
}

export function isCheckoutValid(errors: CheckoutErrors): boolean {
  return Object.keys(errors).length === 0;
}

/** Build the order customer payload, omitting blank optional fields. */
export function toCustomerPayload(input: CheckoutInput): { name: string; email?: string; phone?: string } {
  const customer: { name: string; email?: string; phone?: string } = { name: input.name.trim() };
  const email = input.email.trim();
  const phone = input.phone.trim();
  if (email.length > 0) customer.email = email;
  if (phone.length > 0) customer.phone = phone;
  return customer;
}
