/**
 * Channel sync: ledger event → connector inventory push (real PostgreSQL,
 * fake connector). Requires ADMIN_DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "@omniretail/db";
import {
  ConnectorRegistry,
  MemoryStateStore,
  type Connector,
  type ConnectorContext,
  type InventoryPush,
} from "@omniretail/connector-sdk";
import { ChannelSyncService } from "./channelSync.js";

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

describe.skipIf(!run)("ChannelSyncService", () => {
  let admin: pg.Pool;
  let worker: pg.Pool;
  const tenantId = randomUUID();
  const channelId = randomUUID();
  const variantId = randomUUID();
  const locationId = randomUUID();
  const pushes: InventoryPush[][] = [];
  let failNext = false;

  const fakeConnector: Connector = {
    key: "fakemarket",
    capabilities: {
      inventorySync: true, orderImport: true, priceSync: false,
      listingPublish: false, statusSync: false,
    },
    verifyCredentials: async () => ({ ok: true }),
    pushInventory: async (_ctx, items) => {
      pushes.push(items);
      if (failNext) return items.map((i) => ({ sku: i.sku, ok: false, message: "channel down", errorClass: "transient" as const }));
      return items.map((i) => ({ sku: i.sku, ok: true }));
    },
    pullOrders: async () => [],
  };

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    admin = new pg.Pool({ connectionString: ADMIN_URL!, max: 2 });
    worker = new pg.Pool({ connectionString: workerUrl(ADMIN_URL!), max: 2 });

    const productId = randomUUID();
    await admin.query("INSERT INTO tenant (id, name, slug) VALUES ($1,'Sync Test',$2)",
      [tenantId, `sync-${tenantId.slice(0, 8)}`]);
    await admin.query(
      "INSERT INTO location (id, tenant_id, kind, name, code) VALUES ($1,$2,'store','S','S1')",
      [locationId, tenantId]);
    await admin.query(
      "INSERT INTO product (id, tenant_id, name, slug, status) VALUES ($1,$2,'P','p','active')",
      [productId, tenantId]);
    await admin.query(
      `INSERT INTO variant (id, tenant_id, product_id, sku, price_minor, currency)
       VALUES ($1,$2,$3,'SYNC-1',1000,'AED')`,
      [variantId, tenantId, productId]);
    await admin.query(
      `INSERT INTO channel (id, tenant_id, kind, name, connector, status)
       VALUES ($1,$2,'marketplace','Fake Market','fakemarket','active')`,
      [channelId, tenantId]);
    await admin.query(
      `INSERT INTO channel_listing (tenant_id, channel_id, variant_id, published, buffer_qty)
       VALUES ($1,$2,$3,true,2)`,
      [tenantId, channelId, variantId]);
    await admin.query(
      `INSERT INTO stock_level (tenant_id, location_id, variant_id, state, quantity, updated_seq)
       VALUES ($1,$2,$3,'on_hand',10,1)`,
      [tenantId, locationId, variantId]);
  }, 30_000);

  afterAll(async () => {
    await admin?.end();
    await worker?.end();
  });

  const service = () => {
    const registry = new ConnectorRegistry();
    registry.register(fakeConnector);
    return new ChannelSyncService(worker, registry, fakeCtx);
  };

  it("pushes on-hand minus channel buffer and records the sync cursor", async () => {
    const results = await service().handleInventoryChanged(tenantId, variantId, 42);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, sku: "SYNC-1", pushedQty: 8 }); // 10 − buffer 2

    const { rows } = await admin.query(
      "SELECT last_synced_seq, sync_error FROM channel_listing WHERE channel_id = $1",
      [channelId],
    );
    expect(Number(rows[0].last_synced_seq)).toBe(42);
    expect(rows[0].sync_error).toBeNull();
  });

  it("records per-listing sync errors without throwing", async () => {
    failNext = true;
    const results = await service().handleInventoryChanged(tenantId, variantId, 43);
    failNext = false;
    expect(results[0]).toMatchObject({ ok: false, error: "channel down" });

    const { rows } = await admin.query(
      "SELECT sync_error FROM channel_listing WHERE channel_id = $1",
      [channelId],
    );
    expect(rows[0].sync_error).toBe("channel down");
  });

  it("buffer floors availability at zero (never advertises negative)", async () => {
    await admin.query(
      "UPDATE stock_level SET quantity = 1 WHERE tenant_id = $1 AND variant_id = $2",
      [tenantId, variantId],
    );
    const results = await service().handleInventoryChanged(tenantId, variantId, 44);
    expect(results[0]!.pushedQty).toBe(0); // 1 − buffer 2 → floored
  });
});
