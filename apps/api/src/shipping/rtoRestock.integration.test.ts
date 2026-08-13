/**
 * Return to origin puts the goods back in the ledger (real PostgreSQL).
 *
 * A shipment moving to `returned` used to update `shipment.status` and stop.
 * Fulfilment had already posted a `sale` movement out of the ledger and marked
 * any serialized unit `sold`, and neither was reversed — so refused stock
 * simply disappeared. In a market that is roughly 71% cash on delivery, that is
 * a loss on every refused delivery.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { Db } from "../db.js";
import { PgInventoryService } from "../inventory/pgInventory.js";
import { buildPgApp } from "../pgApp.js";
import { ShippingService } from "./shippingService.js";
import { MockCourier } from "./courierPort.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

const IMEI = "490154203237518";

describe.skipIf(!run)("RTO restocks the ledger", () => {
  let app: ReturnType<typeof buildPgApp>;
  let db: Db;
  let ownerToken = "";
  let tenantId = "";
  let locationId = "";
  let phoneVariantId = "";
  let unitId = "";
  let ownerUserId = "";
  let inventory: PgInventoryService;
  const suffix = randomUUID().slice(0, 8);
  const slug = `rto-shop-${suffix}`;

  const authed = () => ({ authorization: `Bearer ${ownerToken}` });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });
  const get = (url: string) => app.inject({ method: "GET", url, headers: authed() });

  const availability = async () =>
    (await get(`/v1/inventory/availability/${phoneVariantId}/${locationId}`)).json();

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    db = new Db(APP_URL!);
    inventory = new PgInventoryService(db);

    ownerToken = (
      await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        payload: {
          tenantName: "RTO Shop", slug, fullName: "Owner",
          email: `owner@${slug}.test`, password: "correct-horse-battery",
        },
      })
    ).json().accessToken;

    locationId = (await post("/v1/locations", { kind: "store", name: "Naif", code: "NAIF" })).json().id;
    const productId = (
      await post("/v1/products", { name: "Phone R", slug: `phone-r-${suffix}`, tracking: "serialized" })
    ).json().id;
    phoneVariantId = (
      await post(`/v1/products/${productId}/variants`, {
        sku: `PR-${suffix}`, priceMinor: 210000, currency: "AED",
      })
    ).json().id;
    unitId = (
      await post("/v1/inventory/receipts", {
        locationId,
        lines: [{ variantId: phoneVariantId, units: [{ imei1: IMEI }] }],
      })
    ).json().unitIds[0];

    tenantId = await db.withPlatform(async (c) => {
      const { rows } = await c.query<{ id: string }>("SELECT id FROM tenant WHERE slug = $1", [slug]);
      return rows[0]!.id;
    });
    ownerUserId = await db.withTenant(tenantId, async (c) => {
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

  it("returns a refused serialized unit to inspection, not to thin air", async () => {
    expect((await availability()).onHand).toBe(1);

    // Sell it online, fulfil it (binding the unit), and ship it.
    const orderId = randomUUID();
    await db.withTenant(tenantId, async (c) => {
      const { rows: ch } = await c.query<{ id: string }>(
        "SELECT id FROM channel WHERE kind <> 'pos' LIMIT 1",
      );
      await c.query(
        `INSERT INTO sales_order (id, tenant_id, channel_id, order_no, status, currency,
                                  subtotal_minor, discount_minor, tax_minor, total_minor,
                                  location_id, placed_at)
         VALUES ($1,$2,$3,$4,'confirmed','AED',210000,0,0,210000,$5, now())`,
        [orderId, tenantId, ch[0]!.id, `RTO-${suffix}`, locationId],
      );
      await c.query(
        `INSERT INTO sales_order_line (id, tenant_id, order_id, variant_id, description,
                                       quantity, unit_price_minor, discount_minor,
                                       tax_minor, total_minor)
         VALUES ($1,$2,$3,$4,'Phone R',1,210000,0,0,210000)`,
        [randomUUID(), tenantId, orderId, phoneVariantId],
      );
      // Fulfilment consumes a reservation (on_hand -> reserved -> out), so the
      // order has to hold one, exactly as web checkout would have created.
      await inventory.postMovementWith(c, tenantId, {
        id: randomUUID(),
        movementType: "reservation",
        variantId: phoneVariantId,
        quantity: 1,
        from: { locationId, state: "on_hand" },
        to: { locationId, state: "reserved" },
        actorUserId: ownerUserId,
        reference: { type: "order", id: orderId },
        occurredAt: new Date(),
      });
      await c.query(
        `INSERT INTO stock_reservation
           (tenant_id, variant_id, location_id, quantity, reference_type, reference_id,
            status, expires_at)
         VALUES ($1,$2,$3,1,'order',$4,'active', now() + interval '60 minutes')`,
        [tenantId, phoneVariantId, locationId, orderId],
      );
    });

    const fulfil = await post(`/v1/orders/${orderId}/fulfill`, {
      units: [{ variantId: phoneVariantId, stockUnitId: unitId }],
    });
    expect(fulfil.statusCode).toBe(200);

    // Sold and out of stock.
    expect((await get(`/v1/stock-units?imei=${IMEI}`)).json().state).toBe("sold");
    expect((await availability()).onHand).toBe(0);

    const shipment = await post(`/v1/orders/${orderId}/shipments`, {
      courier: "mock",
      address: { line1: "Shop 12, Naif", city: "Dubai" },
      codAmountMinor: 210000,
    });
    expect(shipment.statusCode).toBe(201);
    const { shipmentId } = shipment.json();

    // The courier reports the parcel came back.
    const shipping = new ShippingService(db, new Map([["mock", new MockCourier(["returned"])]]));
    const refreshed = await shipping.refreshTracking(tenantId, shipmentId);
    expect(refreshed.status).toBe("returned");

    // The regression: the unit is back under inspection and the ledger agrees.
    const unit = (await get(`/v1/stock-units?imei=${IMEI}`)).json();
    expect(unit.state).toBe("returned_pending");

    const avail = await availability();
    expect(avail.returnedPending).toBe(1);
    // Deliberately NOT sellable yet — a refused unit is inspected first.
    expect(avail.onHand).toBe(0);

    // An operator-visible signal was raised.
    const rto = await db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ n: string }>(
        "SELECT count(*) AS n FROM outbox WHERE event_type = 'order.rto' AND aggregate = $1",
        [`order:${orderId}`],
      );
      return Number(rows[0]!.n);
    });
    expect(rto).toBe(1);
  });
});
