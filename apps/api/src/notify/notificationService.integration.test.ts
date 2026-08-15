/**
 * Notification enqueue against real PostgreSQL (R13.1, R13.4, R5.3).
 *
 * The three properties that actually matter and can only be proven here:
 *   * enqueue is idempotent on dedupe_key, so a replayed transaction or
 *     webhook delivers one message;
 *   * enqueue joins the caller's transaction, so a rolled-back order leaves no
 *     orphan message promising a purchase that did not happen;
 *   * RLS keeps one tenant's Messages screen out of another's.
 *
 * Provisioning goes over HTTP against buildPgApp (tenant → warehouse →
 * product → stock → public web order), matching shipping.integration.test.ts.
 * Requires ADMIN_DATABASE_URL and DATABASE_URL; skipped without them.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";
import { Db } from "../db.js";
import { MockCourier } from "../shipping/courierPort.js";
import { ShippingService } from "../shipping/shippingService.js";
import { NotificationError, NotificationService } from "./notificationService.js";
import type { NotificationRequest } from "./templates.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("notification enqueue", () => {
  let app: ReturnType<typeof buildPgApp>;
  let db: Db;
  let notifications: NotificationService;
  let token = "";
  let otherToken = "";
  let tenantId = "";
  let otherTenantId = "";
  let variantId = "";
  let warehouseId = "";
  let ownerUserId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `notify-shop-${suffix}`;
  const otherSlug = `notify-other-${suffix}`;

  const authed = (t = token) => ({ authorization: `Bearer ${t}` });
  const post = (url: string, payload?: unknown, t = token) =>
    app.inject({ method: "POST", url, headers: authed(t), payload: payload as never });

  const placeOrder = async (customer: { name: string; email?: string; phone?: string }, quantity = 1) => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/public/${slug}/orders`,
      payload: { customer, lines: [{ variantId, quantity }] },
    });
    return res;
  };

  /** Any dummy request; the templates themselves are unit-tested elsewhere. */
  const dummyRequest = (orderNo = "INV-TEST"): NotificationRequest => ({
    template: "order_confirmation",
    payload: {
      tenantName: "Notify Shop",
      customerName: "Test Customer",
      orderNo,
      currency: "AED",
      lines: [{ description: "Thing", quantity: 1, totalMinor: 10000 }],
      subtotalMinor: 9524,
      taxMinor: 476,
      totalMinor: 10000,
      vatRateBp: 500,
    },
  });

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    const reg = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        tenantName: "Notify Shop", slug, fullName: "Owner",
        email: `owner@${slug}.test`, password: "correct-horse-battery",
      },
    });
    token = reg.json().accessToken;

    const otherReg = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        tenantName: "Notify Other", slug: otherSlug, fullName: "Owner",
        email: `owner@${otherSlug}.test`, password: "correct-horse-battery",
      },
    });
    otherToken = otherReg.json().accessToken;

    warehouseId = (await post("/v1/locations", { kind: "warehouse", name: "WH", code: "WH" })).json().id;
    const productId = (
      await post("/v1/products", { name: "Kettle", slug: "kettle", tracking: "none" })
    ).json().id;
    variantId = (
      await post(`/v1/products/${productId}/variants`, { sku: "KTL-1", priceMinor: 12000, currency: "AED" })
    ).json().id;
    await post("/v1/inventory/movements", {
      id: randomUUID(), movementType: "receipt", variantId, quantity: 100,
      to: { locationId: warehouseId, state: "on_hand" },
      reference: { type: "grn", id: randomUUID() },
    });

    db = new Db(APP_URL!);
    notifications = new NotificationService(db);
    const ids = await db.withPlatform(async (c) => {
      const { rows } = await c.query<{ id: string; slug: string }>(
        "SELECT id, slug FROM tenant WHERE slug = ANY($1)", [[slug, otherSlug]],
      );
      return rows;
    });
    tenantId = ids.find((r) => r.slug === slug)!.id;
    otherTenantId = ids.find((r) => r.slug === otherSlug)!.id;
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

  // -------------------------------------------------------------------------
  // The wiring: a real order produces a real queued confirmation
  // -------------------------------------------------------------------------

  it("queues an order confirmation when a web order is placed", async () => {
    const res = await placeOrder({ name: "Aisha", email: `aisha@${slug}.test` });
    expect(res.statusCode).toBe(201);
    const { orderId, orderNo } = res.json();

    const queued = await notifications.list(tenantId, { orderId });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      template: "order_confirmation",
      channel: "email",
      recipientKind: "customer",
      recipient: `aisha@${slug}.test`,
      status: "pending",
      attempts: 0,
      locale: "en",
      dedupeKey: `order_confirmation:${orderId}`,
    });
    expect(queued[0]!.subject).toContain(orderNo);

    const detail = await notifications.get(tenantId, queued[0]!.id);
    expect(detail.bodyText).toContain(orderNo);
    expect(detail.bodyText).toContain("AED 120.00");
    expect(detail.bodyHtml).toContain("<table");
    expect(detail.attemptLog).toEqual([]);
  });

  it("does not fail an order that has no email address to notify", async () => {
    const res = await placeOrder({ name: "Basim", phone: `+97150${Date.now() % 10_000_000}` });
    expect(res.statusCode).toBe(201);
    const queued = await notifications.list(tenantId, { orderId: res.json().orderId });
    expect(queued).toEqual([]);
  });

  it("surfaces the tracking number in a dispatch notification (R5.3)", async () => {
    const placed = await placeOrder({ name: "Dana", email: `dana@${slug}.test` }, 2);
    const orderId = placed.json().orderId as string;
    const orderNo = placed.json().orderNo as string;
    expect((await post(`/v1/orders/${orderId}/fulfill`, {})).statusCode).toBe(200);

    const shipping = new ShippingService(db, new Map([["mock", new MockCourier(["handed_over"])]]));
    const shipment = await shipping.createShipment(tenantId, ownerUserId, orderId, {
      courier: "mock",
      address: { line1: "Al Quoz", city: "Dubai", country: "AE" },
    });

    const dispatch = await notifications.list(tenantId, {
      orderId, template: "dispatch_tracking",
    });
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0]!.dedupeKey).toBe(`dispatch_tracking:${shipment.shipmentId}`);
    expect(dispatch[0]!.subject).toContain(shipment.trackingNo);

    const detail = await notifications.get(tenantId, dispatch[0]!.id);
    expect(detail.bodyText).toContain(shipment.trackingNo);
    expect(detail.bodyText).toContain(`MOCK-${orderNo}`);
  });

  // -------------------------------------------------------------------------
  // Idempotency and transactionality
  // -------------------------------------------------------------------------

  it("is idempotent on dedupe_key: the same key enqueues once", async () => {
    const dedupeKey = `test_idempotent:${randomUUID()}`;
    const first = await notifications.enqueue(tenantId, {
      request: dummyRequest(),
      dedupeKey,
      recipient: `dupe@${slug}.test`,
    });
    const second = await notifications.enqueue(tenantId, {
      request: dummyRequest(),
      dedupeKey,
      recipient: `dupe@${slug}.test`,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const rows = await db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ count: string }>(
        "SELECT count(*) AS count FROM notification WHERE dedupe_key = $1", [dedupeKey],
      );
      return Number(rows[0]!.count);
    });
    expect(rows).toBe(1);
  });

  it("enqueues inside the caller's transaction: a rollback leaves nothing", async () => {
    const dedupeKey = `test_rollback:${randomUUID()}`;
    await expect(
      db.withTenant(tenantId, async (c) => {
        await notifications.enqueueWith(c, tenantId, {
          request: dummyRequest(),
          dedupeKey,
          recipient: `rollback@${slug}.test`,
        });
        // Whatever the caller was doing failed after the enqueue.
        throw new Error("caller rolled back");
      }),
    ).rejects.toThrow("caller rolled back");

    const found = await db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query("SELECT 1 FROM notification WHERE dedupe_key = $1", [dedupeKey]);
      return rows.length;
    });
    expect(found).toBe(0);
  });

  it("refuses to queue a message with nowhere to send it", async () => {
    await expect(
      notifications.enqueue(tenantId, {
        request: dummyRequest(),
        dedupeKey: `test_no_recipient:${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "NO_RECIPIENT" });
  });

  it("refuses a channel no transport can deliver", async () => {
    await expect(
      notifications.enqueue(tenantId, {
        request: dummyRequest(),
        dedupeKey: `test_channel:${randomUUID()}`,
        recipient: "+971500000000",
        channel: "whatsapp",
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CHANNEL" });
  });

  // -------------------------------------------------------------------------
  // R13.4 — locale resolution
  // -------------------------------------------------------------------------

  describe("locale resolution (R13.4)", () => {
    const makeCustomer = async (locale: string | null): Promise<string> => {
      const id = randomUUID();
      await db.withTenant(tenantId, (c) =>
        c.query(
          "INSERT INTO customer (id, tenant_id, full_name, email, locale) VALUES ($1,$2,$3,$4,$5)",
          [id, tenantId, "Locale Test", `locale-${id.slice(0, 8)}@${slug}.test`, locale],
        ),
      );
      return id;
    };

    const setTenantDefault = (locale: string) =>
      db.withPlatform((c) =>
        c.query("UPDATE tenant SET default_locale = $2 WHERE id = $1", [tenantId, locale]),
      );

    it("uses the customer's stated language", async () => {
      await setTenantDefault("en");
      const customerId = await makeCustomer("ar");
      const { id } = await notifications.enqueue(tenantId, {
        request: dummyRequest(),
        dedupeKey: `test_locale_ar:${customerId}`,
        customerId,
      });
      const detail = await notifications.get(tenantId, id);
      expect(detail.locale).toBe("ar");
      expect(detail.bodyText).toMatch(/[؀-ۿ]/);
    });

    it("falls back to the tenant default when the customer never stated one", async () => {
      await setTenantDefault("ar");
      const customerId = await makeCustomer(null);
      const { id } = await notifications.enqueue(tenantId, {
        request: dummyRequest(),
        dedupeKey: `test_locale_default:${customerId}`,
        customerId,
      });
      expect((await notifications.get(tenantId, id)).locale).toBe("ar");
    });

    it("an explicit customer 'en' beats an Arabic tenant default", async () => {
      await setTenantDefault("ar");
      const customerId = await makeCustomer("en");
      const { id } = await notifications.enqueue(tenantId, {
        request: dummyRequest(),
        dedupeKey: `test_locale_explicit:${customerId}`,
        customerId,
      });
      const detail = await notifications.get(tenantId, id);
      expect(detail.locale).toBe("en");
      expect(detail.bodyText).not.toMatch(/[؀-ۿ]/);
      await setTenantDefault("en");
    });
  });

  // -------------------------------------------------------------------------
  // Messages screen: list, resend, cancel
  // -------------------------------------------------------------------------

  describe("the Messages screen", () => {
    let bouncedId = "";

    beforeAll(async () => {
      const enqueued = await notifications.enqueue(tenantId, {
        request: dummyRequest("INV-BOUNCE"),
        dedupeKey: `test_bounced:${randomUUID()}`,
        recipient: `typo@${slug}.tset`,
      });
      bouncedId = enqueued.id;
      // Simulate what the delivery worker would have written.
      await db.withTenant(tenantId, (c) =>
        c.query(
          `UPDATE notification
              SET status = 'bounced', attempts = 1, failed_at = now(),
                  last_error = '550 5.1.1 user unknown', updated_at = now()
            WHERE id = $1`,
          [bouncedId],
        ),
      );
    });

    it("filters by status so bounces are findable (R13.1)", async () => {
      const bounced = await notifications.list(tenantId, { status: ["bounced"] });
      expect(bounced.map((n) => n.id)).toContain(bouncedId);
      expect(bounced.every((n) => n.status === "bounced")).toBe(true);
      expect(bounced.find((n) => n.id === bouncedId)!.lastError).toContain("550");
    });

    it("resends as a NEW row, preserving the bounce in history", async () => {
      const resent = await notifications.resend(tenantId, bouncedId, {
        recipient: `typo@${slug}.test`,
      });
      expect(resent.id).not.toBe(bouncedId);

      const fresh = await notifications.get(tenantId, resent.id);
      expect(fresh.status).toBe("pending");
      expect(fresh.attempts).toBe(0);
      expect(fresh.recipient).toBe(`typo@${slug}.test`);
      // Same content: a resend delivers what the customer was originally told.
      const original = await notifications.get(tenantId, bouncedId);
      expect(fresh.bodyText).toBe(original.bodyText);
      expect(fresh.subject).toBe(original.subject);
      expect(fresh.dedupeKey).toBe(`${original.dedupeKey}#resend:${resent.id}`);
      // The original is untouched — the bounce is still on the record.
      expect(original.status).toBe("bounced");
    });

    it("can resend the same row twice without a dedupe collision", async () => {
      const again = await notifications.resend(tenantId, bouncedId);
      expect(again.id).toBeTruthy();
      const all = await notifications.list(tenantId, { status: ["pending"] });
      expect(all.filter((n) => n.dedupeKey.includes("#resend:")).length).toBeGreaterThanOrEqual(2);
    });

    it("refuses to resend something already queued", async () => {
      const queued = await notifications.enqueue(tenantId, {
        request: dummyRequest(),
        dedupeKey: `test_pending:${randomUUID()}`,
        recipient: `pending@${slug}.test`,
      });
      await expect(notifications.resend(tenantId, queued.id)).rejects.toMatchObject({
        code: "NOT_RESENDABLE",
      });
    });

    it("cancels a pending message and refuses to cancel a sent one", async () => {
      const queued = await notifications.enqueue(tenantId, {
        request: dummyRequest(),
        dedupeKey: `test_cancel:${randomUUID()}`,
        recipient: `cancel@${slug}.test`,
      });
      expect(await notifications.cancel(tenantId, queued.id)).toMatchObject({ status: "cancelled" });
      expect((await notifications.get(tenantId, queued.id)).status).toBe("cancelled");

      const sent = await notifications.enqueue(tenantId, {
        request: dummyRequest(),
        dedupeKey: `test_sent:${randomUUID()}`,
        recipient: `sent@${slug}.test`,
      });
      await db.withTenant(tenantId, (c) =>
        c.query(
          "UPDATE notification SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1",
          [sent.id],
        ),
      );
      await expect(notifications.cancel(tenantId, sent.id)).rejects.toMatchObject({
        code: "NOT_CANCELLABLE",
      });
    });

    it("404s an unknown id rather than returning an empty shell", async () => {
      await expect(notifications.get(tenantId, randomUUID())).rejects.toBeInstanceOf(
        NotificationError,
      );
      await expect(notifications.get(tenantId, randomUUID())).rejects.toMatchObject({
        code: "NOTIFICATION_NOT_FOUND",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Isolation
  // -------------------------------------------------------------------------

  it("keeps one tenant's messages out of another's Messages screen", async () => {
    const mine = await notifications.list(tenantId, {});
    expect(mine.length).toBeGreaterThan(0);

    const theirs = await notifications.list(otherTenantId, {});
    expect(theirs.map((n) => n.id)).not.toContain(mine[0]!.id);

    // And a direct read by id across the boundary finds nothing at all.
    await expect(notifications.get(otherTenantId, mine[0]!.id)).rejects.toMatchObject({
      code: "NOTIFICATION_NOT_FOUND",
    });
    expect(otherToken).toBeTruthy();
  });
});
