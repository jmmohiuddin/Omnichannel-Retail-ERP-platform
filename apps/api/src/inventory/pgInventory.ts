import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  type Availability,
  LedgerError,
  type MovementInput,
  type StockState,
  validateMovementShape,
} from "@omniretail/domain";
import { type Db, isPgError } from "../db.js";

export interface PostedMovementRow extends MovementInput {
  seq: number;
}

export interface MovementFeed {
  items: PostedMovementRow[];
  nextCursor: number;
}

/**
 * PostgreSQL-backed inventory service (ADR-002 wiring).
 *
 * postMovement is ONE transaction: ledger insert + stock_level upsert + outbox
 * event. The database is a second line of enforcement behind the domain rules:
 * negative stock (CHECK), duplicate movement id (PK), missing approval
 * (trigger), immutability (trigger) all hold even against buggy app code.
 */
export class PgInventoryService {
  constructor(private readonly db: Db) {}

  async postMovement(tenantId: string, input: MovementInput): Promise<PostedMovementRow> {
    validateMovementShape(input); // fail fast with precise domain errors

    try {
      return await this.db.withTenant(tenantId, async (c) => {
        const { rows } = await c.query<{ seq: string }>(
          `INSERT INTO stock_movement
             (id, tenant_id, occurred_at, movement_type, variant_id, stock_unit_id,
              quantity, from_location_id, from_state, to_location_id, to_state,
              actor_user_id, device_id, reference_type, reference_id, approval_id, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           RETURNING seq`,
          [
            input.id, tenantId, input.occurredAt, input.movementType, input.variantId,
            input.stockUnitId ?? null, input.quantity,
            input.from?.locationId ?? null, input.from?.state ?? null,
            input.to?.locationId ?? null, input.to?.state ?? null,
            input.actorUserId, input.deviceId ?? null,
            input.reference.type, input.reference.id,
            input.approvalId ?? null, input.note ?? null,
          ],
        );
        const seq = Number(rows[0]!.seq);

        const applyDelta = async (locationId: string, state: StockState, delta: number) => {
          await c.query(
            `INSERT INTO stock_level (tenant_id, location_id, variant_id, state, quantity, updated_seq)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (tenant_id, location_id, variant_id, state)
             DO UPDATE SET quantity   = stock_level.quantity + EXCLUDED.quantity,
                           updated_seq = EXCLUDED.updated_seq,
                           updated_at  = now()`,
            [tenantId, locationId, input.variantId, state, delta, seq],
          );
        };
        if (input.from) await applyDelta(input.from.locationId, input.from.state, -input.quantity);
        if (input.to) await applyDelta(input.to.locationId, input.to.state, input.quantity);

        await c.query(
          `INSERT INTO outbox (id, tenant_id, aggregate, event_type, payload)
           VALUES ($1,$2,$3,'inventory.level.changed',$4)`,
          [
            randomUUID(), tenantId, `inventory:variant:${input.variantId}`,
            JSON.stringify({
              movementId: input.id, seq, movementType: input.movementType,
              variantId: input.variantId, quantity: input.quantity,
              from: input.from ?? null, to: input.to ?? null,
            }),
          ],
        );
        return { ...input, seq };
      });
    } catch (err) {
      throw translatePgError(err);
    }
  }

  async availability(tenantId: string, variantId: string, locationId: string): Promise<Availability> {
    const rows = await this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ state: StockState; quantity: string }>(
        `SELECT state, quantity FROM stock_level
          WHERE variant_id = $1 AND location_id = $2`,
        [variantId, locationId],
      );
      return rows;
    });
    const q = (state: StockState) => Number(rows.find((r) => r.state === state)?.quantity ?? 0);
    const onHand = q("on_hand");
    return {
      onHand,
      reserved: q("reserved"),
      available: onHand,
      inTransit: q("in_transit"),
      damaged: q("damaged"),
      returnedPending: q("returned_pending"),
    };
  }

  async feed(tenantId: string, afterSeq: number, limit: number): Promise<MovementFeed> {
    const rows = await this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, seq, occurred_at, movement_type, variant_id, stock_unit_id, quantity,
                from_location_id, from_state, to_location_id, to_state,
                actor_user_id, device_id, reference_type, reference_id, approval_id, note
           FROM stock_movement
          WHERE seq > $1
          ORDER BY seq
          LIMIT $2`,
        [afterSeq, limit],
      );
      return rows;
    });
    const items: PostedMovementRow[] = rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      seq: Number(r.seq),
      occurredAt: r.occurred_at as Date,
      movementType: r.movement_type as MovementInput["movementType"],
      variantId: r.variant_id as string,
      ...(r.stock_unit_id ? { stockUnitId: r.stock_unit_id as string } : {}),
      quantity: Number(r.quantity),
      ...(r.from_location_id
        ? { from: { locationId: r.from_location_id as string, state: r.from_state as StockState } }
        : {}),
      ...(r.to_location_id
        ? { to: { locationId: r.to_location_id as string, state: r.to_state as StockState } }
        : {}),
      actorUserId: r.actor_user_id as string,
      ...(r.device_id ? { deviceId: r.device_id as string } : {}),
      reference: { type: r.reference_type as string, id: r.reference_id as string },
      ...(r.approval_id ? { approvalId: r.approval_id as string } : {}),
      ...(r.note ? { note: r.note as string } : {}),
    }));
    return { items, nextCursor: items.at(-1)?.seq ?? afterSeq };
  }
}

/** Map database enforcement failures onto the same LedgerError codes the domain uses. */
function translatePgError(err: unknown): unknown {
  if (!isPgError(err)) return err;
  if (err.code === "23505") {
    if (err.constraint === "stock_movement_pkey") {
      return new LedgerError("DUPLICATE_MOVEMENT", "movement already posted");
    }
    if (err.constraint?.includes("imei")) {
      return new LedgerError("DUPLICATE_IMEI", "IMEI already registered");
    }
  }
  if (err.code === "23514" && err.constraint?.includes("stock_level")) {
    return new LedgerError("INSUFFICIENT_STOCK", "insufficient stock for movement");
  }
  if (err.code === "P0001" && /approval/i.test(err.message)) {
    return new LedgerError("APPROVAL_REQUIRED", err.message);
  }
  return err;
}
