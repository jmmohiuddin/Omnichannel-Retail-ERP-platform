import { randomUUID } from "node:crypto";
import { isPgError, type Db } from "../db.js";
import { PgInventoryService } from "../inventory/pgInventory.js";
import { NotificationService } from "../notify/notificationService.js";
import { CodService } from "../sales/codService.js";
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
    private readonly inventory: PgInventoryService = new PgInventoryService(db),
    private readonly notifications: NotificationService = new NotificationService(db),
    /** Same defaulting pattern: RTO feeds the COD reliability history (R9.5). */
    private readonly cod: CodService = new CodService(db),
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
    input: {
      courier: string;
      address: Record<string, unknown>;
      codAmountMinor?: number;
      /** What the courier charges to carry it out (R5.6). */
      outboundFreightMinor?: number;
      /** What a failed leg costs to bring back. Defaults to the outbound. */
      returnFreightMinor?: number;
    },
  ): Promise<{ shipmentId: string; trackingNo: string; labelUrl: string | null; status: ShipmentStatus }> {
    const courier = this.courierFor(input.courier);
    const codAmountMinor = input.codAmountMinor ?? 0;
    try {
      return await this.db.withTenant(tenantId, async (c) => {
        const order = await c.query<{ status: string; order_no: string; customer_id: string | null }>(
          "SELECT status, order_no, customer_id FROM sales_order WHERE id = $1 FOR UPDATE",
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
              address, cod_amount_minor, created_by,
              outbound_freight_minor, return_freight_minor)
           VALUES ($1,$2,$3,$4,$5,$6,'created',$7,$8,$9,$10,$11)`,
          [shipmentId, tenantId, orderId, input.courier, booked.trackingNo,
           booked.labelUrl ?? null, JSON.stringify(input.address), codAmountMinor, userId,
           // What the outbound leg costs. Captured at booking because that is
           // when the courier quotes it; the return leg (R5.6) is only known
           // if the delivery fails, and defaults to the same figure — a round
           // trip is what a refusal actually costs.
           input.outboundFreightMinor ?? 0,
           input.returnFreightMinor ?? input.outboundFreightMinor ?? 0],
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

        // R5.3 + R13.3: the customer learns the tracking number here, in the
        // same transaction that books the shipment. This is the dispatch
        // moment — the courier has accepted the parcel and issued a tracking
        // number, and the order was already 'fulfilled' (picked and packed)
        // before we got this far.
        if (head.customer_id) {
          const { rows: recipient } = await c.query<{ full_name: string; email: string | null }>(
            "SELECT full_name, email FROM customer WHERE id = $1",
            [head.customer_id],
          );
          const customer = recipient[0];
          if (customer?.email) {
            const { rows: tenantRows } = await c.query<{ name: string }>(
              "SELECT name FROM tenant WHERE id = $1",
              [tenantId],
            );
            await this.notifications.enqueueWith(c, tenantId, {
              request: {
                template: "dispatch_tracking",
                payload: {
                  tenantName: tenantRows[0]?.name ?? "",
                  customerName: customer.full_name,
                  orderNo: head.order_no,
                  courier: input.courier,
                  trackingNo: booked.trackingNo,
                },
              },
              dedupeKey: `dispatch_tracking:${shipmentId}`,
              recipient: customer.email,
              customerId: head.customer_id,
              orderId,
            });
          }
        }

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
        created_by: string;
      }>(
        `SELECT order_id, courier, tracking_no, status, created_by
           FROM shipment WHERE id = $1 FOR UPDATE`,
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

        // RTO: the goods physically came back. Fulfilment posted a `sale`
        // movement out of the ledger and marked any serialized unit `sold`;
        // without reversing both, returned stock simply vanished — and in a
        // market that is ~71% cash on delivery, every refused delivery lost
        // its stock permanently.
        //
        // Only `returned` triggers this. `failed` is a failed *attempt*, which
        // the courier may retry; the goods are still out with them.
        if (tracking.status === "returned") {
          await this.restockReturnToOrigin(
            c, tenantId, shipment.order_id, shipmentId, shipment.created_by,
          );
        }
      }
      return { shipmentId, status: tracking.status, appendedEvents: appended };
    });
  }

  /**
   * Bring an RTO shipment's goods back into the ledger.
   *
   * Serialized units go to `returned_pending`, not straight to sellable: a unit
   * that has been out on a van and refused is inspected before it is offered
   * again. That mirrors the counter-return path and is why the domain has no
   * `sold -> in_stock` transition.
   */
  private async restockReturnToOrigin(
    c: import("pg").PoolClient,
    tenantId: string,
    orderId: string,
    shipmentId: string,
    /** The staff member who dispatched it — the only attribution a courier poll has. */
    actorUserId: string,
  ): Promise<void> {
    const { rows: head } = await c.query<{ location_id: string }>(
      "SELECT location_id FROM sales_order WHERE id = $1",
      [orderId],
    );
    const locationId = head[0]?.location_id;
    if (!locationId) return;

    const { rows: lines } = await c.query<{
      variant_id: string;
      quantity: string;
      stock_unit_id: string | null;
    }>(
      "SELECT variant_id, quantity, stock_unit_id FROM sales_order_line WHERE order_id = $1",
      [orderId],
    );

    for (const line of lines) {
      if (line.stock_unit_id) {
        const { rowCount } = await c.query(
          `UPDATE stock_unit SET state = 'returned_pending', updated_at = now()
            WHERE id = $1 AND state = 'sold'`,
          [line.stock_unit_id],
        );
        // Already moved on by some other path — leave the ledger alone rather
        // than double-crediting the stock.
        if (rowCount === 0) continue;
      }
      await this.inventory.postMovementWith(c, tenantId, {
        id: randomUUID(),
        movementType: "return_in",
        variantId: line.variant_id,
        ...(line.stock_unit_id ? { stockUnitId: line.stock_unit_id } : {}),
        quantity: Number(line.quantity),
        to: {
          locationId,
          state: line.stock_unit_id ? "returned_pending" : "on_hand",
        },
        actorUserId,
        reference: { type: "shipment", id: shipmentId },
        occurredAt: new Date(),
      });
    }

    // R5.6: the order is not fulfilled — its goods came back. Saying so is
    // the difference between a merchant who can see their failed deliveries
    // and one whose order list quietly reports them as successes.
    //
    // Guarded on the shipped states only: an order already cancelled or
    // refunded by another path has moved on, and RTO must not drag it back.
    await c.query(
      `UPDATE sales_order
          SET status = 'returned_to_origin'
        WHERE id = $1 AND status IN ('fulfilling','fulfilled','completed','confirmed')`,
      [orderId],
    );

    // R5.6: record the freight the failed leg cost, against the order. This
    // is the number that makes the COD gate (R5.5) measurable — without it,
    // "did gating reduce our losses" has no denominator.
    const { rows: freight } = await c.query<{
      outbound: string; ret: string; cod_amount_minor: string; address: Record<string, unknown>;
    }>(
      `SELECT outbound_freight_minor AS outbound, return_freight_minor AS ret,
              cod_amount_minor, address
         FROM shipment WHERE id = $1`,
      [shipmentId],
    );
    const legs = freight[0];
    const roundTripMinor = Number(legs?.outbound ?? 0) + Number(legs?.ret ?? 0);
    if (roundTripMinor > 0) {
      await c.query(
        `UPDATE sales_order
            SET rto_freight_cost_minor = rto_freight_cost_minor + $2
          WHERE id = $1`,
        [orderId, roundTripMinor],
      );
    }

    // Feed the COD reliability history (R9.5). A refusal that never reaches
    // the risk score teaches the next decision nothing, which is how a
    // repeat refuser keeps being offered COD.
    const { rows: orderRows } = await c.query<{
      customer_id: string | null; payment_method: string | null;
    }>(
      "SELECT customer_id, payment_method FROM sales_order WHERE id = $1",
      [orderId],
    );
    const order = orderRows[0];
    if (order?.payment_method === "cod") {
      const address = (legs?.address ?? {}) as { city?: string; emirate?: string };
      await this.cod.recordOutcomeWith(c, tenantId, {
        orderId,
        shipmentId,
        ...(order.customer_id ? { customerId: order.customer_id } : {}),
        // The courier told us the goods came back, not why. `refused` is the
        // honest default for a COD return and is what the risk score counts;
        // a staff member correcting it to `undeliverable` scores identically,
        // so nothing rests on guessing right.
        outcome: "refused",
        collectedMinor: 0,
        expectedMinor: Number(legs?.cod_amount_minor ?? 0),
        freightCostMinor: roundTripMinor,
        ...(address.city ? { area: address.city } : {}),
        ...(address.emirate ? { emirate: address.emirate } : {}),
        note: `RTO on shipment ${shipmentId}`,
      });
    }

    await c.query(
      `INSERT INTO outbox (id, tenant_id, aggregate, event_type, payload)
       VALUES ($1,$2,$3,'order.rto',$4)`,
      [randomUUID(), tenantId, `order:${orderId}`,
       JSON.stringify({ orderId, shipmentId, lines: lines.length,
                        freightCostMinor: roundTripMinor })],
    );
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
