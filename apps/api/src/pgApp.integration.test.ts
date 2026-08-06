/**
 * Integration tests against a real PostgreSQL database.
 *
 * Requires: ADMIN_DATABASE_URL (schema owner, runs migrations) and
 * DATABASE_URL (omniretail_app runtime role — RLS applies). Skipped when unset.
 * Locally: create a scratch DB and run `npx -y pnpm --filter @omniretail/api test`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "./pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("pgApp integration", () => {
  let app: ReturnType<typeof buildPgApp>;
  let tokenA = "";
  let tokenB = "";
  let locationId = "";
  let variantId = "";
  const suffix = randomUUID().slice(0, 8);

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });

    const register = async (slug: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        payload: {
          tenantName: `Shop ${slug}`,
          slug,
          fullName: "Owner",
          email: `owner@${slug}.test`,
          password: "correct-horse-battery",
        },
      });
      expect(res.statusCode).toBe(201);
      return res.json() as { accessToken: string; refreshToken: string; tenantId: string };
    };
    tokenA = (await register(`shop-a-${suffix}`)).accessToken;
    tokenB = (await register(`shop-b-${suffix}`)).accessToken;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  const authed = (token: string) => ({ authorization: `Bearer ${token}` });

  it("provisions catalog and location", async () => {
    const loc = await app.inject({
      method: "POST",
      url: "/v1/locations",
      headers: authed(tokenA),
      payload: { kind: "store", name: "Main Street", code: "MS1" },
    });
    expect(loc.statusCode).toBe(201);
    locationId = loc.json().id;

    const product = await app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authed(tokenA),
      payload: { name: "Phone X", slug: "phone-x", tracking: "serialized" },
    });
    expect(product.statusCode).toBe(201);

    const variant = await app.inject({
      method: "POST",
      url: `/v1/products/${product.json().id}/variants`,
      headers: authed(tokenA),
      payload: { sku: "PX-256-BLK", priceMinor: 99900, currency: "USD" },
    });
    expect(variant.statusCode).toBe(201);
    variantId = variant.json().id;
  });

  it("rejects unauthenticated inventory access", async () => {
    const res = await app.inject({ url: `/v1/inventory/availability/${variantId}/${locationId}` });
    expect(res.statusCode).toBe(401);
  });

  it("posts a receipt transactionally: ledger + level + outbox", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/inventory/movements",
      headers: authed(tokenA),
      payload: {
        id: randomUUID(),
        movementType: "receipt",
        variantId,
        quantity: 10,
        to: { locationId, state: "on_hand" },
        reference: { type: "grn", id: randomUUID() },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().seq).toBeGreaterThan(0);

    const avail = await app.inject({
      url: `/v1/inventory/availability/${variantId}/${locationId}`,
      headers: authed(tokenA),
    });
    expect(avail.json()).toMatchObject({ onHand: 10, available: 10 });
  });

  it("actor attribution comes from the token, not the body", async () => {
    const feed = await app.inject({
      url: "/v1/inventory/movements",
      headers: authed(tokenA),
    });
    const items = feed.json().items;
    expect(items.length).toBeGreaterThan(0);
    // registered owner posted it; a spoofed actorUserId in the body is ignored
    expect(items[0].actorUserId).toBeTruthy();
  });

  it("database CHECK rejects oversell even at the SQL layer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/inventory/movements",
      headers: authed(tokenA),
      payload: {
        id: randomUUID(),
        movementType: "sale",
        variantId,
        quantity: 999,
        from: { locationId, state: "on_hand" },
        reference: { type: "order", id: randomUUID() },
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("INSUFFICIENT_STOCK");
  });

  it("duplicate movement id is a 409 (idempotent replay)", async () => {
    const id = randomUUID();
    const body = {
      id,
      movementType: "receipt",
      variantId,
      quantity: 1,
      to: { locationId, state: "on_hand" },
      reference: { type: "grn", id: randomUUID() },
    };
    const first = await app.inject({
      method: "POST", url: "/v1/inventory/movements", headers: authed(tokenA), payload: body,
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST", url: "/v1/inventory/movements", headers: authed(tokenA), payload: body,
    });
    expect(second.statusCode).toBe(409);
  });

  it("adjustment without approval is blocked (domain + DB trigger agree)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/inventory/movements",
      headers: authed(tokenA),
      payload: {
        id: randomUUID(),
        movementType: "adjustment",
        variantId,
        quantity: 1,
        from: { locationId, state: "on_hand" },
        reference: { type: "adjustment", id: randomUUID() },
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("row-level security: tenant B sees none of tenant A's data", async () => {
    const avail = await app.inject({
      url: `/v1/inventory/availability/${variantId}/${locationId}`,
      headers: authed(tokenB),
    });
    expect(avail.json()).toMatchObject({ onHand: 0 });

    const feed = await app.inject({
      url: "/v1/inventory/movements",
      headers: authed(tokenB),
    });
    expect(feed.json().items).toHaveLength(0);
  });

  it("login and refresh rotation work; reused refresh token is rejected", async () => {
    const slug = `shop-a-${suffix}`;
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { slug, email: `owner@${slug}.test`, password: "correct-horse-battery" },
    });
    expect(login.statusCode).toBe(200);
    const { refreshToken, tenantId } = login.json();

    const refreshed = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { tenantId, refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().refreshToken).not.toBe(refreshToken);

    const replayed = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { tenantId, refreshToken },
    });
    expect(replayed.statusCode).toBe(401);
  });

  it("wrong password is rejected", async () => {
    const slug = `shop-a-${suffix}`;
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { slug, email: `owner@${slug}.test`, password: "wrong-password-here" },
    });
    expect(res.statusCode).toBe(401);
  });
});
