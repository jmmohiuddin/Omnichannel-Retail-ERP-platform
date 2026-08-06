/**
 * Courier-agnostic shipping on real PostgreSQL: booking a shipment for a
 * fulfilled order through a CourierPort (MockCourier), mirroring the courier
 * tracking feed without duplicating events, and completing the order on
 * delivery. Skipped without DB env vars.
 *
 * Provisioning happens over HTTP against buildPgApp (like ops.integration.test:
 * tenant → warehouse → product/variant → receipt stock → public web order →
 * fulfill); the ShippingService itself is exercised directly with a Db on
 * DATABASE_URL and a MockCourier registry.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";
import { Db } from "../db.js";
import { MockCourier } from "./courierPort.js";
import { ShippingService } from "./shippingService.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("shipping", () => {
  let app: ReturnType<typeof buildPgApp>;
  let db: Db;
  let shipping: ShippingService;
  let ownerToken = "";
  let tenantId = "";
  let userId = "";
  let variantId = "";
  let fulfilledOrderId = "";
  let fulfilledOrderNo = "";
  let shipmentId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `ship-shop-${suffix}`;
  const address = { line1: "Unit 7, Al Quoz 3", city: "Dubai", country: "AE", phone: "+971501234567" };
  // Scripted courier feed for the tracking tests below.
  const script = ["handed_over", "in_transit", "out_for_delivery", "delivered"] as const;

  const authed = () => ({ authorization: `Bearer ${ownerToken}` });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });

  const placeWebOrder = async (quantity: number) => {
    const res = await app.inject({
      method: "POST", url: `/v1/public/${slug}/orders`,
      payload: { customer: { name: "Ship Buyer", email: `buyer@${slug}.test` },
                 lines: [{ variantId, quantity }] },
    });
    expect(res.statusCode).toBe(201);
    return { orderId: res.json().orderId as string, orderNo: res.json().orderNo as string };
  };

  const outboxEvents = (eventType: string) =>
    db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM outbox WHERE event_type = $1 ORDER BY sequence",
        [eventType],
      );
      return rows.map((r) => r.payload);
    });

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    const reg = await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: { tenantName: "Ship Shop", slug, fullName: "Owner",
                 email: `owner@${slug}.test`, password: "correct-horse-battery" },
    });
    ownerToken = reg.json().accessToken;

    const warehouseId = (await post("/v1/locations", { kind: "warehouse", name: "WH", code: "WH" })).json().id;
    const productId = (await post("/v1/products", { name: "Speaker", slug: "speaker", tracking: "none" })).json().id;
    variantId = (await post(`/v1/products/${productId}/variants`, {
      sku: "SPK-1", priceMinor: 9900, currency: "AED",
    })).json().id;
    await post("/v1/inventory/movements", {
      id: randomUUID(), movementType: "receipt", variantId, quantity: 40,
      to: { locationId: warehouseId, state: "on_hand" },
      reference: { type: "grn", id: randomUUID() },
    });

    const placed = await placeWebOrder(2);
    fulfilledOrderId = placed.orderId;
    fulfilledOrderNo = placed.orderNo;
    expect((await post(`/v1/orders/${fulfilledOrderId}/fulfill`, {})).statusCode).toBe(200);

    db = new Db(APP_URL!);
    shipping = new ShippingService(db, new Map([["mock", new MockCourier([...script])]]));
    tenantId = await db.withPlatform(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM tenant WHERE slug = $1", [slug],
      );
      return rows[0]!.id;
    });
    userId = await db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM app_user WHERE email = $1", [`owner@${slug}.test`],
      );
      return rows[0]!.id;
    });
  }, 30_000);

  afterAll(async () => {
    await db?.close();
    await app?.close();
  });

  it("books a shipment for a fulfilled order: tracking no, first event, outbox", async () => {
    const created = await shipping.createShipment(tenantId, userId, fulfilledOrderId, {
      courier: "mock", address, codAmountMinor: 20790,
    });
    shipmentId = created.shipmentId;
    expect(created.trackingNo).toBe(`MOCK-${fulfilledOrderNo}`);
    expect(created.labelUrl).toContain(created.trackingNo);
    expect(created.status).toBe("created");

    const view = await shipping.getShipment(tenantId, shipmentId);
    expect(view).toMatchObject({
      orderId: fulfilledOrderId, courier: "mock",
      trackingNo: `MOCK-${fulfilledOrderNo}`, status: "created",
      codAmountMinor: 20790, address,
    });
    expect(view.events).toEqual([
      expect.objectContaining({ status: "created" }),
    ]);

    const outbox = await outboxEvents("shipment.created");
    expect(outbox).toEqual([
      expect.objectContaining({ shipmentId, orderId: fulfilledOrderId,
                                trackingNo: `MOCK-${fulfilledOrderNo}`, codAmountMinor: 20790 }),
    ]);
  });

  it("refuses to ship an order that is not fulfilled (goods not picked yet)", async () => {
    const pending = await placeWebOrder(1); // stays 'pending' — never fulfilled
    await expect(
      shipping.createShipment(tenantId, userId, pending.orderId, { courier: "mock", address }),
    ).rejects.toMatchObject({ name: "ShippingError", code: "BAD_STATE" });
  });

  it("one shipment per order: a second booking is ALREADY_SHIPPED", async () => {
    await expect(
      shipping.createShipment(tenantId, userId, fulfilledOrderId, { courier: "mock", address }),
    ).rejects.toMatchObject({ name: "ShippingError", code: "ALREADY_SHIPPED" });
  });

  it("rejects unknown courier keys and unknown orders", async () => {
    await expect(
      shipping.createShipment(tenantId, userId, fulfilledOrderId, { courier: "aramex", address }),
    ).rejects.toMatchObject({ name: "ShippingError", code: "UNKNOWN_COURIER" });
    await expect(
      shipping.createShipment(tenantId, userId, randomUUID(), { courier: "mock", address }),
    ).rejects.toMatchObject({ name: "ShippingError", code: "ORDER_NOT_FOUND" });
    await expect(
      shipping.refreshTracking(tenantId, randomUUID()),
    ).rejects.toMatchObject({ name: "ShippingError", code: "SHIPMENT_NOT_FOUND" });
  });

  it("refreshTracking walks the scripted feed, appending only unseen events", async () => {
    // The mock re-sends the full history on every poll (like real courier
    // feeds); only the one genuinely new event may land per refresh.
    const first = await shipping.refreshTracking(tenantId, shipmentId);
    expect(first).toEqual({ shipmentId, status: "handed_over", appendedEvents: 1 });

    const second = await shipping.refreshTracking(tenantId, shipmentId);
    expect(second).toEqual({ shipmentId, status: "in_transit", appendedEvents: 1 });

    const view = await shipping.getShipment(tenantId, shipmentId);
    expect(view.status).toBe("in_transit");
    // 'created' + exactly one row per scripted status so far — no duplicates.
    expect(view.events.map((e) => e.status)).toEqual(["created", "handed_over", "in_transit"]);
  });

  it("delivery completes the order and emits order.delivered", async () => {
    expect((await shipping.refreshTracking(tenantId, shipmentId)).status).toBe("out_for_delivery");
    const delivered = await shipping.refreshTracking(tenantId, shipmentId);
    expect(delivered).toEqual({ shipmentId, status: "delivered", appendedEvents: 1 });

    const orderStatus = await db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ status: string }>(
        "SELECT status FROM sales_order WHERE id = $1", [fulfilledOrderId],
      );
      return rows[0]!.status;
    });
    expect(orderStatus).toBe("completed");

    expect(await outboxEvents("order.delivered")).toEqual([
      expect.objectContaining({ orderId: fulfilledOrderId, shipmentId }),
    ]);
  });

  it("polling a delivered shipment is a no-op: no new events, no extra outbox", async () => {
    const again = await shipping.refreshTracking(tenantId, shipmentId);
    expect(again).toEqual({ shipmentId, status: "delivered", appendedEvents: 0 });
    expect((await outboxEvents("order.delivered")).length).toBe(1);
  });

  it("getShipment returns the full event history in chronological order", async () => {
    const view = await shipping.getShipment(tenantId, shipmentId);
    expect(view.events.map((e) => e.status)).toEqual(["created", ...script]);
    const times = view.events.map((e) => Date.parse(e.occurredAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
