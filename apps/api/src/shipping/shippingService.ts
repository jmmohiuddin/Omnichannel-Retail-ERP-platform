import { randomUUID } from "node:crypto";
import { isPgError, type Db } from "../db.js";
import type { CourierPort, ShipmentStatus, TrackingEvent } from "./courierPort.js";

export class ShippingError extends Error {
  constructor(
    readonly code:
      | "ORDER_NOT_FOUND"
      | "BAD_STATE"
      | "ALREADY_SHIPPED"
      | "SHIPMENT_NOT_FOUND"
      | "UNKNOWN_COURIER",
    message: string,
  ) {
    super(message);
    this.name = "ShippingError";
  }
}

export interface ShipmentEventView {
  status: string;
  description: string | null;
  occurredAt: string; // ISO timestamp
}

export interface ShipmentView {
  shipmentId: string;
  orderId: string;
  courier: string;
  trackingNo: string;
  labelUrl: string | null;
  status: ShipmentStatus;
  address: Record<string, unknown>;
  codAmountMinor: number;
  createdAt: string;
  events: ShipmentEventView[];
}

/**
 * Hands fulfilled orders to a courier and mirrors its tracking feed.
 *
 * Couriers sit behind CourierPort (courierPort.ts): the service resolves the
 * requested key against a registry map, so real UAE couriers — Aramex, SMSA,
 * Quiqup, Careem Box — plug in later as adapters without service changes.
 * v1 registers MockCourier only.
 *
 * Shipping never moves stock: the inventory ledger was settled when the order
 * reached 'fulfilled' (goods picked/packed — see fulfillmentService.ts).
 * Delivery is what completes the order ('fulfilled' → 'completed').
 */
export class ShippingService {
  constructor(
    private readonly db: Db,
    private readonly couriers: Map<string, CourierPort>,
  ) {}

  private courierFor(key: string): CourierPort {
    const courier = this.couriers.get(key);
    if (!courier) throw new ShippingError("UNKNOWN_COURIER", `no courier registered as '${key}'`);
    return courier;
  }

  async createShipment(
    tenantId: string,
    userId: string,
    orderId: string,
    input: { courier: string; address: Record<string, unknown>; codAmountMinor?: number },
  ): Promise<{ shipmentId: string; trackingNo: string; labelUrl: string | null; status: ShipmentStatus }> {
    const courier = this.courierFor(input.courier);
    const codAmountMinor = input.codAmountMinor ?? 0;
    try {
      return await this.db.withTenant(tenantId, async (c) => {
        const order = await c.query<{ status: string; order_no: string }>(
          "SELECT status, order_no FROM sales_order WHERE id = $1 FOR UPDATE",
          [orderId],
        );
        const head = order.rows[0];
        if (!head) throw new ShippingError("ORDER_NOT_FOUND", "order not found");
        if (head.status !== "fulfilled") {
          // Goods must be picked/packed (ledger settled) before courier hand-off.
          throw new ShippingError("BAD_STATE", `order is ${head.status}, expected fulfilled`);
        }
        const existing = await c.query("SELECT 1 FROM shipment WHERE order_id = $1", [orderId]);
        if (existing.rows[0]) {
          throw new ShippingError("ALREADY_SHIPPED", "order already has a shipment (v1: one per order)");
        }

        const { rows: lines } = await c.query<{ description: string }>(
          "SELECT description FROM sales_order_line WHERE order_id = $1",
          [orderId],
        );

        // Mock courier answers instantly; real adapters should be called
        // outside the transaction (or given a short timeout) so a slow courier
        // API cannot pin a database connection.
        const booked = await courier.createShipment({
          orderId,
          orderNo: head.order_no,
          address: input.address,
          codAmountMinor,
          parcels: lines.map((l) => ({ description: l.description })),
        });

        const shipmentId = randomUUID();
        await c.query(
          `INSERT INTO shipment
             (id, tenant_id, order_id, courier, tracking_no, label_url, status,
              address, cod_amount_minor, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,'created',$7,$8,$9)`,
          [shipmentId, tenantId, orderId, input.courier, booked.trackingNo,
           booked.labelUrl ?? null, JSON.stringify(input.address), codAmountMinor, userId],
        );
        await c.query(
          `INSERT INTO shipment_event (id, tenant_id, shipment_id, status, description)
           VALUES ($1,$2,$3,'created',$4)`,
          [randomUUID(), tenantId, shipmentId,
           `shipment created with ${input.courier} (${booked.trackingNo})`],
        );
        await c.query(
          `INSERT INTO outbox (id, tenant_id, aggregate, event_type, payload)
           VALUES ($1,$2,$3,'shipment.created',$4)`,
          [randomUUID(), tenantId, `shipment:${shipmentId}`,
           JSON.stringify({ shipmentId, orderId, courier: input.courier,
                            trackingNo: booked.trackingNo, codAmountMinor })],
        );
        return {
          shipmentId,
          trackingNo: booked.trackingNo,
          labelUrl: booked.labelUrl ?? null,
          status: "created",
        };
      });
    } catch (err) {
      // Belt and braces: two concurrent creates both pass the pre-check; the
      // loser hits the (tenant_id, order_id) unique constraint.
      if (isPgError(err) && err.code === "23505") {
        throw new ShippingError("ALREADY_SHIPPED", "order already has a shipment (v1: one per order)");
      }
      throw err;
    }
  }

  /**
   * Polls the courier and mirrors its feed: appends events not seen before
   * (dedupe key: status + occurred_at — courier feeds re-send history) and
   * moves shipment.status forward. Delivery completes the order.
   */
  async refreshTracking(
    tenantId: string,
    shipmentId: string,
  ): Promise<{ shipmentId: string; status: ShipmentStatus; appendedEvents: number }> {
    return this.db.withTenant(tenantId, async (c) => {
      const found = await c.query<{
        order_id: string; courier: string; tracking_no: string; status: ShipmentStatus;
      }>(
        "SELECT order_id, courier, tracking_no, status FROM shipment WHERE id = $1 FOR UPDATE",
        [shipmentId],
      );
      const shipment = found.rows[0];
      if (!shipment) throw new ShippingError("SHIPMENT_NOT_FOUND", "shipment not found");
      const courier = this.courierFor(shipment.courier);

      const tracking = await courier.track(shipment.tracking_no);

      const { rows: existing } = await c.query<{ status: string; occurred_at: Date }>(
        "SELECT status, occurred_at FROM shipment_event WHERE shipment_id = $1",
        [shipmentId],
      );
      const seen = new Set(existing.map((e) => `${e.status}|${e.occurred_at.toISOString()}`));

      let appended = 0;
      for (const event of tracking.events as TrackingEvent[]) {
        const key = `${event.status}|${new Date(event.occurredAtIso).toISOString()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await c.query(
          `INSERT INTO shipment_event
             (id, tenant_id, shipment_id, status, description, occurred_at, raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(), tenantId, shipmentId, event.status, event.description,
           event.occurredAtIso, JSON.stringify(event)],
        );
        appended++;
      }

      if (tracking.status !== shipment.status) {
        await c.query(
          "UPDATE shipment SET status = $2, updated_at = now() WHERE id = $1",
          [shipmentId, tracking.status],
        );
        if (tracking.status === "delivered") {
          await c.query(
            `UPDATE sales_order SET status = 'completed', completed_at = now()
              WHERE id = $1 AND status = 'fulfilled'`,
            [shipment.order_id],
          );
          await c.query(
            `INSERT INTO outbox (id, tenant_id, aggregate, event_type, payload)
             VALUES ($1,$2,$3,'order.delivered',$4)`,
            [randomUUID(), tenantId, `order:${shipment.order_id}`,
             JSON.stringify({ orderId: shipment.order_id, shipmentId,
                              trackingNo: shipment.tracking_no })],
          );
        }
      }
      return { shipmentId, status: tracking.status, appendedEvents: appended };
    });
  }

  async getShipment(tenantId: string, shipmentId: string): Promise<ShipmentView> {
    return this.db.withTenant(tenantId, async (c) => {
      const found = await c.query<{
        id: string; order_id: string; courier: string; tracking_no: string;
        label_url: string | null; status: ShipmentStatus;
        address: Record<string, unknown>; cod_amount_minor: string; created_at: Date;
      }>(
        `SELECT id, order_id, courier, tracking_no, label_url, status, address,
                cod_amount_minor, created_at
           FROM shipment WHERE id = $1`,
        [shipmentId],
      );
      const s = found.rows[0];
      if (!s) throw new ShippingError("SHIPMENT_NOT_FOUND", "shipment not found");

      const { rows: events } = await c.query<{
        status: string; description: string | null; occurred_at: Date;
      }>(
        `SELECT status, description, occurred_at FROM shipment_event
          WHERE shipment_id = $1 ORDER BY occurred_at, status`,
        [shipmentId],
      );
      return {
        shipmentId: s.id,
        orderId: s.order_id,
        courier: s.courier,
        trackingNo: s.tracking_no,
        labelUrl: s.label_url,
        status: s.status,
        address: s.address,
        codAmountMinor: Number(s.cod_amount_minor),
        createdAt: s.created_at.toISOString(),
        events: events.map((e) => ({
          status: e.status,
          description: e.description,
          occurredAt: e.occurred_at.toISOString(),
        })),
      };
    });
  }
}
