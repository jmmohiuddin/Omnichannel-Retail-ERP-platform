/**
 * Core inventory types. This package is pure: no I/O, no framework imports.
 * The same code runs on the server and inside the offline POS client, so the
 * ledger invariants are enforced identically everywhere (ADR-002, ADR-007).
 */

export type StockState =
  | "on_hand"
  | "reserved"
  | "in_transit"
  | "damaged"
  | "returned_pending";

export type MovementType =
  | "receipt"
  | "sale"
  | "return_in"
  | "transfer_out"
  | "transfer_in"
  | "adjustment"
  | "reservation"
  | "release"
  | "write_off"
  | "count_correction"
  | "repair_out"
  | "repair_in";

export interface BucketRef {
  locationId: string;
  state: StockState;
}

export interface MovementInput {
  /** Client-generated UUID — the idempotency key for offline replay. */
  id: string;
  movementType: MovementType;
  variantId: string;
  /** Required when the variant is serialized; quantity must then be 1. */
  stockUnitId?: string;
  quantity: number;
  from?: BucketRef;
  to?: BucketRef;
  actorUserId: string;
  deviceId?: string;
  reference: { type: string; id: string };
  /** Manager approval — mandatory for adjustment / write_off / count_correction. */
  approvalId?: string;
  occurredAt: Date;
  note?: string;
}

export interface PostedMovement extends MovementInput {
  /** Monotonic sequence assigned at post time — the sync cursor. */
  seq: number;
}

export interface Availability {
  onHand: number;
  reserved: number;
  /** What can actually be promised to a new order. */
  available: number;
  inTransit: number;
  damaged: number;
  returnedPending: number;
}

export type UnitState =
  | "inbound"
  | "in_stock"
  | "reserved"
  | "sold"
  | "returned_pending"
  | "in_transit"
  | "in_repair"
  | "damaged"
  | "written_off";

export class LedgerError extends Error {
  constructor(
    readonly code:
      | "INVALID_SHAPE"
      | "INSUFFICIENT_STOCK"
      | "APPROVAL_REQUIRED"
      | "DUPLICATE_MOVEMENT"
      | "SERIALIZED_RULE"
      | "DUPLICATE_IMEI"
      | "INVALID_IMEI"
      | "INVALID_TRANSITION",
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}
