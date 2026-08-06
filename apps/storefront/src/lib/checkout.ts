/** Checkout form validation: name required, at least one of email/phone. */

export interface CheckoutInput {
  name: string;
  email: string;
  phone: string;
}

export interface CheckoutErrors {
  name?: string;
  contact?: string;
  email?: string;
  phone?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()-]{5,20}$/;

/** Returns an errors map; an empty map means the input is valid. */
export function validateCheckout(input: CheckoutInput): CheckoutErrors {
  const errors: CheckoutErrors = {};
  const name = input.name.trim();
  const email = input.email.trim();
  const phone = input.phone.trim();

  if (name.length === 0) errors.name = "Your name is required.";
  if (email.length === 0 && phone.length === 0) {
    errors.contact = "Provide an email address or a phone number so we can reach you.";
  }
  if (email.length > 0 && !EMAIL_RE.test(email)) {
    errors.email = "That email address doesn't look right.";
  }
  if (phone.length > 0 && !PHONE_RE.test(phone)) {
    errors.phone = "That phone number doesn't look right.";
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
