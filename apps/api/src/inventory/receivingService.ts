import { randomUUID } from "node:crypto";
import { LedgerError, assertValidImei } from "@omniretail/domain";
import type { Db } from "../db.js";
import { PgInventoryService, translatePgError } from "./pgInventory.js";

export interface ReceiveUnitInput {
  imei1?: string;
  imei2?: string;
  serialNo?: string;
  unitCostMinor?: number;
}

export interface ReceiveLineInput {
  variantId: string;
  /** Non-serialized: required quantity. Serialized: derived from units.length. */
  quantity?: number;
  units?: ReceiveUnitInput[];
}

export interface ReceiveResult {
  grnId: string;
  unitIds: string[];
  movementCount: number;
}

/**
 * Goods receiving. Serialized variants (phones) create one stock_unit row and
 * one quantity-1 ledger movement per physical unit — the unit's IMEI is bound
 * to the ledger from the moment it enters stock. Duplicate IMEIs are rejected
 * by the database's partial unique indexes; nothing about uniqueness is
 * trust-based.
 */
export class ReceivingService {
  constructor(
    private readonly db: Db,
    private readonly inventory: PgInventoryService,
  ) {}

  async receive(
    tenantId: string,
    actorUserId: string,
    input: { locationId: string; deviceId?: string; reference?: string; lines: ReceiveLineInput[] },
  ): Promise<ReceiveResult> {
    if (input.lines.length === 0) {
      throw new LedgerError("INVALID_SHAPE", "receiving requires at least one line");
    }
    const grnId = randomUUID();
    const unitIds: string[] = [];
    let movementCount = 0;

    try {
      await this.db.withTenant(tenantId, async (c) => {
        for (const line of input.lines) {
          const { rows } = await c.query<{ tracking: string }>(
            `SELECT p.tracking FROM variant v JOIN product p ON p.id = v.product_id
              WHERE v.id = $1`,
            [line.variantId],
          );
          if (!rows[0]) {
            throw new LedgerError("INVALID_SHAPE", `variant ${line.variantId} not found`);
          }
          const serialized = rows[0].tracking === "serialized";

          if (serialized) {
            if (!line.units?.length) {
              throw new LedgerError(
                "SERIALIZED_RULE",
                "serialized variants are received as explicit units (scan each IMEI)",
              );
            }
            for (const unit of line.units) {
              if (unit.imei1) assertValidImei(unit.imei1);
              if (unit.imei2) assertValidImei(unit.imei2);
              if (!unit.imei1 && !unit.serialNo) {
                throw new LedgerError("SERIALIZED_RULE", "each unit needs an IMEI or serial number");
              }
              const unitId = randomUUID();
              await c.query(
                `INSERT INTO stock_unit
                   (id, tenant_id, variant_id, serial_no, imei1, imei2, state,
                    location_id, unit_cost_minor)
                 VALUES ($1,$2,$3,$4,$5,$6,'in_stock',$7,$8)`,
                [unitId, tenantId, line.variantId, unit.serialNo ?? null,
                 unit.imei1 ?? null, unit.imei2 ?? null, input.locationId,
                 unit.unitCostMinor ?? null],
              );
              await this.inventory.postMovementWith(c, tenantId, {
                id: randomUUID(),
                movementType: "receipt",
                variantId: line.variantId,
                stockUnitId: unitId,
                quantity: 1,
                to: { locationId: input.locationId, state: "on_hand" },
                actorUserId,
                ...(input.deviceId ? { deviceId: input.deviceId } : {}),
                reference: { type: "grn", id: grnId },
                occurredAt: new Date(),
                ...(input.reference ? { note: input.reference } : {}),
              });
              unitIds.push(unitId);
              movementCount++;
            }
          } else {
            if (!line.quantity || line.quantity <= 0) {
              throw new LedgerError("INVALID_SHAPE", "quantity required for non-serialized lines");
            }
            await this.inventory.postMovementWith(c, tenantId, {
              id: randomUUID(),
              movementType: "receipt",
              variantId: line.variantId,
              quantity: line.quantity,
              to: { locationId: input.locationId, state: "on_hand" },
              actorUserId,
              ...(input.deviceId ? { deviceId: input.deviceId } : {}),
              reference: { type: "grn", id: grnId },
              occurredAt: new Date(),
              ...(input.reference ? { note: input.reference } : {}),
            });
            movementCount++;
          }
        }
      });
    } catch (err) {
      throw translatePgError(err);
    }
    return { grnId, unitIds, movementCount };
  }

  /** POS scan path: resolve a unit by IMEI (either slot) or serial number. */
  async findUnit(
    tenantId: string,
    query: { imei?: string; serialNo?: string },
  ): Promise<Record<string, unknown> | undefined> {
    if (!query.imei && !query.serialNo) return undefined;
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query(
        `SELECT su.id, su.variant_id AS "variantId", su.imei1, su.imei2,
                su.serial_no AS "serialNo", su.state, su.location_id AS "locationId",
                v.sku, v.price_minor AS "priceMinor", v.currency, p.name AS "productName"
           FROM stock_unit su
           JOIN variant v ON v.id = su.variant_id
           JOIN product p ON p.id = v.product_id
          WHERE ($1::text IS NOT NULL AND (su.imei1 = $1 OR su.imei2 = $1))
             OR ($2::text IS NOT NULL AND su.serial_no = $2)
          LIMIT 1`,
        [query.imei ?? null, query.serialNo ?? null],
      );
      return rows[0];
    });
  }
}
