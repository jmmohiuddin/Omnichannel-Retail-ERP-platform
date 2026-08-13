/**
 * Product event instrumentation against real PostgreSQL (R12.1, R12.2):
 * the write path, tenant isolation by RLS, database-level append-only, and
 * funnel counts with real step ordering.
 *
 * Requires: ADMIN_DATABASE_URL (schema owner, runs migrations) and
 * DATABASE_URL (omniretail_app runtime role — RLS applies). Skipped when unset.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { Db } from "../db.js";
import { buildPgApp } from "../pgApp.js";
import { EventService, type ProductEvent } from "./eventService.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("product event instrumentation", () => {
  let app: ReturnType<typeof buildPgApp>;
  let db: Db;
  let events: EventService;
  // A: write/immutability, B: the tenant that must see none of A's events,
  // C/D: isolated tenants so funnel counts are exact.
  let tenantA = "";
  let tenantB = "";
  let tenantC = "";
  let tenantD = "";
  const suffix = randomUUID().slice(0, 8);

  const register = async (name: string): Promise<string> => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        tenantName: `Events ${name}`,
        slug: `events-${name}-${suffix}`,
        fullName: "Owner",
        email: `owner@events-${name}-${suffix}.test`,
        password: "correct-horse-battery",
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().tenantId as string;
  };

  /** Minimal web order: the post-order funnel keys on a real order_id (FK). */
  const createOrder = async (tenantId: string, orderNo: string): Promise<string> => {
    const id = randomUUID();
    await db.withTenant(tenantId, (c) =>
      c.query(
        `INSERT INTO sales_order (id, tenant_id, order_no, channel_id, currency, total_minor)
         SELECT $1, $2, $3, ch.id, 'AED', 10000
           FROM channel ch WHERE ch.kind = 'web' LIMIT 1`,
        [id, tenantId, orderNo],
      ),
    );
    return id;
  };

  const session = (tenantId: string, sessionId: string, names: ProductEvent[]) =>
    events.recordMany(
      tenantId,
      names.map((e) => ({ sessionId, ...e })),
    );

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    db = new Db(APP_URL!);
    events = new EventService(db);
    tenantA = await register("a");
    tenantB = await register("b");
    tenantC = await register("c");
    tenantD = await register("d");
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  // -------------------------------------------------------------------------
  // (a) written and readable
  // -------------------------------------------------------------------------
  it("records an event and reads it back with its props", async () => {
    await events.record(tenantA, {
      name: "product_viewed",
      sessionId: `sess-${suffix}`,
      props: { variantId: "v-1", source: "search" },
    });

    const rows = await db.withTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT name, session_id, props, occurred_at
           FROM product_event WHERE session_id = $1`,
        [`sess-${suffix}`],
      );
      return rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "product_viewed",
      session_id: `sess-${suffix}`,
      props: { variantId: "v-1", source: "search" },
    });
    expect(rows[0].occurred_at).toBeInstanceOf(Date);

    const { counts } = await events.counts(tenantA);
    expect(counts.product_viewed).toBe(1);
  });

  it("refuses an event name the database does not know", async () => {
    await expect(
      db.withTenant(tenantA, (c) =>
        c.query(
          `INSERT INTO product_event (tenant_id, name, session_id)
           VALUES ($1, 'produkt_viewed', 'typo')`,
          [tenantA],
        ),
      ),
    ).rejects.toThrow(/product_event_name_check|violates check constraint/);
  });

  it("recordWith joins the caller's transaction and rolls back with it", async () => {
    const sessionId = `rollback-${suffix}`;
    await expect(
      db.withTenant(tenantA, async (c) => {
        await events.recordWith(c, tenantA, { name: "add_to_cart", sessionId });
        throw new Error("caller failed after the event");
      }),
    ).rejects.toThrow("caller failed after the event");

    const rows = await db.withTenant(tenantA, async (c) => {
      const { rows } = await c.query("SELECT 1 FROM product_event WHERE session_id = $1", [
        sessionId,
      ]);
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("ignores a replayed event id so an offline batch cannot double-count", async () => {
    const id = randomUUID();
    const event: ProductEvent = { id, name: "pos_sale", sessionId: `replay-${suffix}` };
    await events.recordMany(tenantA, [event]);
    await events.recordMany(tenantA, [event]);

    const rows = await db.withTenant(tenantA, async (c) => {
      const { rows } = await c.query("SELECT id FROM product_event WHERE id = $1", [id]);
      return rows;
    });
    expect(rows).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // (b) RLS isolation
  // -------------------------------------------------------------------------
  it("row-level security: tenant B sees none of tenant A's events", async () => {
    await events.record(tenantB, { name: "product_viewed", sessionId: `b-own-${suffix}` });

    const visible = await db.withTenant(tenantB, async (c) => {
      const { rows } = await c.query<{ session_id: string }>(
        "SELECT session_id FROM product_event ORDER BY seq",
      );
      return rows.map((r) => r.session_id);
    });
    expect(visible).toEqual([`b-own-${suffix}`]);
    expect(visible).not.toContain(`sess-${suffix}`);

    const { counts } = await events.counts(tenantB);
    expect(counts).toEqual({ product_viewed: 1 });
  });

  it("row-level security: a tenant cannot write an event into another tenant", async () => {
    await expect(
      db.withTenant(tenantB, (c) =>
        c.query(
          `INSERT INTO product_event (tenant_id, name, session_id)
           VALUES ($1, 'product_viewed', 'smuggled')`,
          [tenantA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // -------------------------------------------------------------------------
  // (c) append-only
  // -------------------------------------------------------------------------
  it("append-only: UPDATE and DELETE are rejected by the database", async () => {
    const sessionId = `immutable-${suffix}`;
    await events.record(tenantA, { name: "checkout_failed", sessionId });

    await expect(
      db.withTenant(tenantA, (c) =>
        c.query("UPDATE product_event SET name = 'order_placed' WHERE session_id = $1", [
          sessionId,
        ]),
      ),
    ).rejects.toThrow(/product_event rows are immutable/);

    await expect(
      db.withTenant(tenantA, (c) =>
        c.query("DELETE FROM product_event WHERE session_id = $1", [sessionId]),
      ),
    ).rejects.toThrow(/product_event rows are immutable/);

    const still = await db.withTenant(tenantA, async (c) => {
      const { rows } = await c.query<{ name: string }>(
        "SELECT name FROM product_event WHERE session_id = $1",
        [sessionId],
      );
      return rows;
    });
    expect(still).toEqual([{ name: "checkout_failed" }]);
  });

  // -------------------------------------------------------------------------
  // (d) funnels
  // -------------------------------------------------------------------------
  it("browse funnel: home→PDP→cart→checkout→order counts each step in order", async () => {
    // Completes the whole funnel.
    await session(tenantC, `c-full-${suffix}`, [
      { name: "page_viewed", props: { page: "home" } },
      { name: "product_viewed" },
      { name: "add_to_cart" },
      { name: "checkout_started" },
      { name: "order_placed" },
    ]);
    // Abandons at the cart.
    await session(tenantC, `c-cart-${suffix}`, [
      { name: "page_viewed", props: { page: "home" } },
      { name: "product_viewed" },
      { name: "add_to_cart" },
    ]);
    // Bounces on the home page.
    await session(tenantC, `c-bounce-${suffix}`, [
      { name: "page_viewed", props: { page: "home" } },
    ]);
    // Out of order: the cart event precedes the PDP view, so it must not count
    // as a completed cart step (this is what distinguishes a funnel from a
    // per-event tally).
    await session(tenantC, `c-jumbled-${suffix}`, [
      { name: "page_viewed", props: { page: "home" } },
      { name: "add_to_cart" },
      { name: "product_viewed" },
    ]);
    // Never saw the home page: cannot enter the funnel at all.
    await session(tenantC, `c-deeplink-${suffix}`, [
      { name: "product_viewed" },
      { name: "add_to_cart" },
    ]);

    const result = await events.presetFunnel(tenantC, "browse");
    expect(result.key).toBe("session_id");
    expect(result.steps.map((s) => [s.label, s.count])).toEqual([
      ["home", 4],
      ["pdp", 3],
      ["cart", 2],
      ["checkout", 1],
      ["order", 1],
    ]);
    expect(result.steps[0].conversionFromPrevious).toBeNull();
    expect(result.steps[1].conversionFromPrevious).toBeCloseTo(0.75);
    expect(result.steps[4].conversionFromStart).toBeCloseTo(0.25);
  });

  it("search funnel: only a PDP view attributed to search counts as the click", async () => {
    await session(tenantD, `d-search-${suffix}`, [
      { name: "search_performed", props: { q: "iphone" } },
      { name: "product_viewed", props: { source: "search" } },
      { name: "add_to_cart" },
    ]);
    await session(tenantD, `d-browse-${suffix}`, [
      { name: "search_performed", props: { q: "iphone" } },
      { name: "product_viewed", props: { source: "category" } },
      { name: "add_to_cart" },
    ]);

    const result = await events.presetFunnel(tenantD, "search");
    expect(result.steps.map((s) => [s.label, s.count])).toEqual([
      ["search", 2],
      ["click", 1],
      ["cart", 1],
    ]);
  });

  it("post-order funnel: placed→confirmed→tracked correlates by order id", async () => {
    const tracked = await createOrder(tenantD, `EV-${suffix}-1`);
    const confirmedOnly = await createOrder(tenantD, `EV-${suffix}-2`);

    await events.recordMany(tenantD, [
      { name: "order_placed", orderId: tracked },
      { name: "confirmation_delivered", orderId: tracked },
      { name: "order_tracked", orderId: tracked },
      { name: "order_placed", orderId: confirmedOnly },
      { name: "confirmation_delivered", orderId: confirmedOnly },
    ]);

    const result = await events.presetFunnel(tenantD, "post_order");
    expect(result.key).toBe("order_id");
    expect(result.steps.map((s) => [s.label, s.count])).toEqual([
      ["placed", 2],
      ["confirmed", 2],
      ["tracked", 1],
    ]);
  });

  it("funnel windows exclude events outside the range", async () => {
    const past = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const inWindow = await events.presetFunnel(tenantD, "search", {
      fromIso: past,
      toIso: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(inWindow.steps[0].count).toBe(2);

    const ancient = await events.presetFunnel(tenantD, "search", {
      fromIso: past,
      toIso: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(ancient.steps.map((s) => s.count)).toEqual([0, 0, 0]);
  });

  it("ad-hoc funnels accept any ordered pair of known events", async () => {
    const result = await events.funnel(tenantC, {
      steps: [
        { event: "product_viewed", label: "viewed" },
        { event: "order_placed", label: "bought" },
      ],
    });
    expect(result.steps.map((s) => [s.label, s.count])).toEqual([
      ["viewed", 4],
      ["bought", 1],
    ]);
  });
});
