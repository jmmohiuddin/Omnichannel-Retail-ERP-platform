/**
 * Cash-on-delivery gating (R5.5).
 *
 * THE BUSINESS PROBLEM, in the PRD's own words: roughly 71% of UAE e-commerce
 * is cash on delivery, and a refused COD delivery costs the merchant a
 * round-trip freight charge plus returned stock that has been out on a van.
 * On an AED 4,000 handset that is a real loss on a sale that never happened.
 *
 * THE GATE has two independent limbs, and they refuse for different reasons:
 *
 *   1. VALUE. Above a configured order value, COD requires a partial advance
 *      paid by card or BNPL before the order confirms. The advance is the
 *      merchant's protection against the freight cost of a refusal — it does
 *      not need to cover the whole order, only to make walking away cost the
 *      customer something.
 *
 *   2. RISK. Above a configured risk ceiling, COD is not offered AT ALL, with
 *      honest copy explaining that card or Tabby is required. This is the
 *      limb that an advance cannot cure: a customer who has refused three of
 *      their last four deliveries is not a pricing problem.
 *
 * Pure domain code — no I/O, no clock, no randomness. The risk score is a
 * deterministic function of counted history, which matters because a customer
 * who is refused COD is owed a consistent answer, and because a score that
 * cannot be reproduced cannot be explained or appealed.
 */

/** How the required advance is derived from the order value. */
export type CodAdvanceMode = "fixed" | "percent";

export interface CodPolicy {
  /** Master switch. False means the shop does not offer COD at all. */
  readonly enabled: boolean;
  /**
   * Order totals at or below this need no advance. Above it, an advance is
   * required. PRD's worked example: threshold AED 1,500, cart AED 4,299.
   */
  readonly advanceThresholdMinor: number;
  readonly advanceMode: CodAdvanceMode;
  /** Used when advanceMode is 'fixed'. */
  readonly advanceFixedMinor: number;
  /** Used when advanceMode is 'percent'. Basis points of the order total. */
  readonly advancePercentBp: number;
  /**
   * Risk score (0–100) above which COD is not offered at all. 100 disables
   * the risk limb without disabling COD.
   */
  readonly riskCeiling: number;
  /**
   * Hard ceiling: no COD order above this value regardless of advance or
   * risk. Null means no absolute cap.
   */
  readonly maxOrderMinor: number | null;
}

/** Sensible starting policy for a UAE electronics retailer. */
export const DEFAULT_COD_POLICY: CodPolicy = {
  enabled: true,
  advanceThresholdMinor: 150_000, // AED 1,500
  advanceMode: "percent",
  advanceFixedMinor: 0,
  advancePercentBp: 2_000, // 20% of the order
  riskCeiling: 70,
  maxOrderMinor: null,
};

/* ------------------------------------------------------------------ *
 * Risk
 * ------------------------------------------------------------------ */

export interface CodHistory {
  /** COD orders this customer took delivery of and paid for. */
  readonly delivered: number;
  /** COD orders the customer refused at the door. */
  readonly refused: number;
  /** Deliveries that failed for other reasons — no answer, bad address. */
  readonly undeliverable: number;
}

export const NO_COD_HISTORY: CodHistory = { delivered: 0, refused: 0, undeliverable: 0 };

/**
 * Prior applied to customers with little or no history, so that one refusal
 * on a first order does not score 100 and one success does not score 0.
 *
 * `PRIOR_WEIGHT` is how many imaginary past deliveries the prior is worth;
 * `PRIOR_FAILURE_RATE_BP` is the failure rate assumed for a stranger. Four
 * imaginary orders at a 30% assumed failure rate puts an unknown customer at
 * 30 — below the default ceiling of 70, so a new customer is offered COD, and
 * it takes a genuine pattern of refusals to move them past it.
 */
export const PRIOR_WEIGHT = 4;
export const PRIOR_FAILURE_RATE_BP = 3_000; // 30%

/**
 * A 0–100 score where higher is worse. Laplace-smoothed failure rate:
 *
 *   score = 100 × (failures + w·p) / (total + w)
 *
 * Deliberately NOT a model. It is a counted ratio with a prior, which means
 * it is explainable to a customer who asks why they were refused, reproducible
 * from the history table, and unaffected by when it is computed.
 */
export function codRiskScore(history: CodHistory): number {
  const failures = history.refused + history.undeliverable;
  const total = history.delivered + failures;
  const priorFailures = (PRIOR_WEIGHT * PRIOR_FAILURE_RATE_BP) / 10_000;
  const score = (100 * (failures + priorFailures)) / (total + PRIOR_WEIGHT);
  // Clamped and rounded so the stored score and the displayed score agree.
  return Math.max(0, Math.min(100, Math.round(score)));
}

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

export const COD_REFUSAL_REASONS = [
  "cod_disabled",
  "risk_too_high",
  "over_maximum",
] as const;
export type CodRefusalReason = (typeof COD_REFUSAL_REASONS)[number];

/**
 * Customer-facing copy. The PRD requires "honest copy explaining that card or
 * Tabby is required" — honest meaning it says what the customer must do next,
 * without implying a judgement we would not defend out loud, and without
 * disclosing the score itself.
 */
export const COD_REFUSAL_MESSAGES: Record<CodRefusalReason, string> = {
  cod_disabled: "Cash on delivery is not available. Please pay by card or Tabby.",
  risk_too_high:
    "Cash on delivery isn't available for this order. Please pay by card or Tabby to continue.",
  over_maximum:
    "This order is above our cash-on-delivery limit. Please pay by card or Tabby to continue.",
};

export type CodDecision =
  | {
      readonly allowed: true;
      /** 0 when the order is at or below the advance threshold. */
      readonly advanceRequiredMinor: number;
      readonly riskScore: number;
    }
  | {
      readonly allowed: false;
      readonly reason: CodRefusalReason;
      readonly message: string;
      readonly riskScore: number;
    };

export interface CodRequest {
  readonly orderTotalMinor: number;
  readonly policy: CodPolicy;
  readonly history?: CodHistory;
}

/**
 * How much advance an order of this value requires under this policy. Exposed
 * separately so checkout can show the figure before the shopper commits.
 *
 * The advance is capped at the order total — a percentage rule combined with
 * a fixed floor could otherwise ask for more than the order is worth, which
 * would be indistinguishable from "pay in full" while being labelled a
 * deposit.
 */
export function codAdvanceRequired(orderTotalMinor: number, policy: CodPolicy): number {
  if (!Number.isInteger(orderTotalMinor) || orderTotalMinor < 0) {
    throw new RangeError(`orderTotalMinor must be a non-negative integer, got ${orderTotalMinor}`);
  }
  if (orderTotalMinor <= policy.advanceThresholdMinor) return 0;

  const raw =
    policy.advanceMode === "fixed"
      ? policy.advanceFixedMinor
      : Math.round((orderTotalMinor * policy.advancePercentBp) / 10_000);

  return Math.max(0, Math.min(raw, orderTotalMinor));
}

/** The whole gate: risk limb first, then value limb. */
export function decideCod(request: CodRequest): CodDecision {
  const { orderTotalMinor, policy } = request;
  const riskScore = codRiskScore(request.history ?? NO_COD_HISTORY);

  if (!policy.enabled) {
    return {
      allowed: false,
      reason: "cod_disabled",
      message: COD_REFUSAL_MESSAGES.cod_disabled,
      riskScore,
    };
  }

  if (policy.maxOrderMinor !== null && orderTotalMinor > policy.maxOrderMinor) {
    return {
      allowed: false,
      reason: "over_maximum",
      message: COD_REFUSAL_MESSAGES.over_maximum,
      riskScore,
    };
  }

  // The limb an advance cannot cure.
  if (riskScore > policy.riskCeiling) {
    return {
      allowed: false,
      reason: "risk_too_high",
      message: COD_REFUSAL_MESSAGES.risk_too_high,
      riskScore,
    };
  }

  return {
    allowed: true,
    advanceRequiredMinor: codAdvanceRequired(orderTotalMinor, policy),
    riskScore,
  };
}

/**
 * Whether the advance actually collected satisfies the requirement.
 *
 * Overpayment is fine — a customer who pays more than the deposit has reduced
 * the merchant's exposure, not broken a rule.
 */
export function codAdvanceSatisfied(requiredMinor: number, paidMinor: number): boolean {
  return paidMinor >= requiredMinor;
}
