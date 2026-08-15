/**
 * Webhook dedupe and effect must commit together (real PostgreSQL).
 *
 * The dedupe row was written in its own transaction *before* the state change
 * ran in a separate one. Any failure in between — a crash, a lost connection, a
 * constraint violation downstream — left the delivery recorded as processed
 * while the payment was never applied. The gateway's retry then hit
 * `ON CONFLICT DO NOTHING`, saw `duplicate: true`, and the money was gone with
 * no error anywhere. These tests pin the atomicity that prevents it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { Db } from "../db.js";
import { PaymentService } from "./paymentService.js";
import { MockGateway } from "./gatewayPort.js";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("webhook dedupe is atomic with its effect", () => {
  let app: ReturnType<typeof buildPgApp>;
  let db: Db;
  let payments: PaymentService;
  let ownerToken = "";
  let tenantId = "";
  let locationId = "";
  let variantId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `wh-shop-${suffix}`;

  const authed = () => ({ authorization: `Bearer ${ownerToken}` });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });

  const deliveryCount = (externalId: string) =>
    db.withPlatform(async (c) => {
      const { rows } = await c.query<{ n: string }>(
        "SELECT count(*) AS n FROM webhook_delivery WHERE external_id = $1",
        [externalId],
      );
      return Number(rows[0]!.n);
    });

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    db = new Db(APP_URL!);
    payments = new PaymentService(db, [new MockGateway("mock-webhook-secret-0123456789")]);

    ownerToken = (
      await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        payload: {
          tenantName: "Webhook Shop",
          slug,
          fullName: "Owner",
          email: `owner@${slug}.test`,
          password: "correct-horse-battery",
        },
      })
    ).json().accessToken;

    locationId = (
      await post("/v1/locations", { kind: "store", name: "Naif", code: "NAIF" })
    ).json().id;
    const productId = (
      await post("/v1/products", { name: "Cable", slug: `cable-${suffix}`, tracking: "none" })
    ).json().id;
    variantId = (
      await post(`/v1/products/${productId}/variants`, {
        sku: `CB-${suffix}`,
        priceMinor: 10000,
        currency: "AED",
      })
    ).json().id;
    await post("/v1/inventory/receipts", { locationId, lines: [{ variantId, quantity: 20 }] });

    tenantId = await db.withPlatform(async (c) => {
      const { rows } = await c.query<{ id: string }>("SELECT id FROM tenant WHERE slug = $1", [slug]);
      return rows[0]!.id;
    });
  }, 30_000);

  afterAll(async () => {
    await db?.close();
    await app?.close();
  });

  it("does not record a delivery for an event whose intent is unknown", async () => {
    // Regression: recording it would make the gateway's retry a no-op, so a
    // webhook that outran its own intent's commit could never be applied.
    const externalId = `evt-unknown-${randomUUID()}`;
    const res = await payments.applyWebhook(
      "mock",
      { externalId, gatewayRef: `ref-nonexistent-${suffix}`, type: "payment.succeeded" },
      "{}",
    );
    expect(res.result).toBe("intent_not_found");
    expect(await deliveryCount(externalId)).toBe(0);
  });

  it("applies the effect and records the delivery together", async () => {
    const { gatewayRef, externalId } = await seedIntent();

    const res = await payments.applyWebhook(
      "mock",
      { externalId, gatewayRef, type: "payment.succeeded" },
      "{}",
    );
    expect(res.result).toBe("captured");
    expect(await deliveryCount(externalId)).toBe(1);
    expect(await intentStatus(gatewayRef)).toBe("succeeded");
  });

  it("treats a genuine replay as a duplicate and changes nothing", async () => {
    const { gatewayRef, externalId } = await seedIntent();
    await payments.applyWebhook("mock", { externalId, gatewayRef, type: "payment.succeeded" }, "{}");

    const replay = await payments.applyWebhook(
      "mock",
      { externalId, gatewayRef, type: "payment.succeeded" },
      "{}",
    );
    expect(replay.duplicate).toBe(true);
    expect(await deliveryCount(externalId)).toBe(1);
  });

  it("rolls the delivery back when the effect fails, so a retry still works", async () => {
    // The property that was broken. Fail the effect *after* the dedupe insert
    // has run, then assert the delivery row did not survive — if it did, the
    // gateway's retry would return `duplicate: true` and the payment would be
    // lost silently. The failure is injected at the outbox write, the last
    // statement of the effect, so the dedupe row is already in the transaction.
    const { gatewayRef, externalId } = await seedIntent();

    const failing = new PaymentService(failAtOutbox(db), [
      new MockGateway("mock-webhook-secret-0123456789"),
    ]);

    await expect(
      failing.applyWebhook("mock", { externalId, gatewayRef, type: "payment.succeeded" }, "{}"),
    ).rejects.toThrow(/injected/);

    expect(await deliveryCount(externalId)).toBe(0);

    // ...and the retry, against the healthy service, still applies it.
    const retry = await payments.applyWebhook(
      "mock",
      { externalId, gatewayRef, type: "payment.succeeded" },
      "{}",
    );
    expect(retry.result).toBe("captured");
    expect(await intentStatus(gatewayRef)).toBe("succeeded");
  });

  /** A Db whose tenant transactions throw when the effect reaches the outbox. */
  function failAtOutbox(real: Db): Db {
    return {
      ...real,
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
    } as unknown as Db;
  }

  /** A confirmed order with a live gateway intent, ready to be paid by webhook. */
  async function seedIntent(): Promise<{ gatewayRef: string; externalId: string; orderId: string }> {
    const orderId = randomUUID();
    const gatewayRef = `ref-${randomUUID()}`;
    await db.withTenant(tenantId, async (c) => {
      // A gateway payment is a web order. A `pos` channel would trip
      // enforce_pos_attribution, which demands a cashier and a till.
      const { rows: ch } = await c.query<{ id: string }>(
        "SELECT id FROM channel WHERE kind <> 'pos' LIMIT 1",
      );
      await c.query(
        `INSERT INTO sales_order (id, tenant_id, channel_id, order_no, status, currency,
                                  subtotal_minor, discount_minor, tax_minor, total_minor,
                                  location_id, placed_at)
         VALUES ($1,$2,$3,$4,'pending','AED',10000,0,0,10000,$5, now())`,
        [orderId, tenantId, ch[0]!.id, `WH-${randomUUID().slice(0, 8)}`, locationId],
      );
      await c.query(
        `INSERT INTO payment (id, tenant_id, order_id, method, amount_minor, currency, status)
         VALUES ($1,$2,$3,'gateway',10000,'AED','pending')`,
        [randomUUID(), tenantId, orderId],
      );
      await c.query(
        `INSERT INTO payment_intent (id, tenant_id, order_id, gateway, gateway_ref,
                                     amount_minor, currency, status)
         VALUES ($1,$2,$3,'mock',$4,10000,'AED','created')`,
        [randomUUID(), tenantId, orderId, gatewayRef],
      );
    });
    return { gatewayRef, externalId: `evt-${randomUUID()}`, orderId };
  }

  function intentStatus(gatewayRef: string): Promise<string> {
    return db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ status: string }>(
        "SELECT status FROM payment_intent WHERE gateway_ref = $1",
        [gatewayRef],
      );
      return rows[0]!.status;
    });
  }
});
