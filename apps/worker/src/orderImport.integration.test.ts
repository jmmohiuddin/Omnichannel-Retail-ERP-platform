/**
 * Marketplace order import: connector pull → ERP sales order + hard
 * reservations (real PostgreSQL, fake connector). Requires ADMIN_DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "@omniretail/db";
import {
  MemoryStateStore,
  type ChannelOrder,
  type ChannelOrderLine,
  type Connector,
  type ConnectorContext,
} from "@omniretail/connector-sdk";
import { OrderImportService, orderLineMovementId } from "./orderImport.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const run = Boolean(ADMIN_URL);

const workerUrl = (adminUrl: string): string => {
  const u = new URL(adminUrl);
  u.username = "omniretail_worker";
  u.password = "omniretail_worker_dev";
  return u.toString();
};

const fakeCtx = (): ConnectorContext => ({
  http: {
    get: async () => ({ status: 200, body: {} }),
    post: async () => ({ status: 200, body: {} }),
    put: async () => ({ status: 200, body: {} }),
  },
  credentials: async () => ({}),
  state: new MemoryStateStore(),
  log: () => {},
});

describe.skipIf(!run)("OrderImportService", () => {
  let admin: pg.Pool;
  let worker: pg.Pool;
  const tenantId = randomUUID();
  const channelId = randomUUID();
  const locationId = randomUUID();
  const systemUserId = randomUUID();
  const variantA = randomUUID(); // MKT-A, seeded on_hand 10
  const variantB = randomUUID(); // MKT-B, seeded on_hand 5

  let nextPull: ChannelOrder[] = [];
  const acked: string[] = [];
  const failAck = new Set<string>();

  const fakeConnector: Connector = {
    key: "fakemarket",
    capabilities: {
      inventorySync: false, orderImport: true, priceSync: false,
      listingPublish: false, statusSync: false,
    },
    verifyCredentials: async () => ({ ok: true, status: "healthy" }),
    pushInventory: async (_ctx, items) => items.map((i) => ({ sku: i.sku, ok: true })),
    pullOrders: async () => nextPull,
    ackOrder: async (_ctx, externalId) => {
      if (failAck.has(externalId)) throw new Error("ack endpoint down");
      acked.push(externalId);
    },
  };

  const line = (sku: string, quantity: number, unitPriceMinor: number): ChannelOrderLine => ({
    sku, quantity, unitPriceMinor, currency: "AED",
  });

  const makeOrder = (
    externalId: string,
    lines: ChannelOrderLine[],
    buyer?: ChannelOrder["buyer"],
  ): ChannelOrder => {
    const subtotal = lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
    return {
      externalId,
      orderNumber: `FM-${externalId}`,
      placedAt: "2026-08-01T10:00:00.000Z",
      status: "paid",
      currency: "AED",
      lines,
      ...(buyer ? { buyer } : {}),
      totals: {
        subtotalMinor: subtotal,
        shippingMinor: 1000,
        taxMinor: 250,
        discountMinor: 0,
        grandMinor: subtotal + 1000 + 250,
      },
      raw: { externalId },
    };
  };

  const service = () => new OrderImportService(worker);
  const importAll = () =>
    service().importOrders(tenantId, channelId, fakeConnector, fakeCtx());

  const levels = async (variantId: string): Promise<Record<string, number>> => {
    const { rows } = await admin.query(
      `SELECT state, quantity::float8 AS quantity FROM stock_level
        WHERE tenant_id = $1 AND location_id = $2 AND variant_id = $3`,
      [tenantId, locationId, variantId],
    );
    return Object.fromEntries(rows.map((r) => [r.state, Number(r.quantity)]));
  };

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    admin = new pg.Pool({ connectionString: ADMIN_URL!, max: 2 });
    worker = new pg.Pool({ connectionString: workerUrl(ADMIN_URL!), max: 2 });

    const productId = randomUUID();
    await admin.query("INSERT INTO tenant (id, name, slug) VALUES ($1,'Import Test',$2)",
      [tenantId, `oimp-${tenantId.slice(0, 8)}`]);
    await admin.query(
      `INSERT INTO app_user (id, tenant_id, email, full_name)
       VALUES ($1,$2,'system@omniretail.internal','System')`,
      [systemUserId, tenantId]);
    await admin.query(
      "INSERT INTO location (id, tenant_id, kind, name, code) VALUES ($1,$2,'warehouse','W','W1')",
      [locationId, tenantId]);
    await admin.query(
      "INSERT INTO product (id, tenant_id, name, slug, status) VALUES ($1,$2,'Phone','phone','active')",
      [productId, tenantId]);
    await admin.query(
      `INSERT INTO variant (id, tenant_id, product_id, sku, price_minor, currency)
       VALUES ($1,$2,$3,'MKT-A',5000,'AED'), ($4,$2,$3,'MKT-B',3000,'AED')`,
      [variantA, tenantId, productId, variantB]);
    await admin.query(
      `INSERT INTO channel (id, tenant_id, kind, name, connector, status)
       VALUES ($1,$2,'marketplace','Fake Market','fakemarket','active')`,
      [channelId, tenantId]);
    await admin.query(
      `INSERT INTO stock_level (tenant_id, location_id, variant_id, state, quantity, updated_seq)
       VALUES ($1,$2,$3,'on_hand',10,1), ($1,$2,$4,'on_hand',5,1)`,
      [tenantId, locationId, variantA, variantB]);
  }, 30_000);

  afterAll(async () => {
    await admin?.end();
    await worker?.end();
  });

  it("imports a paid marketplace order: order row, lines, reservations, ledger", async () => {
    nextPull = [makeOrder("ORD-1", [line("MKT-A", 2, 5000), line("MKT-B", 1, 3000)])];
    const summary = await importAll();
    expect(summary.imported).toEqual(["ORD-1"]);
    expect(summary.duplicates).toEqual([]);
    expect(summary.failed).toEqual([]);
    expect(summary.warnings).toEqual([]);

    const { rows: orders } = await admin.query(
      `SELECT id, order_no, status, location_id, currency,
              subtotal_minor::int AS subtotal, shipping_minor::int AS shipping,
              tax_minor::int AS tax, total_minor::int AS total
         FROM sales_order WHERE tenant_id = $1 AND channel_id = $2 AND external_ref = 'ORD-1'`,
      [tenantId, channelId],
    );
    expect(orders).toHaveLength(1);
    const order = orders[0]!;
    expect(order.order_no).toMatch(/^INV-\d{6}$/);
    expect(order.status).toBe("confirmed");
    expect(order.location_id).toBe(locationId);
    // Channel totals win — recorded verbatim, never recomputed.
    expect(order.subtotal).toBe(13000);
    expect(order.shipping).toBe(1000);
    expect(order.tax).toBe(250);
    expect(order.total).toBe(14250);

    const { rows: lines } = await admin.query(
      "SELECT variant_id FROM sales_order_line WHERE tenant_id = $1 AND order_id = $2",
      [tenantId, order.id],
    );
    expect(lines).toHaveLength(2);

    // Stock moved on_hand → reserved at the fulfilling location.
    expect(await levels(variantA)).toEqual({ on_hand: 8, reserved: 2 });
    expect(await levels(variantB)).toEqual({ on_hand: 4, reserved: 1 });

    // Hard reservations without expiry (marketplace orders don't expire).
    const { rows: reservations } = await admin.query(
      `SELECT variant_id, quantity::float8 AS qty, status, expires_at FROM stock_reservation
        WHERE tenant_id = $1 AND reference_type = 'order' AND reference_id = $2`,
      [tenantId, order.id],
    );
    expect(reservations).toHaveLength(2);
    for (const r of reservations) {
      expect(r.status).toBe("active");
      expect(r.expires_at).toBeNull();
    }

    // Deterministic per-line reservation movements attributed to the system user.
    const { rows: movements } = await admin.query(
      `SELECT id, movement_type, from_state, to_state, actor_user_id FROM stock_movement
        WHERE tenant_id = $1 AND reference_type = 'order' AND reference_id = $2
        ORDER BY seq`,
      [tenantId, order.id],
    );
    expect(movements).toHaveLength(2);
    expect(movements.map((m) => m.id).sort()).toEqual(
      [orderLineMovementId("ORD-1", 0), orderLineMovementId("ORD-1", 1)].sort(),
    );
    for (const m of movements) {
      expect(m.movement_type).toBe("reservation");
      expect(m.from_state).toBe("on_hand");
      expect(m.to_state).toBe("reserved");
      expect(m.actor_user_id).toBe(systemUserId);
    }

    const { rows: events } = await admin.query(
      `SELECT payload FROM outbox
        WHERE tenant_id = $1 AND event_type = 'channel.order.imported'`,
      [tenantId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ externalId: "ORD-1", totalMinor: 14250 });
  });

  it("re-running the same pull is idempotent: duplicates, stock untouched", async () => {
    nextPull = [makeOrder("ORD-1", [line("MKT-A", 2, 5000), line("MKT-B", 1, 3000)])];
    const summary = await importAll();
    expect(summary.imported).toEqual([]);
    expect(summary.duplicates).toEqual(["ORD-1"]);
    expect(summary.failed).toEqual([]);

    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM sales_order WHERE tenant_id = $1 AND external_ref = 'ORD-1'",
      [tenantId],
    );
    expect(rows[0]!.n).toBe(1);
    expect(await levels(variantA)).toEqual({ on_hand: 8, reserved: 2 });
    expect(await levels(variantB)).toEqual({ on_hand: 4, reserved: 1 });
  });

  it("fails the whole order on an unknown SKU — nothing is written", async () => {
    nextPull = [makeOrder("ORD-2", [line("MKT-A", 1, 5000), line("NO-SUCH-SKU", 1, 900)])];
    const summary = await importAll();
    expect(summary.imported).toEqual([]);
    expect(summary.failed).toEqual([
      { externalId: "ORD-2", reason: "unknown SKU NO-SUCH-SKU" },
    ]);

    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM sales_order WHERE tenant_id = $1 AND external_ref = 'ORD-2'",
      [tenantId],
    );
    expect(rows[0]!.n).toBe(0);
    // The valid line rolled back with the order: no partial import, no movement.
    expect(await levels(variantA)).toEqual({ on_hand: 8, reserved: 2 });
    const { rows: mv } = await admin.query(
      "SELECT count(*)::int AS n FROM stock_movement WHERE tenant_id = $1",
      [tenantId],
    );
    expect(mv[0]!.n).toBe(2); // still only ORD-1's two movements
  });

  it("fails when no location can cover the order from on-hand stock", async () => {
    nextPull = [makeOrder("ORD-3", [line("MKT-A", 999, 5000)])];
    const summary = await importAll();
    expect(summary.failed).toEqual([{ externalId: "ORD-3", reason: "insufficient stock" }]);
    expect(summary.imported).toEqual([]);

    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM sales_order WHERE tenant_id = $1 AND external_ref = 'ORD-3'",
      [tenantId],
    );
    expect(rows[0]!.n).toBe(0);
    expect(await levels(variantA)).toEqual({ on_hand: 8, reserved: 2 });
  });

  it("acks imported orders only, after commit", async () => {
    acked.length = 0;
    nextPull = [
      makeOrder("ORD-4", [line("MKT-B", 1, 3000)]),
      makeOrder("ORD-1", [line("MKT-A", 2, 5000), line("MKT-B", 1, 3000)]), // duplicate
      makeOrder("ORD-5", [line("MKT-A", 999, 5000)]), // insufficient stock
    ];
    const summary = await importAll();
    expect(summary.imported).toEqual(["ORD-4"]);
    expect(summary.duplicates).toEqual(["ORD-1"]);
    expect(summary.failed).toHaveLength(1);
    expect(acked).toEqual(["ORD-4"]);
    expect(await levels(variantB)).toEqual({ on_hand: 3, reserved: 2 });
  });

  it("ack failure downgrades to imported-with-warning, never rolls back", async () => {
    failAck.add("ORD-6");
    nextPull = [makeOrder("ORD-6", [line("MKT-A", 1, 5000)])];
    const summary = await importAll();
    failAck.delete("ORD-6");

    expect(summary.imported).toEqual(["ORD-6"]);
    expect(summary.failed).toEqual([]);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toContain("ORD-6");
    expect(summary.warnings[0]).toContain("ack endpoint down");

    // The order stayed committed despite the failed ack.
    const { rows } = await admin.query(
      "SELECT status FROM sales_order WHERE tenant_id = $1 AND external_ref = 'ORD-6'",
      [tenantId],
    );
    expect(rows[0]!.status).toBe("confirmed");
    expect(await levels(variantA)).toEqual({ on_hand: 7, reserved: 3 });
  });

  it("upserts the buyer as a customer by email and reuses it across orders", async () => {
    nextPull = [makeOrder("ORD-7", [line("MKT-A", 1, 5000)],
      { name: "Amina K", email: "amina@example.com" })];
    await importAll();
    nextPull = [makeOrder("ORD-8", [line("MKT-A", 1, 5000)],
      { name: "Amina K", email: "amina@example.com" })];
    await importAll();

    const { rows: customers } = await admin.query(
      "SELECT id, full_name FROM customer WHERE tenant_id = $1 AND email = 'amina@example.com'",
      [tenantId],
    );
    expect(customers).toHaveLength(1);
    expect(customers[0]!.full_name).toBe("Amina K");

    const { rows: orders } = await admin.query(
      `SELECT customer_id FROM sales_order
        WHERE tenant_id = $1 AND external_ref IN ('ORD-7','ORD-8')`,
      [tenantId],
    );
    expect(orders).toHaveLength(2);
    expect(orders[0]!.customer_id).toBe(customers[0]!.id);
    expect(orders[1]!.customer_id).toBe(customers[0]!.id);
  });

  it("assigns gapless sequential order numbers across imports", async () => {
    const { rows } = await admin.query(
      `SELECT order_no FROM sales_order WHERE tenant_id = $1 ORDER BY order_no`,
      [tenantId],
    );
    const numbers = rows.map((r) => Number(r.order_no.replace("INV-", "")));
    // ORD-1, ORD-4, ORD-6, ORD-7, ORD-8 imported; failures rolled their
    // counter increment back inside the same transaction — no gaps.
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  });
});
