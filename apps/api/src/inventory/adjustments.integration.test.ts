/**
 * Stock adjustments with mandatory reason codes (R4.1) on real PostgreSQL.
 *
 * Covers the edge case the PRD rates P0 and expects "in week one": stock drifts
 * from physical reality, someone corrects it, and the correction must say why,
 * be signed off by a second person, and land in the ledger — not in a quantity
 * column. Skipped without DB env vars.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { Db } from "../db.js";
import { AuditService } from "../audit/auditService.js";
import { PgInventoryService } from "./pgInventory.js";
import { type AdjustmentRequest, OpsService } from "./opsService.js";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("stock adjustments", () => {
  let app: ReturnType<typeof buildPgApp>;
  let db: Db;
  let ops: OpsService;
  let tenantId = "";
  let ownerToken = "";
  let managerToken = "";
  let storeId = "";
  let variantId = "";
  let serializedVariantId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `adj-shop-${suffix}`;

  // The service is exercised directly: its routes are wired by the orchestrator,
  // so the two-person control and the ledger effect are what is under test here.
  const owner = () => ({ userId: users.owner, roles: ["owner"] });
  const manager = () => ({ userId: users.manager, roles: ["manager"] });
  const keeper = () => ({ userId: users.warehouse, roles: ["warehouse"] });
  const cashier = () => ({ userId: users.cashier, roles: ["cashier"] });
  const users = { owner: "", manager: "", warehouse: "", cashier: "" };

  const authed = (t: string) => ({ authorization: `Bearer ${t}` });
  const post = (t: string, url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(t), payload: payload as never });

  const subject = (token: string) =>
    JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as {
      sub: string;
      ten: string;
    };

  const onHand = async () =>
    (await app.inject({
      url: `/v1/inventory/availability/${variantId}/${storeId}`,
      headers: authed(ownerToken),
    })).json().onHand as number;

  const decide = (token: string, approvalId: string, approve: boolean) =>
    post(token, `/v1/approvals/${approvalId}/decision`, { approve });

  /** Post a movement row straight at the database, bypassing every app rule. */
  const rawMovement = (over: Record<string, unknown>) =>
    db.withTenant(tenantId, (c) =>
      c.query(
        `INSERT INTO stock_movement
           (id, tenant_id, occurred_at, movement_type, variant_id, quantity,
            from_location_id, from_state, actor_user_id, reference_type,
            reference_id, approval_id, reason)
         VALUES ($1,$2, now(), $3,$4,$5,$6,'on_hand',$7,'adjustment',$8,$9,$10)`,
        [
          randomUUID(), tenantId,
          over.movementType ?? "adjustment", over.variantId ?? variantId,
          over.quantity ?? 1, over.locationId ?? storeId, users.owner,
          randomUUID(), over.approvalId ?? null, over.reason ?? null,
        ],
      ),
    );

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    db = new Db(APP_URL!);
    ops = new OpsService(db, new PgInventoryService(db), new AuditService(db));

    const reg = await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: { tenantName: "Adjustment Shop", slug, fullName: "Owner",
                 email: `owner@${slug}.test`, password: "correct-horse-battery" },
    });
    ownerToken = reg.json().accessToken;
    const claims = subject(ownerToken);
    users.owner = claims.sub;
    tenantId = claims.ten;

    for (const role of ["manager", "warehouse", "cashier"] as const) {
      const created = await post(ownerToken, "/v1/users", {
        email: `${role}@${slug}.test`, password: "employee-pass-123",
        fullName: role, role,
      });
      users[role] = created.json().userId;
    }
    managerToken = (await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { slug, email: `manager@${slug}.test`, password: "employee-pass-123" },
    })).json().accessToken;

    storeId = (await post(ownerToken, "/v1/locations",
      { kind: "store", name: "Store", code: "ST" })).json().id;
    const productId = (await post(ownerToken, "/v1/products",
      { name: "Cable", slug: "cable", tracking: "none" })).json().id;
    variantId = (await post(ownerToken, `/v1/products/${productId}/variants`,
      { sku: "CB-1", priceMinor: 2100, currency: "AED" })).json().id;
    const phoneId = (await post(ownerToken, "/v1/products",
      { name: "Phone", slug: "phone", tracking: "serialized" })).json().id;
    serializedVariantId = (await post(ownerToken, `/v1/products/${phoneId}/variants`,
      { sku: "PH-1", priceMinor: 250000, currency: "AED" })).json().id;

    await post(ownerToken, "/v1/inventory/movements", {
      id: randomUUID(), movementType: "receipt", variantId, quantity: 40,
      to: { locationId: storeId, state: "on_hand" },
      reference: { type: "grn", id: randomUUID() },
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  // -- (a) no reason ---------------------------------------------------------

  it("rejects an adjustment with no reason code", async () => {
    await expect(
      ops.requestAdjustment(tenantId, keeper(), {
        locationId: storeId, variantId, quantity: 1,
      } as unknown as AdjustmentRequest),
    ).rejects.toMatchObject({ code: "INVALID_SHAPE" });
  });

  it("the database refuses a reason on a movement type that has none", async () => {
    // The scope CHECK cuts both ways: only adjustments and write-offs carry one.
    await expect(
      rawMovement({ movementType: "receipt", reason: "damage" }),
    ).rejects.toMatchObject({ constraint: "stock_movement_reason_scope" });
  });

  // -- (b) invalid reason ----------------------------------------------------

  it("rejects a reason outside the enum", async () => {
    await expect(
      ops.requestAdjustment(tenantId, keeper(), {
        locationId: storeId, variantId, quantity: 1,
        reason: "shrinkage" as never,
      }),
    ).rejects.toMatchObject({ code: "INVALID_SHAPE" });
  });

  it("the database refuses an approval carrying a reason outside the enum", async () => {
    await expect(
      db.withTenant(tenantId, (c) =>
        c.query(
          `INSERT INTO approval (id, tenant_id, kind, requested_by, status, payload)
           VALUES ($1,$2,'stock_adjustment',$3,'pending',$4)`,
          [randomUUID(), tenantId, users.owner,
           JSON.stringify({ variantId, locationId: storeId, quantity: 1, reason: "shrinkage" })],
        ),
      ),
    ).rejects.toMatchObject({ constraint: "approval_stock_adjustment_payload" });
  });

  // -- (c) no approval -------------------------------------------------------

  it("the existing trigger still blocks an adjustment with no approval", async () => {
    await expect(rawMovement({ reason: "damage" })).rejects.toMatchObject({
      message: expect.stringContaining("requires an approval_id"),
    });
    // …and through the movements route, where the domain rejects it first.
    const res = await post(ownerToken, "/v1/inventory/movements", {
      id: randomUUID(), movementType: "adjustment", variantId, quantity: 1,
      from: { locationId: storeId, state: "on_hand" },
      reference: { type: "adjustment", id: randomUUID() },
    });
    expect(res.statusCode).toBe(403);
  });

  it("an approval of another kind cannot be laundered into an adjustment", async () => {
    // The hole 029 closes: any approval id at all used to satisfy the trigger,
    // so a cashier's own discount approval would have passed.
    const discount = await post(ownerToken, "/v1/pos/discount-approvals", {
      reason: "manager override", amountMinor: 500,
    });
    await expect(
      rawMovement({ reason: "damage", approvalId: discount.json().approvalId }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("not a stock adjustment approval"),
    });
  });

  // -- (d) happy path --------------------------------------------------------

  it("requests, approves and posts a damage adjustment against the ledger", async () => {
    const before = await onHand();
    const { approvalId, reason } = await ops.requestAdjustment(tenantId, keeper(), {
      locationId: storeId, variantId, quantity: 3, reason: "damage",
      note: "water damage in the stockroom",
    });
    expect(reason).toBe("damage");

    // Nothing moves on the request alone.
    expect(await onHand()).toBe(before);
    await expect(ops.postAdjustment(tenantId, keeper(), approvalId)).rejects.toMatchObject({
      code: "ADJUSTMENT_NOT_APPROVED",
    });

    const decision = await decide(managerToken, approvalId, true);
    expect(decision.statusCode).toBe(200);
    expect(decision.json().status).toBe("approved");

    const posted = await ops.postAdjustment(tenantId, keeper(), approvalId);
    expect(posted.quantity).toBe(3);
    expect(await onHand()).toBe(before - 3);

    const { rows } = await db.withTenant(tenantId, (c) =>
      c.query<{ reason: string; movement_type: string; approval_id: string; note: string }>(
        "SELECT reason, movement_type, approval_id, note FROM stock_movement WHERE id = $1",
        [posted.movementId],
      ),
    );
    expect(rows[0]).toMatchObject({
      reason: "damage",
      movement_type: "adjustment",
      approval_id: approvalId,
      note: "water damage in the stockroom",
    });
  });

  it("posts a write-off as its own movement type", async () => {
    const before = await onHand();
    const { approvalId } = await ops.requestAdjustment(tenantId, keeper(), {
      locationId: storeId, variantId, quantity: 2, reason: "write_off",
    });
    await decide(ownerToken, approvalId, true);
    const posted = await ops.postAdjustment(tenantId, keeper(), approvalId);
    expect(await onHand()).toBe(before - 2);

    const { rows } = await db.withTenant(tenantId, (c) =>
      c.query<{ movement_type: string; reason: string }>(
        "SELECT movement_type, reason FROM stock_movement WHERE id = $1",
        [posted.movementId],
      ),
    );
    expect(rows[0]).toMatchObject({ movement_type: "write_off", reason: "write_off" });
  });

  // -- (e) two-person control ------------------------------------------------

  it("the requester cannot approve their own adjustment", async () => {
    const { approvalId } = await ops.requestAdjustment(tenantId, manager(), {
      locationId: storeId, variantId, quantity: 1, reason: "theft",
    });
    const selfApprove = await decide(managerToken, approvalId, true);
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().error).toBe("SELF_APPROVAL");

    // Still unpostable afterwards.
    await expect(ops.postAdjustment(tenantId, manager(), approvalId)).rejects.toMatchObject({
      code: "ADJUSTMENT_NOT_APPROVED",
    });
  });

  it("a rejected adjustment never reaches the ledger", async () => {
    const before = await onHand();
    const { approvalId } = await ops.requestAdjustment(tenantId, keeper(), {
      locationId: storeId, variantId, quantity: 5, reason: "correction",
    });
    await decide(managerToken, approvalId, false);
    await expect(ops.postAdjustment(tenantId, keeper(), approvalId)).rejects.toMatchObject({
      code: "ADJUSTMENT_NOT_APPROVED",
    });
    expect(await onHand()).toBe(before);
  });

  it("one approval cannot be spent twice", async () => {
    const before = await onHand();
    const { approvalId } = await ops.requestAdjustment(tenantId, keeper(), {
      locationId: storeId, variantId, quantity: 1, reason: "sample",
    });
    await decide(managerToken, approvalId, true);
    await ops.postAdjustment(tenantId, keeper(), approvalId);
    await expect(ops.postAdjustment(tenantId, keeper(), approvalId)).rejects.toMatchObject({
      code: "ADJUSTMENT_ALREADY_POSTED",
    });
    expect(await onHand()).toBe(before - 1);
  });

  it("an approved adjustment cannot be posted for a different quantity", async () => {
    const { approvalId } = await ops.requestAdjustment(tenantId, keeper(), {
      locationId: storeId, variantId, quantity: 2, reason: "damage",
    });
    await decide(managerToken, approvalId, true);
    // Bypassing the service entirely: the trigger holds the movement to the
    // quantity the manager actually saw.
    await expect(rawMovement({ approvalId, quantity: 20 })).rejects.toMatchObject({
      message: expect.stringContaining("was not what approval"),
    });
  });

  // -- permissioning ---------------------------------------------------------

  it("a cashier can neither request nor post an adjustment", async () => {
    await expect(
      ops.requestAdjustment(tenantId, cashier(), {
        locationId: storeId, variantId, quantity: 1, reason: "theft",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
    await expect(
      ops.postAdjustment(tenantId, cashier(), randomUUID()),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
  });

  // -- shapes this build does not accept -------------------------------------

  it("refuses a 'found' adjustment, which would credit stock", async () => {
    await expect(
      ops.requestAdjustment(tenantId, owner(), {
        locationId: storeId, variantId, quantity: 1, reason: "found",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SHAPE" });
  });

  it("refuses to adjust serialized stock by quantity", async () => {
    await expect(
      ops.requestAdjustment(tenantId, owner(), {
        locationId: storeId, variantId: serializedVariantId, quantity: 1, reason: "theft",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SHAPE" });
  });

  it("refuses a quantity finer than the ledger stores", async () => {
    await expect(
      ops.requestAdjustment(tenantId, owner(), {
        locationId: storeId, variantId, quantity: 1.0005, reason: "correction",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SHAPE" });
  });
});
