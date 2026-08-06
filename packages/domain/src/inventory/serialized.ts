import type { UnitState } from "./types.js";
import { LedgerError } from "./types.js";

/**
 * IMEI validation: 15 digits, Luhn check digit (GSMA TS.06). IMEISV (16 digits)
 * is accepted without a Luhn check, per spec.
 */
export function isValidImei(imei: string): boolean {
  if (/^\d{16}$/.test(imei)) return true; // IMEISV carries no check digit
  if (!/^\d{15}$/.test(imei)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = imei.charCodeAt(i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function assertValidImei(imei: string): void {
  if (!isValidImei(imei)) {
    throw new LedgerError("INVALID_IMEI", `'${imei}' is not a valid IMEI/IMEISV`);
  }
}

/**
 * Per-unit lifecycle. Mirrors the CHECK constraint on stock_unit.state and is
 * the only place transitions are defined — POS, API, and workers all consult
 * this map, so a phone can never take a path the ledger wouldn't record.
 */
export const UNIT_TRANSITIONS: Record<UnitState, readonly UnitState[]> = {
  inbound: ["in_stock", "damaged"],
  in_stock: ["reserved", "sold", "in_transit", "in_repair", "damaged"],
  reserved: ["sold", "in_stock"], // release goes back to stock
  sold: ["returned_pending"],
  returned_pending: ["in_stock", "in_repair", "damaged", "written_off"],
  in_transit: ["in_stock", "damaged"],
  in_repair: ["in_stock", "damaged"],
  damaged: ["in_repair", "written_off"],
  written_off: [], // terminal
};

export function canTransition(from: UnitState, to: UnitState): boolean {
  return UNIT_TRANSITIONS[from].includes(to);
}

export function assertTransition(unitId: string, from: UnitState, to: UnitState): void {
  if (!canTransition(from, to)) {
    throw new LedgerError(
      "INVALID_TRANSITION",
      `unit ${unitId}: illegal state transition ${from} -> ${to}`,
    );
  }
}

export interface SerializedUnit {
  id: string;
  variantId: string;
  imei1?: string;
  imei2?: string;
  serialNo?: string;
  state: UnitState;
  locationId?: string;
}

/**
 * In-memory uniqueness registry for serialized units. Server-side the partial
 * unique indexes in 003_inventory.sql are the authority; this class gives the
 * offline POS the same guarantee locally, and unit tests a fast harness.
 */
export class SerializedInventory {
  private readonly units = new Map<string, SerializedUnit>();
  private readonly imeiIndex = new Map<string, string>(); // imei -> unitId

  register(unit: SerializedUnit): SerializedUnit {
    if (this.units.has(unit.id)) {
      throw new LedgerError("SERIALIZED_RULE", `unit ${unit.id} already registered`);
    }
    for (const imei of [unit.imei1, unit.imei2]) {
      if (imei === undefined) continue;
      assertValidImei(imei);
      const holder = this.imeiIndex.get(imei);
      if (holder !== undefined) {
        throw new LedgerError("DUPLICATE_IMEI", `IMEI ${imei} already belongs to unit ${holder}`);
      }
    }
    if (unit.imei1 !== undefined && unit.imei1 === unit.imei2) {
      throw new LedgerError("SERIALIZED_RULE", "imei1 and imei2 must differ");
    }
    const stored = { ...unit };
    this.units.set(stored.id, stored);
    if (stored.imei1 !== undefined) this.imeiIndex.set(stored.imei1, stored.id);
    if (stored.imei2 !== undefined) this.imeiIndex.set(stored.imei2, stored.id);
    return stored;
  }

  transition(unitId: string, to: UnitState): SerializedUnit {
    const unit = this.units.get(unitId);
    if (!unit) {
      throw new LedgerError("SERIALIZED_RULE", `unknown unit ${unitId}`);
    }
    assertTransition(unitId, unit.state, to);
    unit.state = to;
    return unit;
  }

  byImei(imei: string): SerializedUnit | undefined {
    const id = this.imeiIndex.get(imei);
    return id === undefined ? undefined : this.units.get(id);
  }

  get(unitId: string): SerializedUnit | undefined {
    return this.units.get(unitId);
  }
}
