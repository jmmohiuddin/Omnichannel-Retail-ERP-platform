/**
 * Ledger drift check (real PostgreSQL). Requires ADMIN_DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "@omniretail/db";
import { DriftCheck } from "./driftCheck.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const run = Boolean(ADMIN_URL);

const workerUrl = (adminUrl: string): string => {
  const u = new URL(adminUrl);
  u.username = "omniretail_worker";
  u.password = "omniretail_worker_dev";
  return u.toString();
};

describe.skipIf(!run)("DriftCheck", () => {
  let admin: pg.Pool;
  let worker: pg.Pool;
  const tenantId = randomUUID();
  const locationId = randomUUID();
  const variantId = randomUUID();
  const userId = randomUUID();

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    admin = new pg.Pool({ connectionString: ADMIN_URL!, max: 2 });
    worker = new pg.Pool({ connectionString: workerUrl(ADMIN_URL!), max: 2 });

    const productId = randomUUID();
    await admin.query("INSERT INTO tenant (id, name, slug) VALUES ($1,'Drift Test',$2)",
      [tenantId, `drift-${tenantId.slice(0, 8)}`]);
    await admin.query(
      "INSERT INTO app_user (id, tenant_id, email, full_name) VALUES ($1,$2,'u@drift.test','U')",
      [userId, tenantId]);
    await admin.query(
      "INSERT INTO location (id, tenant_id, kind, name, code) VALUES ($1,$2,'store','S','S1')",
      [locationId, tenantId]);
    await admin.query(
      "INSERT INTO product (id, tenant_id, name, slug, status) VALUES ($1,$2,'P','p','active')",
      [productId, tenantId]);
    await admin.query(
      `INSERT INTO variant (id, tenant_id, product_id, sku, price_minor, currency)
       VALUES ($1,$2,$3,'DR-1',1000,'AED')`,
      [variantId, tenantId, productId]);
    // Consistent state: a receipt movement of 7 and a matching level of 7.
    await admin.query(
      `INSERT INTO stock_movement
         (id, tenant_id, movement_type, variant_id, quantity, to_location_id, to_state,
          actor_user_id, reference_type, reference_id)
       VALUES ($1,$2,'receipt',$3,7,$4,'on_hand',$5,'grn',$6)`,
      [randomUUID(), tenantId, variantId, locationId, userId, randomUUID()]);
    await admin.query(
      `INSERT INTO stock_level (tenant_id, location_id, variant_id, state, quantity, updated_seq)
       VALUES ($1,$2,$3,'on_hand',7,1)`,
      [tenantId, locationId, variantId]);
  }, 30_000);

  afterAll(async () => {
    await admin?.end();
    await worker?.end();
  });

  it("reports nothing for this tenant when ledger and levels agree", async () => {
    const findings = await new DriftCheck(worker).runOnce();
    expect(findings.filter((f) => f.tenantId === tenantId)).toHaveLength(0);
  });

  it("detects a level that no longer matches the ledger and emits an alarm event", async () => {
    // Simulate the bug class the check exists for: a quantity mutated without
    // a movement row. (Direct UPDATE as schema owner — app code cannot do this.)
    await admin.query(
      `UPDATE stock_level SET quantity = 9
        WHERE tenant_id = $1 AND variant_id = $2 AND state = 'on_hand'`,
      [tenantId, variantId]);

    const findings = await new DriftCheck(worker).runOnce();
    const mine = findings.filter((f) => f.tenantId === tenantId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      variantId, state: "on_hand", ledgerQty: 7, levelQty: 9, driftQty: 2,
    });

    const { rows } = await admin.query(
      `SELECT payload FROM outbox
        WHERE tenant_id = $1 AND event_type = 'inventory.drift.detected'`,
      [tenantId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.findings[0]).toMatchObject({ variantId, driftQty: 2 });
  });

  it("detects a ledger bucket with no level row at all", async () => {
    // Restore the mutated level, then orphan a bucket: movement without level.
    await admin.query(
      `UPDATE stock_level SET quantity = 7
        WHERE tenant_id = $1 AND variant_id = $2 AND state = 'on_hand'`,
      [tenantId, variantId]);
    await admin.query(
      `INSERT INTO stock_movement
         (id, tenant_id, movement_type, variant_id, quantity, to_location_id, to_state,
          actor_user_id, reference_type, reference_id)
       VALUES ($1,$2,'return_in',$3,1,$4,'returned_pending',$5,'refund',$6)`,
      [randomUUID(), tenantId, variantId, locationId, userId, randomUUID()]);

    const findings = await new DriftCheck(worker).runOnce();
    const mine = findings.filter((f) => f.tenantId === tenantId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ state: "returned_pending", ledgerQty: 1, levelQty: 0 });
  });
});
