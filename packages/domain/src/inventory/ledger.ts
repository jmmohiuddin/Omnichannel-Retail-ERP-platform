import type {
  Availability,
  BucketRef,
  MovementInput,
  PostedMovement,
  StockState,
} from "./types.js";
import { LedgerError } from "./types.js";
import { validateMovementShape } from "./rules.js";

/** Quantities are stored to 3 decimal places (matches NUMERIC(14,3) in the DB). */
const QTY_SCALE = 1000;
const round3 = (n: number): number => Math.round(n * QTY_SCALE) / QTY_SCALE;

const bucketKey = (variantId: string, b: BucketRef): string =>
  `${variantId}|${b.locationId}|${b.state}`;

export interface LedgerOptions {
  /**
   * When false (default) a movement that would drive a bucket negative is
   * rejected with INSUFFICIENT_STOCK. Channels explicitly configured to allow
   * oversell handle that upstream via backorders — the ledger itself never
   * goes negative.
   */
  allowNegative?: boolean;
}

/**
 * The inventory ledger: append-only movements, derived levels.
 *
 * This is the single implementation of stock math for the whole platform.
 * Server-side it is fed movements inside a DB transaction; POS-side it runs
 * against the local mirror to validate offline sales before they are queued.
 */
export class InventoryLedger {
  private readonly levels = new Map<string, number>();
  private readonly movements: PostedMovement[] = [];
  private readonly seenIds = new Set<string>();
  private seq = 0;
  private readonly allowNegative: boolean;

  constructor(opts: LedgerOptions = {}) {
    this.allowNegative = opts.allowNegative ?? false;
  }

  /**
   * Validate and apply a movement atomically. Throws LedgerError and leaves
   * state untouched on any violation. Duplicate ids are rejected, which is
   * what makes offline replay idempotent.
   */
  post(input: MovementInput): PostedMovement {
    if (this.seenIds.has(input.id)) {
      throw new LedgerError("DUPLICATE_MOVEMENT", `movement ${input.id} already posted`);
    }
    validateMovementShape(input);

    const qty = round3(input.quantity);

    // Check the debit side before touching anything.
    if (input.from && !this.allowNegative) {
      const key = bucketKey(input.variantId, input.from);
      const current = this.levels.get(key) ?? 0;
      if (round3(current - qty) < 0) {
        throw new LedgerError(
          "INSUFFICIENT_STOCK",
          `insufficient ${input.from.state} stock for variant ${input.variantId} ` +
            `at ${input.from.locationId}: have ${current}, need ${qty}`,
        );
      }
    }

    if (input.from) {
      const key = bucketKey(input.variantId, input.from);
      this.levels.set(key, round3((this.levels.get(key) ?? 0) - qty));
    }
    if (input.to) {
      const key = bucketKey(input.variantId, input.to);
      this.levels.set(key, round3((this.levels.get(key) ?? 0) + qty));
    }

    const posted: PostedMovement = { ...input, quantity: qty, seq: ++this.seq };
    this.movements.push(posted);
    this.seenIds.add(input.id);
    return posted;
  }

  level(variantId: string, locationId: string, state: StockState): number {
    return this.levels.get(bucketKey(variantId, { locationId, state })) ?? 0;
  }

  availability(variantId: string, locationId: string): Availability {
    const get = (state: StockState) => this.level(variantId, locationId, state);
    const onHand = get("on_hand");
    const reserved = get("reserved");
    return {
      onHand,
      reserved,
      available: round3(onHand), // reserved stock already left the on_hand bucket
      inTransit: get("in_transit"),
      damaged: get("damaged"),
      returnedPending: get("returned_pending"),
    };
  }

  /** Total physically-present stock at a location (any sellable-adjacent state). */
  physicalOnSite(variantId: string, locationId: string): number {
    return round3(
      this.level(variantId, locationId, "on_hand") +
        this.level(variantId, locationId, "reserved") +
        this.level(variantId, locationId, "damaged") +
        this.level(variantId, locationId, "returned_pending"),
    );
  }

  get history(): readonly PostedMovement[] {
    return this.movements;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /**
   * Rebuild a ledger from persisted movements. Used by the drift-check job to
   * verify the materialized stock_level table, and by the POS to hydrate its
   * local mirror. Replaying the same history always yields identical levels.
   */
  static replay(history: readonly MovementInput[], opts: LedgerOptions = {}): InventoryLedger {
    // Replay trusts history ordering; negative checks were done at original post.
    const ledger = new InventoryLedger({ ...opts, allowNegative: true });
    for (const m of history) ledger.post(m);
    return ledger;
  }
}
