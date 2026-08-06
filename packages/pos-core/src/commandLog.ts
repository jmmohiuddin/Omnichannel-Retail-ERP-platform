/**
 * Offline command log for the POS (docs/02-architecture.md §6).
 *
 * Sales made while offline are written locally as append-only commands with
 * client-generated UUIDs, validated against a local mirror of the inventory
 * ledger BEFORE they are queued — the same invariants apply offline as online
 * (all stock math lives in @omniretail/domain; nothing is re-implemented here).
 *
 * This package is pure: no I/O, no framework imports. Persistence is abstracted
 * behind `CommandStore` so the Tauri shell can plug SQLite in later.
 */
import {
  InventoryLedger,
  LedgerError,
  canTransition,
  validateMovementShape,
  type MovementInput,
  type MovementType,
  type PostedMovement,
  type SerializedUnit,
  type UnitState,
} from "@omniretail/domain";

// ---------------------------------------------------------------------------
// Command model
// ---------------------------------------------------------------------------

export type PaymentMethod = "cash" | "card" | "mobile_wallet" | "store_credit";

export interface SaleLine {
  variantId: string;
  /** NUMERIC(14,3) semantics — must be exactly 1 for serialized lines. */
  qty: number;
  /** Money is always integer minor units (BIGINT server-side). */
  unitPriceMinor: number;
  /** Present for serialized (IMEI-tracked) items. */
  stockUnitId?: string;
  /** Alternative serialized identifier — resolved to stockUnitId at append. */
  imei?: string;
}

interface CommandBase {
  /** Client-generated UUID — the idempotency key for replay to the server. */
  id: string;
  deviceId: string;
  createdAt: Date;
  /** Local monotonic sequence, assigned by the CommandLog at append time. */
  seq: number;
}

export interface SaleCommand extends CommandBase {
  type: "sale";
  locationId: string;
  cashierUserId: string;
  lines: SaleLine[];
  paymentMethod: PaymentMethod;
  currencyCode: string;
}

export interface ReturnCommand extends CommandBase {
  type: "return";
  locationId: string;
  cashierUserId: string;
  lines: SaleLine[];
  paymentMethod: PaymentMethod;
  currencyCode: string;
  /** Ties the refund back to the original sale when known. */
  originalSaleCommandId?: string;
}

export interface CashSessionOpenCommand extends CommandBase {
  type: "cash_session_open";
  locationId: string;
  cashierUserId: string;
  openingFloatMinor: number;
  currencyCode: string;
}

export interface CashSessionCloseCommand extends CommandBase {
  type: "cash_session_close";
  locationId: string;
  cashierUserId: string;
  countedCashMinor: number;
  currencyCode: string;
}

export type PosCommand =
  | SaleCommand
  | ReturnCommand
  | CashSessionOpenCommand
  | CashSessionCloseCommand;

export type PosCommandType = PosCommand["type"];

type DistributedOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What callers hand to `CommandLog.append` — `seq` is assigned locally. */
export type PosCommandInput = DistributedOmit<PosCommand, "seq">;

// ---------------------------------------------------------------------------
// Storage abstraction (SQLite behind Tauri later; in-memory in tests)
// ---------------------------------------------------------------------------

export type CommandStatus = "pending" | "synced" | "rejected";

export interface StoredCommand {
  command: PosCommand;
  status: CommandStatus;
  rejectionReason?: string;
}

export interface CommandStore {
  append(command: PosCommand): Promise<void>;
  /** Pending commands in local `seq` order — the replay batch. */
  listPending(): Promise<PosCommand[]>;
  markSynced(commandId: string): Promise<void>;
  markRejected(commandId: string, reason: string): Promise<void>;
  /** Highest local seq ever appended (0 when empty) — survives restarts. */
  lastSeq(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Command -> ledger movements (shared with the sync push path and the server)
// ---------------------------------------------------------------------------

/**
 * Deterministic mapping from a POS command to the ledger movements it implies.
 * Movement ids derive from the command id, so optimistic local posts and the
 * server's authoritative posts collide on id — which is exactly what makes
 * replay idempotent end to end.
 */
export function commandToMovements(command: PosCommand): MovementInput[] {
  if (command.type !== "sale" && command.type !== "return") return [];
  return command.lines.map((line, index) => {
    const base = {
      id: `${command.id}:${index}`,
      variantId: line.variantId,
      quantity: line.qty,
      actorUserId: command.cashierUserId,
      deviceId: command.deviceId,
      reference: { type: "pos_command", id: command.id },
      occurredAt: command.createdAt,
    };
    const movement: MovementInput =
      command.type === "sale"
        ? {
            ...base,
            movementType: "sale",
            from: { locationId: command.locationId, state: "on_hand" },
          }
        : {
            ...base,
            movementType: "return_in",
            to: { locationId: command.locationId, state: "returned_pending" },
          };
    if (line.stockUnitId !== undefined) movement.stockUnitId = line.stockUnitId;
    return movement;
  });
}

// ---------------------------------------------------------------------------
// Local inventory mirror
// ---------------------------------------------------------------------------

/** Unit state implied by an authoritative movement touching that unit. */
const UNIT_STATE_BY_MOVEMENT: Partial<Record<MovementType, UnitState>> = {
  receipt: "in_stock",
  sale: "sold",
  return_in: "returned_pending",
  transfer_out: "in_transit",
  transfer_in: "in_stock",
  write_off: "written_off",
  repair_out: "damaged",
  repair_in: "in_stock",
};

/**
 * The POS device's local view of stock: authoritative server ledger history
 * (pulled by seq cursor) plus an optimistic overlay of still-pending offline
 * commands. Levels are always derived by replaying movements through the one
 * true `InventoryLedger` — never mutated directly.
 */
export class LocalInventoryMirror {
  private serverHistory: PostedMovement[] = [];
  private readonly serverMovementIds = new Set<string>();
  /** commandId -> optimistic movements, in append order. */
  private readonly optimistic = new Map<string, MovementInput[]>();
  private readonly unitSeeds = new Map<string, SerializedUnit>();
  private readonly unitStates = new Map<string, UnitState>();
  private readonly imeiIndex = new Map<string, string>();
  /**
   * allowNegative: authoritative history was already validated at original
   * post time (InventoryLedger.replay semantics). Offline sufficiency is
   * enforced by CommandLog before anything reaches this ledger.
   */
  private ledger = new InventoryLedger({ allowNegative: true });

  /** Hydrate a serialized unit known to this store (catalog/stock snapshot). */
  registerUnit(seed: SerializedUnit): void {
    if (this.unitSeeds.has(seed.id)) {
      throw new LedgerError("SERIALIZED_RULE", `unit ${seed.id} already registered in mirror`);
    }
    for (const imei of [seed.imei1, seed.imei2]) {
      if (imei === undefined) continue;
      const holder = this.imeiIndex.get(imei);
      if (holder !== undefined) {
        throw new LedgerError("DUPLICATE_IMEI", `IMEI ${imei} already belongs to unit ${holder}`);
      }
    }
    const stored = { ...seed };
    this.unitSeeds.set(stored.id, stored);
    this.unitStates.set(stored.id, stored.state);
    if (stored.imei1 !== undefined) this.imeiIndex.set(stored.imei1, stored.id);
    if (stored.imei2 !== undefined) this.imeiIndex.set(stored.imei2, stored.id);
  }

  unit(unitId: string): SerializedUnit | undefined {
    const seed = this.unitSeeds.get(unitId);
    if (!seed) return undefined;
    return { ...seed, state: this.unitStates.get(unitId) ?? seed.state };
  }

  unitByImei(imei: string): SerializedUnit | undefined {
    const id = this.imeiIndex.get(imei);
    return id === undefined ? undefined : this.unit(id);
  }

  availability(variantId: string, locationId: string) {
    return this.ledger.availability(variantId, locationId);
  }

  level(variantId: string, locationId: string, state: Parameters<InventoryLedger["level"]>[2]) {
    return this.ledger.level(variantId, locationId, state);
  }

  hasCommand(commandId: string): boolean {
    return this.optimistic.has(commandId);
  }

  /** Post a pending command's movements on top of the authoritative history. */
  applyOptimistic(commandId: string, movements: MovementInput[]): void {
    if (this.optimistic.has(commandId)) {
      throw new LedgerError("DUPLICATE_MOVEMENT", `command ${commandId} already applied to mirror`);
    }
    for (const m of movements) {
      this.ledger.post(m);
      this.applyUnitState(m);
    }
    this.optimistic.set(commandId, movements);
  }

  /**
   * Ingest authoritative movements from the sync pull feed (deduped by id).
   * Call `rebuild()` afterwards to fold them into the derived levels.
   */
  applyServerMovements(items: readonly PostedMovement[]): number {
    let added = 0;
    for (const item of items) {
      if (this.serverMovementIds.has(item.id)) continue;
      this.serverHistory.push(item);
      this.serverMovementIds.add(item.id);
      added++;
    }
    return added;
  }

  /**
   * Drop a command's optimistic overlay — after the server accepted it (its
   * authoritative movements arrive via pull) or rejected it (the sale never
   * happened as far as stock is concerned). Call `rebuild()` afterwards.
   */
  discardCommand(commandId: string): void {
    this.optimistic.delete(commandId);
  }

  /**
   * Re-derive levels: replay authoritative server history, then re-post the
   * optimistic overlay for still-pending commands. Replaying the same history
   * always yields identical levels, so this self-corrects the mirror after a
   * conflict (e.g. another register sold the last unit first).
   */
  rebuild(): void {
    this.serverHistory.sort((a, b) => a.seq - b.seq);
    this.ledger = InventoryLedger.replay(this.serverHistory);
    for (const [id, seed] of this.unitSeeds) this.unitStates.set(id, seed.state);
    for (const m of this.serverHistory) this.applyUnitState(m);
    for (const movements of this.optimistic.values()) {
      for (const m of movements) {
        if (this.serverMovementIds.has(m.id)) continue; // already authoritative
        this.ledger.post(m);
        this.applyUnitState(m);
      }
    }
  }

  private applyUnitState(m: MovementInput): void {
    if (m.stockUnitId === undefined) return;
    const next = UNIT_STATE_BY_MOVEMENT[m.movementType];
    if (next !== undefined && this.unitSeeds.has(m.stockUnitId)) {
      this.unitStates.set(m.stockUnitId, next);
    }
  }
}

// ---------------------------------------------------------------------------
// Command log
// ---------------------------------------------------------------------------

/**
 * Append-only offline command log. `append` validates the command against the
 * local mirror (same domain invariants as the server), optimistically applies
 * it to the mirror, and queues it for replay. Invalid commands are rejected
 * up front and never queued — offline is not a way around the ledger rules.
 */
export class CommandLog {
  constructor(
    private readonly store: CommandStore,
    private readonly mirror: LocalInventoryMirror,
  ) {}

  async append(input: PosCommandInput): Promise<PosCommand> {
    if (this.mirror.hasCommand(input.id)) {
      throw new LedgerError("DUPLICATE_MOVEMENT", `command ${input.id} already queued`);
    }
    const seq = (await this.store.lastSeq()) + 1;
    const command = this.normalize(input, seq);
    const movements = commandToMovements(command);
    this.validate(command, movements);
    // Validation passed: decrement the local mirror first (so a second offline
    // sale of the same stock is caught), then durably queue the command.
    if (movements.length > 0) this.mirror.applyOptimistic(command.id, movements);
    await this.store.append(command);
    return command;
  }

  /** Resolve IMEI-only serialized lines to their stockUnitId and stamp seq. */
  private normalize(input: PosCommandInput, seq: number): PosCommand {
    if (input.type !== "sale" && input.type !== "return") {
      return { ...input, seq };
    }
    const lines = input.lines.map((line) => {
      if (line.stockUnitId !== undefined || line.imei === undefined) return { ...line };
      const unit = this.mirror.unitByImei(line.imei);
      if (!unit) {
        throw new LedgerError("SERIALIZED_RULE", `no local stock unit with IMEI ${line.imei}`);
      }
      return { ...line, stockUnitId: unit.id };
    });
    return { ...input, lines, seq };
  }

  private validate(command: PosCommand, movements: MovementInput[]): void {
    // Shape rules are the domain's, verbatim — same checks the server runs.
    for (const m of movements) validateMovementShape(m);
    if (command.type === "sale") this.validateSale(command);
    if (command.type === "return") this.validateReturn(command);
  }

  private validateSale(command: SaleCommand): void {
    // Serialized lines: the unit must exist locally and be sellable now.
    for (const line of command.lines) {
      if (line.unitPriceMinor < 0 || !Number.isInteger(line.unitPriceMinor)) {
        throw new LedgerError("INVALID_SHAPE", "unitPriceMinor must be a non-negative integer");
      }
      if (line.stockUnitId === undefined) continue;
      if (line.qty !== 1) {
        throw new LedgerError("SERIALIZED_RULE", "serialized sale lines must have qty 1");
      }
      const unit = this.mirror.unit(line.stockUnitId);
      if (!unit) {
        throw new LedgerError("SERIALIZED_RULE", `unknown stock unit ${line.stockUnitId}`);
      }
      if (unit.variantId !== line.variantId) {
        throw new LedgerError(
          "SERIALIZED_RULE",
          `stock unit ${unit.id} belongs to variant ${unit.variantId}, not ${line.variantId}`,
        );
      }
      if (!canTransition(unit.state, "sold")) {
        throw new LedgerError(
          "SERIALIZED_RULE",
          `stock unit ${unit.id} is '${unit.state}' and cannot be sold`,
        );
      }
    }
    // Quantity check across all lines of the command (a sale is atomic): the
    // mirror ledger runs allowNegative for authoritative replays, so local
    // sufficiency is enforced here, before anything is queued.
    const needed = new Map<string, number>();
    for (const line of command.lines) {
      needed.set(line.variantId, (needed.get(line.variantId) ?? 0) + line.qty);
    }
    for (const [variantId, qty] of needed) {
      const have = this.mirror.level(variantId, command.locationId, "on_hand");
      if (have < qty) {
        throw new LedgerError(
          "INSUFFICIENT_STOCK",
          `insufficient local stock for variant ${variantId} at ${command.locationId}: ` +
            `have ${have}, need ${qty}`,
        );
      }
    }
  }

  private validateReturn(command: ReturnCommand): void {
    for (const line of command.lines) {
      if (line.unitPriceMinor < 0 || !Number.isInteger(line.unitPriceMinor)) {
        throw new LedgerError("INVALID_SHAPE", "unitPriceMinor must be a non-negative integer");
      }
      if (line.stockUnitId === undefined) continue;
      if (line.qty !== 1) {
        throw new LedgerError("SERIALIZED_RULE", "serialized return lines must have qty 1");
      }
      // A unit sold elsewhere may be returned here, so an unknown unit is
      // allowed — the server validates it at replay. A locally-known unit
      // must be in a state that can actually come back.
      const unit = this.mirror.unit(line.stockUnitId);
      if (unit && !canTransition(unit.state, "returned_pending")) {
        throw new LedgerError(
          "SERIALIZED_RULE",
          `stock unit ${unit.id} is '${unit.state}' and cannot be returned`,
        );
      }
    }
  }
}
