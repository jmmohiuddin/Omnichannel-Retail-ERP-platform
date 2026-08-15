/**
 * Payment reconciliation (R6.2) against real PostgreSQL.
 *
 * The failure this exists for: Stripe, N-Genius and Tabby all confirm
 * asynchronously, so a dropped webhook leaves an intent stuck in `created`
 * while the shopper's money has already moved. Nothing repaired it.
 *
 * The failure a repair job can *cause* is worse than the one it fixes, so most
 * of what is asserted here is that the money moves exactly once: across repeat
 * runs, across a webhook that arrives after the repair, and across a webhook
 * racing the repair.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "@omniretail/db";
import { Db } from "@omniretail/api/db";
import { PaymentService } from "@omniretail/api/payments";
import { MockGateway } from "@omniretail/api/payments/gateway";
import type { PaymentGatewayPort } from "@omniretail/api/payments/gateway";
import {
  MemoryExceptionSink,
  PaymentReconciler,
  PgExceptionSink,
} from "./paymentReconciler.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

const asRole = (adminUrl: string, role: string, password: string): string => {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  return u.toString();
};

/**
 * Discovery is cross-tenant by design, so a test that wants to observe exactly
 * one intent gives it an age band of its own and a threshold that excludes
 * everything else this suite has left lying around.
 */
const STALE = "2 hours";
const THRESHOLD = { staleAfterSeconds: 3600, limit: 500 };
const OLDER = { age: "5 hours", threshold: { staleAfterSeconds: 4 * 3600, limit: 500 } };
const OLDEST = { age: "9 hours", threshold: { staleAfterSeconds: 8 * 3600, limit: 500 } };

describe.skipIf(!run)("PaymentReconciler", () => {
  let admin: pg.Pool;
  let db: Db;
  let gateway: MockGateway;
  let payments: PaymentService;
  let sink: MemoryExceptionSink;
  let reconciler: PaymentReconciler;

  const tenantId = randomUUID();
  const locationId = randomUUID();
  const channelId = randomUUID();

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    admin = new pg.Pool({ connectionString: ADMIN_URL!, max: 4 });
    db = new Db(APP_URL!);
    gateway = new MockGateway("reconciler-test-secret-0123456789");
    payments = new PaymentService(db, new Map([[gateway.key, gateway]]));
    sink = new MemoryExceptionSink();
    reconciler = new PaymentReconciler(db.pool, payments, sink);

    await admin.query("INSERT INTO tenant (id, name, slug) VALUES ($1,'Reconciler Test',$2)", [
      tenantId,
      `rec-${tenantId.slice(0, 8)}`,
    ]);
    await admin.query(
      "INSERT INTO location (id, tenant_id, kind, name, code) VALUES ($1,$2,'warehouse','W','W1')",
      [locationId, tenantId],
    );
    await admin.query("INSERT INTO channel (id, tenant_id, kind, name) VALUES ($1,$2,'web','Web')", [
      channelId,
      tenantId,
    ]);
  }, 30_000);

  afterAll(async () => {
    // Leaves the tenant behind, like the other integration suites: the test
    // database is disposable and the FKs make a partial teardown fiddlier than
    // it is worth.
    await db?.close();
    await admin?.end();
  });

  // -------------------------------------------------------------------------

  it("repairs an intent the gateway says was paid, and the order follows", async () => {
    const o = await seedStuckIntent({ amountMinor: 12_500 });
    gateway.setStatus(o.gatewayRef, {
      state: "succeeded",
      amountMinor: 12_500,
      currency: "AED",
    });

    const summary = await reconciler.runOnce(THRESHOLD);

    expect(outcomeFor(summary, o.intentId)?.action).toBe("captured");
    expect(await intentStatus(o.intentId)).toBe("succeeded");
    expect(await paymentStatuses(o.orderId)).toEqual(["captured"]);
    expect(await orderStatus(o.orderId)).toBe("confirmed");
    expect(await orderPaidEvents(o.orderId)).toBe(1);
    expect(sink.flagged.filter((f) => f.intentId === o.intentId)).toHaveLength(0);
  });

  it("running twice does not apply the payment twice", async () => {
    const o = await seedStuckIntent({ amountMinor: 9_900 });
    gateway.setStatus(o.gatewayRef, { state: "succeeded", amountMinor: 9_900, currency: "AED" });

    await reconciler.runOnce(THRESHOLD);
    const second = await reconciler.runOnce(THRESHOLD);

    // The intent is terminal, so the second pass should not even see it.
    expect(outcomeFor(second, o.intentId)).toBeUndefined();
    // The assertions that matter are on the rows, not on a return value.
    expect(await paymentStatuses(o.orderId)).toEqual(["captured"]);
    expect(await capturedTotalMinor(o.orderId)).toBe(9_900n);
    expect(await orderPaidEvents(o.orderId)).toBe(1);
    expect(await reconcileDeliveries(o.gatewayRef)).toBe(1);
  });

  it("does not apply twice when two reconcilers run concurrently", async () => {
    const o = await seedStuckIntent({ amountMinor: 4_200, age: OLDER.age });
    gateway.setStatus(o.gatewayRef, { state: "succeeded", amountMinor: 4_200, currency: "AED" });

    const [a, b] = await Promise.all([
      reconciler.runOnce(OLDER.threshold),
      reconciler.runOnce(OLDER.threshold),
    ]);

    const actions = [outcomeFor(a, o.intentId)?.action, outcomeFor(b, o.intentId)?.action];
    // Exactly one of them did the work; the other collided on the derived
    // idempotency key or found the intent already terminal.
    expect(actions.filter((x) => x === "captured")).toHaveLength(1);
    expect(await orderPaidEvents(o.orderId)).toBe(1);
    expect(await paymentStatuses(o.orderId)).toEqual(["captured"]);
  });

  it("is a no-op for a webhook that arrives after the repair", async () => {
    const o = await seedStuckIntent({ amountMinor: 7_000 });
    gateway.setStatus(o.gatewayRef, { state: "succeeded", amountMinor: 7_000, currency: "AED" });

    await reconciler.runOnce(THRESHOLD);
    expect(await orderPaidEvents(o.orderId)).toBe(1);

    // The gateway finally retries the delivery it lost. Different idempotency
    // key from the reconciler's, so the dedupe row does NOT stop it — the
    // intent's terminal status does.
    const late = await payments.applyWebhook(
      "mock",
      { externalId: `evt-late-${randomUUID()}`, gatewayRef: o.gatewayRef, type: "payment.succeeded" },
      "{}",
    );

    expect(late.result).toBe("already_final");
    expect(await orderPaidEvents(o.orderId)).toBe(1);
    expect(await paymentStatuses(o.orderId)).toEqual(["captured"]);
    expect(await capturedTotalMinor(o.orderId)).toBe(7_000n);
  });

  it("does not double-apply when a webhook lands while the repair is in flight", async () => {
    // The race the reconciler introduces. Both callers resolve the intent in
    // their own read-only transaction and both see 'created'; only the row lock
    // inside the effect transaction stops the second from applying. The gate
    // makes the interleaving deterministic rather than hoping for it.
    const o = await seedStuckIntent({ amountMinor: 3_300, age: OLDEST.age });
    gateway.setStatus(o.gatewayRef, { state: "succeeded", amountMinor: 3_300, currency: "AED" });

    let release!: () => void;
    let reachedEffect!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const atEffect = new Promise<void>((r) => { reachedEffect = r; });

    const gated = new PaymentReconciler(
      db.pool,
      new PaymentService(gatedDb(db, reachedEffect, gate), new Map([["mock", gateway]])),
      sink,
    );

    const repairing = gated.runOnce(OLDEST.threshold);
    await atEffect; // the reconciler has read 'created' and is holding at the effect

    const viaWebhook = await payments.applyWebhook(
      "mock",
      { externalId: `evt-race-${randomUUID()}`, gatewayRef: o.gatewayRef, type: "payment.succeeded" },
      "{}",
    );
    expect(viaWebhook.result).toBe("captured");

    release();
    const summary = await repairing;

    expect(outcomeFor(summary, o.intentId)?.action).toBe("already_final");
    expect(await orderPaidEvents(o.orderId)).toBe(1);
    expect(await paymentStatuses(o.orderId)).toEqual(["captured"]);
    expect(await capturedTotalMinor(o.orderId)).toBe(3_300n);
  });

  it("flags an intent the gateway reports as failed instead of paying it", async () => {
    const o = await seedStuckIntent({ amountMinor: 5_000 });
    gateway.setStatus(o.gatewayRef, { state: "failed", reason: "card_declined" });

    const summary = await reconciler.runOnce(THRESHOLD);

    expect(outcomeFor(summary, o.intentId)?.action).toBe("failed");
    const flags = sink.flagged.filter((f) => f.intentId === o.intentId);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.reason).toBe("gateway_failed");
    expect(flags[0]!.detail).toEqual({ reason: "card_declined" });

    // Closed as failed so it stops being polled — but nothing was captured and
    // the order was NOT confirmed.
    expect(await intentStatus(o.intentId)).toBe("failed");
    expect(await paymentStatuses(o.orderId)).toEqual(["pending"]);
    expect(await orderStatus(o.orderId)).toBe("pending");
    expect(await orderPaidEvents(o.orderId)).toBe(0);
  });

  it("refuses to capture when the gateway's amount does not match the intent", async () => {
    const o = await seedStuckIntent({ amountMinor: 10_000 });
    gateway.setStatus(o.gatewayRef, { state: "succeeded", amountMinor: 1_000, currency: "AED" });

    const summary = await reconciler.runOnce(THRESHOLD);

    expect(outcomeFor(summary, o.intentId)?.action).toBe("flagged");
    const flags = sink.flagged.filter((f) => f.intentId === o.intentId);
    expect(flags[0]!.reason).toBe("amount_mismatch");
    expect(flags[0]!.detail).toEqual({ expectedMinor: "10000", gatewayMinor: 1_000 });

    // Untouched: an unexplained amount is not something a job gets to decide.
    expect(await intentStatus(o.intentId)).toBe("created");
    expect(await paymentStatuses(o.orderId)).toEqual(["pending"]);
    expect(await orderPaidEvents(o.orderId)).toBe(0);
  });

  it("refuses to capture when the gateway's currency does not match", async () => {
    const o = await seedStuckIntent({ amountMinor: 10_000 });
    gateway.setStatus(o.gatewayRef, { state: "succeeded", amountMinor: 10_000, currency: "USD" });

    const summary = await reconciler.runOnce(THRESHOLD);

    expect(outcomeFor(summary, o.intentId)?.action).toBe("flagged");
    expect(sink.flagged.filter((f) => f.intentId === o.intentId)[0]!.reason).toBe(
      "currency_mismatch",
    );
    expect(await intentStatus(o.intentId)).toBe("created");
  });

  it("leaves an intent younger than the threshold alone", async () => {
    const o = await seedStuckIntent({ amountMinor: 8_000, age: "30 seconds" });
    gateway.setStatus(o.gatewayRef, { state: "succeeded", amountMinor: 8_000, currency: "AED" });

    const summary = await reconciler.runOnce({ staleAfterSeconds: 900, limit: 500 });

    expect(outcomeFor(summary, o.intentId)).toBeUndefined();
    expect(await intentStatus(o.intentId)).toBe("created");
    expect(await paymentStatuses(o.orderId)).toEqual(["pending"]);
  });

  it("leaves an intent the gateway is still processing alone, without flagging it", async () => {
    const o = await seedStuckIntent({ amountMinor: 2_500 });
    gateway.setStatus(o.gatewayRef, { state: "pending" });

    const summary = await reconciler.runOnce(THRESHOLD);

    expect(outcomeFor(summary, o.intentId)?.action).toBe("left_alone");
    expect(sink.flagged.filter((f) => f.intentId === o.intentId)).toHaveLength(0);
    expect(await intentStatus(o.intentId)).toBe("created");
  });

  it("flags an intent whose gateway does not recognise the reference", async () => {
    const o = await seedStuckIntent({ amountMinor: 6_000 });
    // No setStatus call: the mock reports 'unknown' for refs it never issued.

    const summary = await reconciler.runOnce(THRESHOLD);

    expect(outcomeFor(summary, o.intentId)?.action).toBe("flagged");
    expect(sink.flagged.filter((f) => f.intentId === o.intentId)[0]!.reason).toBe(
      "gateway_unknown",
    );
    expect(await intentStatus(o.intentId)).toBe("created");
  });

  it("flags rather than guesses when the adapter has no status API", async () => {
    const o = await seedStuckIntent({ amountMinor: 1_500 });
    // An adapter for a gateway with no query endpoint: webhooks only.
    const blind: PaymentGatewayPort = {
      key: "mock",
      createIntent: gateway.createIntent.bind(gateway),
      parseWebhook: gateway.parseWebhook.bind(gateway),
    };
    const blindSink = new MemoryExceptionSink();
    const blindReconciler = new PaymentReconciler(
      db.pool,
      new PaymentService(db, new Map([["mock", blind]])),
      blindSink,
    );

    const summary = await blindReconciler.runOnce(THRESHOLD);

    expect(outcomeFor(summary, o.intentId)?.action).toBe("flagged");
    expect(blindSink.flagged.filter((f) => f.intentId === o.intentId)[0]!.reason).toBe(
      "no_status_api",
    );
    expect(await intentStatus(o.intentId)).toBe("created");
  });

  it("retries a repair whose effect failed, and files an exception meanwhile", async () => {
    // "Gateway succeeds but our transaction fails" — the P0 edge case. The
    // dedupe row rolls back with the effect (webhookAtomicity), so the derived
    // idempotency key is still free and the next run genuinely repairs.
    const o = await seedStuckIntent({ amountMinor: 11_000 });
    gateway.setStatus(o.gatewayRef, { state: "succeeded", amountMinor: 11_000, currency: "AED" });

    const brokenSink = new MemoryExceptionSink();
    const broken = new PaymentReconciler(
      db.pool,
      new PaymentService(failAtOutbox(db), new Map([["mock", gateway]])),
      brokenSink,
    );

    const first = await broken.runOnce(THRESHOLD);
    expect(outcomeFor(first, o.intentId)?.action).toBe("flagged");
    expect(brokenSink.flagged.filter((f) => f.intentId === o.intentId)[0]!.reason).toBe(
      "apply_failed",
    );
    expect(await paymentStatuses(o.orderId)).toEqual(["pending"]);
    expect(await reconcileDeliveries(o.gatewayRef)).toBe(0);

    const second = await reconciler.runOnce(THRESHOLD);
    expect(outcomeFor(second, o.intentId)?.action).toBe("captured");
    expect(await paymentStatuses(o.orderId)).toEqual(["captured"]);
    expect(await orderPaidEvents(o.orderId)).toBe(1);
    // The intent recovered, so the earlier exception is closed out.
    expect(sink.resolved.some((r) => r.intentId === o.intentId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Deployment-shaped checks. These self-activate once the R6.2 migration
  // (worker grants + payment_reconciliation_exception) is applied; until then
  // they report why they are skipping rather than failing the suite.
  // -------------------------------------------------------------------------

  it("discovers stuck intents under the worker role the job actually runs as", async (ctx) => {
    if (!(await workerCanReadIntents())) {
      ctx.skip(); // pending the R6.2 grants migration
      return;
    }
    const workerUrl = asRole(ADMIN_URL!, "omniretail_worker", "omniretail_worker_dev");
    const worker = new pg.Pool({ connectionString: workerUrl, max: 2 });
    try {
      const o = await seedStuckIntent({ amountMinor: 4_000 });
      gateway.setStatus(o.gatewayRef, { state: "succeeded", amountMinor: 4_000, currency: "AED" });
      const summary = await new PaymentReconciler(
        worker,
        new PaymentService(new Db(workerUrl), new Map([["mock", gateway]])),
        new MemoryExceptionSink(),
      ).runOnce(THRESHOLD);
      expect(outcomeFor(summary, o.intentId)?.action).toBe("captured");
    } finally {
      await worker.end();
    }
  });

  it("persists an exception the report surface can read", async (ctx) => {
    if (!(await tableExists("payment_reconciliation_exception"))) {
      ctx.skip(); // pending the R6.2 migration
      return;
    }
    const o = await seedStuckIntent({ amountMinor: 3_000 });
    gateway.setStatus(o.gatewayRef, { state: "succeeded", amountMinor: 30, currency: "AED" });
    const pgSink = new PgExceptionSink(db.pool);
    const withPg = new PaymentReconciler(db.pool, payments, pgSink);

    await withPg.runOnce(THRESHOLD);
    await withPg.runOnce(THRESHOLD); // a job on a timer sees the same problem again

    const { rows } = await admin.query<{ reason: string; seen_count: number }>(
      `SELECT reason, seen_count FROM payment_reconciliation_exception
        WHERE intent_id = $1 AND resolved_at IS NULL`,
      [o.intentId],
    );
    // One row, not one per run: the surface must not bury itself.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("amount_mismatch");
    expect(rows[0]!.seen_count).toBe(2);
  });

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /** A pending web order with a live gateway intent whose webhook never came. */
  async function seedStuckIntent(opts: { amountMinor: number; age?: string }) {
    const orderId = randomUUID();
    const intentId = randomUUID();
    const gatewayRef = `rec_${randomUUID()}`;
    const age = opts.age ?? STALE;
    await admin.query(
      `INSERT INTO sales_order (id, tenant_id, order_no, channel_id, location_id, status,
                                currency, total_minor)
       VALUES ($1,$2,$3,$4,$5,'pending','AED',$6)`,
      [orderId, tenantId, `REC-${randomUUID().slice(0, 8)}`, channelId, locationId, opts.amountMinor],
    );
    await admin.query(
      `INSERT INTO payment (id, tenant_id, order_id, method, amount_minor, currency, status)
       VALUES ($1,$2,$3,'gateway',$4,'AED','pending')`,
      [randomUUID(), tenantId, orderId, opts.amountMinor],
    );
    await admin.query(
      `INSERT INTO payment_intent (id, tenant_id, order_id, gateway, gateway_ref,
                                   amount_minor, currency, status, created_at)
       VALUES ($1,$2,$3,'mock',$4,$5,'AED','created', now() - ($6)::interval)`,
      [intentId, tenantId, orderId, gatewayRef, opts.amountMinor, age],
    );
    return { orderId, intentId, gatewayRef };
  }

  function outcomeFor(summary: { outcomes: { intentId: string }[] }, intentId: string) {
    return summary.outcomes.find((o) => o.intentId === intentId) as
      | { intentId: string; action: string; reason?: string }
      | undefined;
  }

  async function intentStatus(intentId: string): Promise<string> {
    const { rows } = await admin.query<{ status: string }>(
      "SELECT status FROM payment_intent WHERE id = $1",
      [intentId],
    );
    return rows[0]!.status;
  }

  async function orderStatus(orderId: string): Promise<string> {
    const { rows } = await admin.query<{ status: string }>(
      "SELECT status FROM sales_order WHERE id = $1",
      [orderId],
    );
    return rows[0]!.status;
  }

  async function paymentStatuses(orderId: string): Promise<string[]> {
    const { rows } = await admin.query<{ status: string }>(
      "SELECT status FROM payment WHERE order_id = $1 ORDER BY created_at",
      [orderId],
    );
    return rows.map((r) => r.status);
  }

  /** Minor units actually captured against the order — the double-spend probe. */
  async function capturedTotalMinor(orderId: string): Promise<bigint> {
    const { rows } = await admin.query<{ total: string | null }>(
      "SELECT sum(amount_minor)::text AS total FROM payment WHERE order_id = $1 AND status = 'captured'",
      [orderId],
    );
    return BigInt(rows[0]!.total ?? "0");
  }

  async function orderPaidEvents(orderId: string): Promise<number> {
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM outbox
        WHERE event_type = 'order.paid' AND payload->>'orderId' = $1`,
      [orderId],
    );
    return Number(rows[0]!.n);
  }

  async function reconcileDeliveries(gatewayRef: string): Promise<number> {
    const { rows } = await admin.query<{ n: string }>(
      "SELECT count(*) AS n FROM webhook_delivery WHERE external_id LIKE $1",
      [`reconcile:mock:${gatewayRef}:%`],
    );
    return Number(rows[0]!.n);
  }

  async function tableExists(name: string): Promise<boolean> {
    const { rows } = await admin.query<{ exists: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [name],
    );
    return rows[0]!.exists;
  }

  async function workerCanReadIntents(): Promise<boolean> {
    const { rows } = await admin.query<{ ok: boolean }>(
      `SELECT has_table_privilege('omniretail_worker','payment_intent','SELECT')
          AND has_table_privilege('omniretail_worker','payment_intent','UPDATE')
          AND has_table_privilege('omniretail_worker','webhook_delivery','INSERT') AS ok`,
    );
    return rows[0]!.ok;
  }
});

/**
 * A Db that parks at the start of the effect transaction. Signals once it is
 * there (so the test knows the stale status has already been read) and waits
 * for the test to let it through.
 */
function gatedDb(real: Db, onEnter: () => void, gate: Promise<void>): Db {
  return {
    pool: real.pool,
    withPlatform: real.withPlatform.bind(real),
    withTenant: async (tid: string, fn: never) => {
      onEnter();
      await gate;
      return real.withTenant(tid, fn as never);
    },
    close: real.close.bind(real),
  } as unknown as Db;
}

/** A Db whose tenant transactions throw when the effect reaches the outbox. */
function failAtOutbox(real: Db): Db {
  return {
    pool: real.pool,
    withPlatform: real.withPlatform.bind(real),
    withTenant: (tid: string, fn: (c: never) => Promise<unknown>) =>
      real.withTenant(tid, (client) =>
        fn({
          ...client,
          query: (text: unknown, params: unknown) => {
            if (typeof text === "string" && text.includes("INSERT INTO outbox")) {
              throw new Error("injected failure after dedupe");
            }
            return (client.query as (t: unknown, p: unknown) => unknown)(text, params);
          },
        } as never),
      ),
    close: real.close.bind(real),
  } as unknown as Db;
}
