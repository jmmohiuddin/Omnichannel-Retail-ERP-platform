import type { MovementInput, MovementType, StockState } from "./types.js";
import { LedgerError } from "./types.js";

/**
 * Shape rules for each movement type: which side(s) must be present, which
 * states they may use, and whether a manager approval is mandatory.
 * These mirror (and must stay in sync with) the CHECK constraints and triggers
 * in packages/db/sql/003_inventory.sql.
 */
interface MovementRule {
  from: "required" | "forbidden" | "optional";
  to: "required" | "forbidden" | "optional";
  /** When set, exactly one of from/to must be present (e.g. count corrections). */
  exactlyOneSide?: boolean;
  fromStates?: StockState[];
  toStates?: StockState[];
  /** from/to must be the same location (e.g. reservation) or different (transfer). */
  locations?: "same" | "different";
  requiresApproval?: boolean;
}

export const MOVEMENT_RULES: Record<MovementType, MovementRule> = {
  receipt: { from: "forbidden", to: "required", toStates: ["on_hand"] },
  sale: { from: "required", to: "forbidden", fromStates: ["on_hand", "reserved"] },
  return_in: { from: "forbidden", to: "required", toStates: ["returned_pending", "on_hand"] },
  transfer_out: {
    from: "required",
    to: "required",
    fromStates: ["on_hand"],
    toStates: ["in_transit"],
    locations: "different",
  },
  transfer_in: {
    from: "required",
    to: "required",
    fromStates: ["in_transit"],
    toStates: ["on_hand"],
    locations: "same",
  },
  adjustment: { from: "required", to: "forbidden", requiresApproval: true },
  reservation: {
    from: "required",
    to: "required",
    fromStates: ["on_hand"],
    toStates: ["reserved"],
    locations: "same",
  },
  release: {
    from: "required",
    to: "required",
    fromStates: ["reserved"],
    toStates: ["on_hand"],
    locations: "same",
  },
  write_off: {
    from: "required",
    to: "forbidden",
    fromStates: ["on_hand", "damaged", "returned_pending"],
    requiresApproval: true,
  },
  count_correction: {
    from: "optional",
    to: "optional",
    fromStates: ["on_hand"],
    toStates: ["on_hand"],
    exactlyOneSide: true, // overage credits on_hand; shortage debits it
    requiresApproval: true,
  },
  repair_out: { from: "required", to: "required", fromStates: ["on_hand"], toStates: ["damaged"], locations: "same" },
  repair_in: { from: "required", to: "required", fromStates: ["damaged"], toStates: ["on_hand"], locations: "same" },
};

export function validateMovementShape(m: MovementInput): void {
  const rule = MOVEMENT_RULES[m.movementType];
  if (!rule) {
    throw new LedgerError("INVALID_SHAPE", `Unknown movement type: ${m.movementType}`);
  }
  if (!Number.isFinite(m.quantity) || m.quantity <= 0) {
    throw new LedgerError("INVALID_SHAPE", "quantity must be a positive number");
  }
  if (rule.from === "required" && !m.from) {
    throw new LedgerError("INVALID_SHAPE", `${m.movementType} requires a source bucket`);
  }
  if (rule.from === "forbidden" && m.from) {
    throw new LedgerError("INVALID_SHAPE", `${m.movementType} must not have a source bucket`);
  }
  if (rule.to === "required" && !m.to) {
    throw new LedgerError("INVALID_SHAPE", `${m.movementType} requires a destination bucket`);
  }
  if (rule.to === "forbidden" && m.to) {
    throw new LedgerError("INVALID_SHAPE", `${m.movementType} must not have a destination bucket`);
  }
  if (rule.exactlyOneSide && Boolean(m.from) === Boolean(m.to)) {
    throw new LedgerError(
      "INVALID_SHAPE",
      `${m.movementType} requires exactly one of source or destination`,
    );
  }
  if (m.from && rule.fromStates && !rule.fromStates.includes(m.from.state)) {
    throw new LedgerError(
      "INVALID_SHAPE",
      `${m.movementType} cannot move from state '${m.from.state}'`,
    );
  }
  if (m.to && rule.toStates && !rule.toStates.includes(m.to.state)) {
    throw new LedgerError(
      "INVALID_SHAPE",
      `${m.movementType} cannot move to state '${m.to.state}'`,
    );
  }
  if (rule.locations && m.from && m.to) {
    const same = m.from.locationId === m.to.locationId;
    if (rule.locations === "same" && !same) {
      throw new LedgerError("INVALID_SHAPE", `${m.movementType} must stay within one location`);
    }
    if (rule.locations === "different" && same) {
      throw new LedgerError("INVALID_SHAPE", `${m.movementType} requires two different locations`);
    }
  }
  if (rule.requiresApproval && !m.approvalId) {
    throw new LedgerError(
      "APPROVAL_REQUIRED",
      `${m.movementType} requires a manager approval (approvalId)`,
    );
  }
}
