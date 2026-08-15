import { describe, expect, it } from "vitest";
import {
  COD_REFUSAL_MESSAGES,
  DEFAULT_COD_POLICY,
  NO_COD_HISTORY,
  codAdvanceRequired,
  codAdvanceSatisfied,
  codRiskScore,
  decideCod,
  type CodPolicy,
} from "./codGate.js";

const policy = (overrides: Partial<CodPolicy> = {}): CodPolicy => ({
  ...DEFAULT_COD_POLICY,
  ...overrides,
});

describe("codRiskScore", () => {
  it("scores an unknown customer at the prior, not at zero or a hundred", () => {
    // A stranger is neither trusted nor refused: 4 imaginary orders at a 30%
    // assumed failure rate.
    expect(codRiskScore(NO_COD_HISTORY)).toBe(30);
  });

  it("does not condemn a customer for one refusal on their first order", () => {
    // 1 failure out of 1 is a 100% failure rate on a sample of one. The prior
    // holds it to 44, below the default ceiling of 70, so they get one more
    // chance rather than being locked out by a single bad day.
    expect(codRiskScore({ delivered: 0, refused: 1, undeliverable: 0 })).toBe(44);
  });

  it("does not fully trust a customer after one success either", () => {
    expect(codRiskScore({ delivered: 1, refused: 0, undeliverable: 0 })).toBe(24);
  });

  it("converges on the real failure rate as history accumulates", () => {
    // 3 refusals in 4 orders — the PRD's "customer whose COD risk score
    // exceeds the configured ceiling".
    expect(codRiskScore({ delivered: 1, refused: 3, undeliverable: 0 })).toBe(53);
    // 30 refusals in 40 orders: the prior stops mattering.
    expect(codRiskScore({ delivered: 10, refused: 30, undeliverable: 0 })).toBe(71);
    // A long clean record drives the score down toward zero.
    expect(codRiskScore({ delivered: 100, refused: 0, undeliverable: 0 })).toBe(1);
  });

  it("counts undeliverable the same as refused", () => {
    // A parcel that came back because nobody answered cost the same freight
    // as one refused at the door.
    expect(codRiskScore({ delivered: 2, refused: 2, undeliverable: 0 })).toBe(
      codRiskScore({ delivered: 2, refused: 0, undeliverable: 2 }),
    );
  });

  it("stays within 0 and 100 and returns whole numbers", () => {
    for (const h of [
      NO_COD_HISTORY,
      { delivered: 0, refused: 1000, undeliverable: 0 },
      { delivered: 1000, refused: 0, undeliverable: 0 },
    ]) {
      const score = codRiskScore(h);
      expect(Number.isInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});

describe("codAdvanceRequired", () => {
  it("requires nothing at or below the threshold", () => {
    expect(codAdvanceRequired(150_000, policy())).toBe(0);
    expect(codAdvanceRequired(1, policy())).toBe(0);
  });

  it("takes the configured percentage above the threshold", () => {
    // The PRD's worked example: threshold AED 1,500, cart AED 4,299 → 20%.
    expect(codAdvanceRequired(429_900, policy())).toBe(85_980);
  });

  it("takes a flat amount in fixed mode", () => {
    expect(
      codAdvanceRequired(429_900, policy({ advanceMode: "fixed", advanceFixedMinor: 50_000 })),
    ).toBe(50_000);
  });

  it("never asks for more than the order is worth", () => {
    // A fixed advance larger than the order would be "pay in full" wearing a
    // deposit's label.
    expect(
      codAdvanceRequired(160_000, policy({ advanceMode: "fixed", advanceFixedMinor: 500_000 })),
    ).toBe(160_000);
  });

  it("keeps the advance in whole fils", () => {
    const advance = codAdvanceRequired(333_333, policy({ advancePercentBp: 1_733 }));
    expect(Number.isInteger(advance)).toBe(true);
  });

  it("rejects a non-integer order total", () => {
    expect(() => codAdvanceRequired(1_000.5, policy())).toThrow(RangeError);
  });
});

describe("decideCod", () => {
  it("allows a small order from an unknown customer with no advance", () => {
    const decision = decideCod({ orderTotalMinor: 99_000, policy: policy() });
    expect(decision).toEqual({ allowed: true, advanceRequiredMinor: 0, riskScore: 30 });
  });

  it("requires an advance above the threshold", () => {
    const decision = decideCod({ orderTotalMinor: 429_900, policy: policy() });
    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.advanceRequiredMinor).toBe(85_980);
  });

  it("refuses COD outright above the risk ceiling", () => {
    // 30 refusals in 40 orders scores 71, over the default ceiling of 70.
    const decision = decideCod({
      orderTotalMinor: 50_000,
      policy: policy(),
      history: { delivered: 10, refused: 30, undeliverable: 0 },
    });

    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.reason).toBe("risk_too_high");
    // Honest copy that says what to do next, without disclosing the score.
    expect(!decision.allowed && decision.message).toBe(COD_REFUSAL_MESSAGES.risk_too_high);
    expect(!decision.allowed && decision.message).not.toContain("71");
  });

  it("refuses above the absolute maximum even at zero risk", () => {
    const decision = decideCod({
      orderTotalMinor: 1_000_001,
      policy: policy({ maxOrderMinor: 1_000_000 }),
      history: { delivered: 500, refused: 0, undeliverable: 0 },
    });
    expect(!decision.allowed && decision.reason).toBe("over_maximum");
  });

  it("refuses everything when COD is switched off", () => {
    const decision = decideCod({ orderTotalMinor: 1_000, policy: policy({ enabled: false }) });
    expect(!decision.allowed && decision.reason).toBe("cod_disabled");
  });

  it("checks the absolute maximum before the risk ceiling", () => {
    // Both limbs fail. The order-value reason is the one the customer can act
    // on by changing the basket, so it is the more useful thing to say.
    const decision = decideCod({
      orderTotalMinor: 2_000_000,
      policy: policy({ maxOrderMinor: 1_000_000 }),
      history: { delivered: 0, refused: 40, undeliverable: 0 },
    });
    expect(!decision.allowed && decision.reason).toBe("over_maximum");
  });

  it("reports the risk score even when it allows the order", () => {
    // The score is recorded on every decision, not only on refusals — that is
    // what makes the COD performance report (R12.8) possible.
    const decision = decideCod({
      orderTotalMinor: 10_000,
      policy: policy(),
      history: { delivered: 20, refused: 0, undeliverable: 0 },
    });
    expect(decision.riskScore).toBe(5);
  });
});

describe("codAdvanceSatisfied", () => {
  it("accepts exactly the required amount", () => {
    expect(codAdvanceSatisfied(85_980, 85_980)).toBe(true);
  });

  it("rejects a short payment, including one fils short", () => {
    expect(codAdvanceSatisfied(85_980, 85_979)).toBe(false);
  });

  it("accepts an overpayment", () => {
    // Paying more than the deposit reduces the merchant's exposure; refusing
    // it would be a rule enforced against its own purpose.
    expect(codAdvanceSatisfied(85_980, 100_000)).toBe(true);
  });

  it("is satisfied by nothing when nothing is required", () => {
    expect(codAdvanceSatisfied(0, 0)).toBe(true);
  });
});
