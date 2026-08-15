/**
 * R10.7 — the warranty clock extends by repair downtime, on real PostgreSQL.
 *
 * Cabinet Decision 66/2023 Art. 19: warranty runs from receipt of the good and
 * is extended by any period the customer could not use it. `repair_in` used to
 * set the unit back to `in_stock` and stop, which silently shortened every
 * repaired unit's cover by exactly the time it spent in the workshop — the
 * customer's loss, and the shop's liability when they come back on day 366.
 *
 * The downtime is read from the append-only ledger. These tests therefore
 * back-date the repair through the API's own `occurredAt` — the ledger's
 * immutability trigger rejects an UPDATE to a movement row, which is the
 * system working correctly and is why the timestamp has to be right on the
 * way in rather than fixable afterwards.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { Db } from "../db.js";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("warranty clock (R10.7)", () => {
  let app: ReturnType<typeof buildPgApp>;
  let db: Db;
  let ownerToken = "";
  let tenantId = "";
  let locationId = "";
  let variantId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `warranty-shop-${suffix}`;

  const authed = () => ({ authorization: `Bearer ${ownerToken}` });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    db = new Db(APP_URL!);

    ownerToken = (
      await app.inject({
        method: "POST", url: "/v1/auth/register",
        payload: {
          tenantName: "Warranty Shop", slug, fullName: "Owner",
          email: `owner@${slug}.test`, password: "correct-horse-battery",
        },
      })
    ).json().accessToken;

    locationId = (
      await post("/v1/locations", { kind: "store", name: "Shop", code: "S1" })
    ).json().id;
    const productId = (
      await post("/v1/products", {
        name: "Phone W", slug: `phone-w-${suffix}`, tracking: "serialized",
      })
    ).json().id;
    variantId = (
      await post(`/v1/products/${productId}/variants`, {
        sku: `PW-${suffix}`, priceMinor: 210000, currency: "AED", warrantyMonths: 12,
      })
    ).json().id;

    tenantId = await db.withPlatform(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM tenant WHERE slug = $1", [slug],
      );
      return rows[0]!.id;
    });
  }, 30_000);

  afterAll(async () => {
    await db?.close();
    await app?.close();
  });

  /** Receive a unit, give it a warranty date, and send it out for repair. */
  const unitOutForRepair = async (
    imei: string,
    warrantyUntil: string | null,
    daysAgo: number,
  ): Promise<string> => {
    const unitId = (
      await post("/v1/inventory/receipts", {
        locationId, lines: [{ variantId, units: [{ imei1: imei }] }],
      })
    ).json().unitIds[0];

    await db.withTenant(tenantId, (c) =>
      c.query("UPDATE stock_unit SET warranty_until = $2 WHERE id = $1",
        [unitId, warrantyUntil]),
    );

    // The unit left the shop `daysAgo` days ago. Recorded on the way in,
    // because the ledger is append-only and will not let it be corrected
    // afterwards.
    const out = await post(`/v1/stock-units/${unitId}/repair-out`, {
      note: "screen",
      occurredAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    });
    expect(out.statusCode).toBeLessThan(300);
    return unitId;
  };

  const warrantyOf = async (unitId: string): Promise<Date | null> =>
    db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ warranty_until: Date | null }>(
        "SELECT warranty_until FROM stock_unit WHERE id = $1", [unitId],
      );
      return rows[0]!.warranty_until;
    });

  const daysBetween = (a: Date, b: Date): number =>
    Math.round((a.getTime() - b.getTime()) / 86_400_000);

  it("extends the warranty by the days the customer could not use the handset", async () => {
    const before = new Date();
    before.setDate(before.getDate() + 300);
    const warrantyUntil = before.toISOString().slice(0, 10);
    const unitId = await unitOutForRepair("352099001761481", warrantyUntil, 14);

    const inRes = await post(`/v1/stock-units/${unitId}/repair-in`, { note: "screen replaced" });
    expect(inRes.statusCode).toBeLessThan(300);

    const after = await warrantyOf(unitId);
    expect(after).not.toBeNull();
    // 14 days in the workshop → 14 days more cover. Compared against the
    // midnight-truncated seed date, not `before` itself — that date-only
    // string is what actually landed in warranty_until, so comparing
    // against `before`'s own time-of-day skews the result by whatever
    // fraction of a day `before` happened to fall on.
    expect(daysBetween(after!, new Date(warrantyUntil))).toBe(14);
  });

  it("leaves a unit with no warranty alone rather than inventing one", async () => {
    const unitId = await unitOutForRepair("356938035643809", null, 30);

    await post(`/v1/stock-units/${unitId}/repair-in`, {});

    // A unit sold with no warranty does not acquire one by being repaired.
    expect(await warrantyOf(unitId)).toBeNull();
  });

  it("rounds a part-day of downtime up to a whole day", async () => {
    const before = new Date();
    before.setDate(before.getDate() + 100);
    const warrantyUntil = before.toISOString().slice(0, 10);
    const unitId = await unitOutForRepair("490154203237518", warrantyUntil, 0);

    await post(`/v1/stock-units/${unitId}/repair-in`, {});

    // Out and back within the same day: the customer still lost that day's
    // use, so the cover moves by one day, never by zero. Compared against
    // the midnight-truncated seed date — see the first test above.
    const after = await warrantyOf(unitId);
    expect(daysBetween(after!, new Date(warrantyUntil))).toBe(1);
  });

  it("compounds across repeated repairs", async () => {
    const before = new Date();
    before.setDate(before.getDate() + 200);
    const warrantyUntil = before.toISOString().slice(0, 10);
    const unitId = await unitOutForRepair("358240051111110", warrantyUntil, 10);
    await post(`/v1/stock-units/${unitId}/repair-in`, {});

    // Straight back out again — the same fault, a second visit, five days.
    await post(`/v1/stock-units/${unitId}/repair-out`, {
      note: "same fault again",
      occurredAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });
    await post(`/v1/stock-units/${unitId}/repair-in`, {});

    // 10 days, then 5 more. Each repair extends from wherever the last left
    // the clock, so downtime accumulates. Compared against the
    // midnight-truncated seed date — see the first test above.
    const after = await warrantyOf(unitId);
    expect(daysBetween(after!, new Date(warrantyUntil))).toBe(15);
  });
});
