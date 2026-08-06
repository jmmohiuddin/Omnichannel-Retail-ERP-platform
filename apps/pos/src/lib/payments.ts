/**
 * Pure tender math for split payments. Loyalty is applied first, capped both
 * by the customer's redeemable balance and by the amount due; whatever remains
 * is taken by the chosen cash/card method. All amounts are integer fils.
 */
import type { SalePaymentPayload, TenderMethod } from "./api.js";

/** Fils of loyalty value applied: min(balance, due), never negative. */
export function loyaltyApplicableMinor(totalDueMinor: number, loyaltyValueMinor: number): number {
  if (totalDueMinor <= 0 || loyaltyValueMinor <= 0) return 0;
  return Math.min(loyaltyValueMinor, totalDueMinor);
}

/**
 * Build the payments array for one sale POST. With no loyalty this is the
 * single cash/card payment; with loyalty it is `loyalty_points` first and the
 * remainder (if any) via `method`. Amounts always sum to `totalDueMinor`.
 */
export function planPayments(
  totalDueMinor: number,
  loyaltyValueMinor: number,
  method: TenderMethod,
): SalePaymentPayload[] {
  const loyaltyMinor = loyaltyApplicableMinor(totalDueMinor, loyaltyValueMinor);
  const remainderMinor = totalDueMinor - loyaltyMinor;
  const payments: SalePaymentPayload[] = [];
  if (loyaltyMinor > 0) payments.push({ method: "loyalty_points", amountMinor: loyaltyMinor });
  if (remainderMinor > 0 || payments.length === 0) {
    payments.push({ method, amountMinor: remainderMinor });
  }
  return payments;
}
