/**
 * Reservation janitor (real PostgreSQL). Requires ADMIN_DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "@omniretail/db";
import { ReservationJanitor } from "./reservationJanitor.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const run = Boolean(ADMIN_URL);

const workerUrl = (adminUrl: string): string => {
  const u = new URL(adminUrl);
  u.username = "omniretail_worker";
  u.password = "omniretail_worker_dev";
  return u.toString();
};

describe.skipIf(!run)("ReservationJanitor", () => {
  let admin: pg.Pool;
  let worker: pg.Pool;
  const tenantId = randomUUID();
  const locationId = randomUUID();
  const variantId = randomUUID();
  const channelId = randomUUID();
  const orderId = randomUUID();

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    admin = new pg.Pool({ connectionString: ADMIN_URL!, max: 2 });
    worker = new pg.Pool({ connectionString: workerUrl(ADMIN_URL!), max: 2 });

    const productId = randomUUID();
    await admin.query("INSERT INTO tenant (id, name, slug) VALUES ($1,'Janitor Test',$2)",
      [tenantId, `jan-${tenantId.slice(0, 8)}`]);
    await admin.query(
      `INSERT INTO app_user (id, tenant_id, email, full_name, status)
       VALUES ($1,$2,'system@omniretail.internal','System','active')`,
      [randomUUID(), tenantId]);
    await admin.query(
      "INSERT INTO location (id, tenant_id, kind, name, code) VALUES ($1,$2,'warehouse','W','W1')",
      [locationId, tenantId]);
    await admin.query(
      "INSERT INTO product (id, tenant_id, name, slug, status) VALUES ($1,$2,'P','p','active')",
      [productId, tenantId]);
    await admin.query(
      `INSERT INTO variant (id, tenant_id, product_id, sku, price_minor, currency)
       VALUES ($1,$2,$3,'JAN-1',1000,'AED')`,
      [variantId, tenantId, productId]);
    await admin.query(
      "INSERT INTO channel (id, tenant_id, kind, name) VALUES ($1,$2,'web','Web')",
      [channelId, tenantId]);
    // 3 on hand, 2 reserved by a pending order whose reservation expired.
    await admin.query(
      `INSERT INTO stock_level (tenant_id, location_id, variant_id, state, quantity, updated_seq)
       VALUES ($1,$2,$3,'on_hand',3,1), ($1,$2,$3,'reserved',2,1)`,
      [tenantId, locationId, variantId]);
    await admin.query(
      `INSERT INTO sales_order (id, tenant_id, order_no, channel_id, location_id, status,
                                currency, total_minor)
       VALUES ($1,$2,'INV-000001',$3,$4,'pending','AED',2000)`,
      [orderId, tenantId, channelId, locationId]);
    await admin.query(
      `INSERT INTO payment (id, tenant_id, order_id, method, amount_minor, currency, status)
       VALUES ($1,$2,$3,'gateway',2000,'AED','pending')`,
      [randomUUID(), tenantId, orderId]);
    await admin.query(
      `INSERT INTO stock_reservation (tenant_id, variant_id, location_id, quantity,
                                      reference_type, reference_id, status, expires_at)
       VALUES ($1,$2,$3,2,'order',$4,'active', now() - interval '5 minutes')`,
      [tenantId, variantId, locationId, orderId]);
  }, 30_000);

  afterAll(async () => {
    await admin?.end();
    await worker?.end();
  });

  it("releases expired reservations, cancels the order, voids payment", async () => {
    const released = await new ReservationJanitor(worker).runOnce();
    expect(released).toContain(orderId);

    const levels = await admin.query(
      `SELECT state, quantity::float8 AS q FROM stock_level
        WHERE tenant_id = $1 AND variant_id = $2 ORDER BY state`,
      [tenantId, variantId],
    );
    const byState = Object.fromEntries(levels.rows.map((r) => [r.state, r.q]));
    expect(byState.on_hand).toBe(5);
    expect(byState.reserved).toBe(0);

    const order = await admin.query("SELECT status FROM sales_order WHERE id = $1", [orderId]);
    expect(order.rows[0].status).toBe("cancelled");
    const payment = await admin.query("SELECT status FROM payment WHERE order_id = $1", [orderId]);
    expect(payment.rows[0].status).toBe("voided");
    const reservation = await admin.query(
      "SELECT status FROM stock_reservation WHERE reference_id = $1", [orderId]);
    expect(reservation.rows[0].status).toBe("expired");

    const movement = await admin.query(
      `SELECT movement_type, note FROM stock_movement
        WHERE tenant_id = $1 AND reference_id = $2`,
      [tenantId, orderId],
    );
    expect(movement.rows[0]).toMatchObject({ movement_type: "release" });
  });

  it("is idempotent: a second run releases nothing", async () => {
    const released = await new ReservationJanitor(worker).runOnce();
    expect(released).toHaveLength(0);
  });
});
