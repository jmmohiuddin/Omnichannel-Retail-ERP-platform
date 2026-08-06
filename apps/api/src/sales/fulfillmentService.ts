import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { PgInventoryService, translatePgError } from "../inventory/pgInventory.js";

export class FulfillmentError extends Error {
  constructor(
    readonly code:
      | "ORDER_NOT_FOUND"
      | "BAD_STATE"
      | "UNIT_REQUIRED"
      | "UNIT_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "FulfillmentError";
  }
}

/**
 * Converts a reserved order into shipped/collected goods, or releases it.
 * Fulfillment consumes the reservation bucket (reserved → sale); cancellation
 * returns it (reserved → on_hand). Serialized lines have their exact units
 * assigned at fulfillment time — web customers order a model, pickers scan the
 * specific phone that leaves the shelf.
 */
export class FulfillmentService {
  constructor(
    private readonly db: Db,
    private readonly inventory: PgInventoryService,
  ) {}

  async fulfill(
    tenantId: string,
    actorUserId: string,
    orderId: string,
    input: { units?: { variantId: string; stockUnitId: string }[] } = {},
  ): Promise<{ status: string }> {
    try {
      return await this.db.withTenant(tenantId, async (c) => {
        const order = await c.query<{ status: string; location_id: string }>(
          "SELECT status, location_id FROM sales_order WHERE id = $1 FOR UPDATE",
          [orderId],
        );
        const head = order.rows[0];
        if (!head) throw new FulfillmentError("ORDER_NOT_FOUND", "order not found");
        if (!["pending", "confirmed"].includes(head.status)) {
          throw new FulfillmentError("BAD_STATE", `order is ${head.status}`);
        }

        const { rows: lines } = await c.query<{
          id: string; variant_id: string; quantity: string; stock_unit_id: string | null;
          tracking: string;
        }>(
          `SELECT l.id, l.variant_id, l.quantity, l.stock_unit_id, p.tracking
             FROM sales_order_line l
             JOIN variant v ON v.id = l.variant_id
             JOIN product p ON p.id = v.product_id
            WHERE l.order_id = $1`,
          [orderId],
        );

        const unitByVariant = new Map<string, string[]>();
        for (const u of input.units ?? []) {
          const list = unitByVariant.get(u.variantId) ?? [];
          list.push(u.stockUnitId);
          unitByVariant.set(u.variantId, list);
        }

        for (const line of lines) {
          let unitId = line.stock_unit_id ?? undefined;
          if (line.tracking === "serialized" && !unitId) {
            unitId = (unitByVariant.get(line.variant_id) ?? []).shift();
            if (!unitId) {
              throw new FulfillmentError(
                "UNIT_REQUIRED",
                `serialized line requires a scanned unit for variant ${line.variant_id}`,
              );
            }
            const unit = await c.query<{ state: string; variant_id: string; location_id: string }>(
              "SELECT state, variant_id, location_id FROM stock_unit WHERE id = $1 FOR UPDATE",
              [unitId],
            );
            const u = unit.rows[0];
            if (!u || u.variant_id !== line.variant_id || u.state !== "in_stock" ||
                u.location_id !== head.location_id) {
              throw new FulfillmentError("UNIT_UNAVAILABLE", "scanned unit is not available here");
            }
            await c.query(
              `UPDATE stock_unit SET state = 'sold', sold_order_id = $2, updated_at = now()
                WHERE id = $1`,
              [unitId, orderId],
            );
            await c.query(
              "UPDATE sales_order_line SET stock_unit_id = $2 WHERE id = $1",
              [line.id, unitId],
            );
          }

          await this.inventory.postMovementWith(c, tenantId, {
            id: randomUUID(),
            movementType: "sale",
            variantId: line.variant_id,
            ...(unitId ? { stockUnitId: unitId } : {}),
            quantity: Number(line.quantity),
            from: { locationId: head.location_id, state: "reserved" },
            actorUserId,
            reference: { type: "order", id: orderId },
            occurredAt: new Date(),
          });
        }

        await c.query(
          `UPDATE stock_reservation SET status = 'consumed'
            WHERE reference_type = 'order' AND reference_id = $1 AND status = 'active'`,
          [orderId],
        );
        await c.query(
          `UPDATE sales_order SET status = 'fulfilled', completed_at = now() WHERE id = $1`,
          [orderId],
        );
        await c.query(
          `INSERT INTO outbox (id, tenant_id, aggregate, event_type, payload)
           VALUES ($1,$2,$3,'order.fulfilled',$4)`,
          [randomUUID(), tenantId, `order:${orderId}`, JSON.stringify({ orderId })],
        );
        return { status: "fulfilled" };
      });
    } catch (err) {
      throw translatePgError(err);
    }
  }

  async cancel(
    tenantId: string,
    actorUserId: string,
    orderId: string,
    reason: string,
  ): Promise<{ status: string }> {
    try {
      return await this.db.withTenant(tenantId, async (c) => {
        const order = await c.query<{ status: string; location_id: string }>(
          "SELECT status, location_id FROM sales_order WHERE id = $1 FOR UPDATE",
          [orderId],
        );
        const head = order.rows[0];
        if (!head) throw new FulfillmentError("ORDER_NOT_FOUND", "order not found");
        if (!["pending", "confirmed"].includes(head.status)) {
          throw new FulfillmentError("BAD_STATE", `order is ${head.status}`);
        }

        const { rows: lines } = await c.query<{ variant_id: string; quantity: string }>(
          "SELECT variant_id, quantity FROM sales_order_line WHERE order_id = $1",
          [orderId],
        );
        for (const line of lines) {
          await this.inventory.postMovementWith(c, tenantId, {
            id: randomUUID(),
            movementType: "release",
            variantId: line.variant_id,
            quantity: Number(line.quantity),
            from: { locationId: head.location_id, state: "reserved" },
            to: { locationId: head.location_id, state: "on_hand" },
            actorUserId,
            reference: { type: "order", id: orderId },
            occurredAt: new Date(),
            note: `cancelled: ${reason}`,
          });
        }
        await c.query(
          `UPDATE stock_reservation SET status = 'released'
            WHERE reference_type = 'order' AND reference_id = $1 AND status = 'active'`,
          [orderId],
        );
        await c.query(
          "UPDATE payment SET status = 'voided' WHERE order_id = $1 AND status = 'pending'",
          [orderId],
        );
        await c.query(
          "UPDATE sales_order SET status = 'cancelled' WHERE id = $1",
          [orderId],
        );
        await c.query(
          `INSERT INTO outbox (id, tenant_id, aggregate, event_type, payload)
           VALUES ($1,$2,$3,'order.cancelled',$4)`,
          [randomUUID(), tenantId, `order:${orderId}`, JSON.stringify({ orderId, reason })],
        );
        return { status: "cancelled" };
      });
    } catch (err) {
      throw translatePgError(err);
    }
  }
}
