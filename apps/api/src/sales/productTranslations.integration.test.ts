/**
 * Per-tenant Arabic product content overlay (docs/08-uae-localization.md §3).
 *
 * Covers the round-trip: create English-only product, verify Arabic-fallback,
 * PUT Arabic content, verify overlay, verify partial merges, and verify the
 * jsonb-object CHECK constraint. Runs against a real PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("product translations overlay", () => {
  let app: ReturnType<typeof buildPgApp>;
  let token = "";
  let productId = "";
  let variantId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `xlate-shop-${suffix}`;

  const authed = () => ({ authorization: `Bearer ${token}` });
  const post = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });
  const put = (url: string, payload: unknown) =>
    app.inject({ method: "PUT", url, headers: authed(), payload: payload as never });

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
        tenantName: "Xlate Shop",
        slug,
        fullName: "Owner",
        email: `owner@${slug}.test`,
        password: "correct-horse-battery",
      },
    });
    token = reg.json().accessToken;
    const locationId = (
      await post("/v1/locations", { kind: "warehouse", name: "WH", code: "W1" })
    ).json().id;
    productId = (
      await post("/v1/products", {
        name: "Wireless Charger",
        slug: "wireless-charger",
        tracking: "none",
        description: "Fast 20W USB-C charger.",
      })
    ).json().id;
    variantId = (
      await post(`/v1/products/${productId}/variants`, {
        sku: "WC-1",
        priceMinor: 8900,
        currency: "AED",
      })
    ).json().id;
    await post("/v1/inventory/movements", {
      id: randomUUID(),
      movementType: "receipt",
      variantId,
      quantity: 5,
      to: { locationId, state: "on_hand" },
      reference: { type: "grn", id: randomUUID() },
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it("returns English fallback on ?lang=ar when no translation exists", async () => {
    const res = await app.inject({ url: `/v1/public/${slug}/catalog?lang=ar` });
    expect(res.statusCode).toBe(200);
    const item = res.json().items.find((i: { productId: string }) => i.productId === productId);
    expect(item.name).toBe("Wireless Charger");
    expect(item.description).toBe("Fast 20W USB-C charger.");
    // The raw translations map must never leak onto the public payload.
    expect(item).not.toHaveProperty("translations");
  });

  it("PUT translations swaps in Arabic on ?lang=ar; English persists on ?lang=en", async () => {
    const saved = await put(`/v1/products/${productId}/translations`, {
      lang: "ar",
      name: "شاحن لاسلكي",
      description: "شاحن سريع بقدرة 20 واط بمنفذ USB-C.",
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      productId,
      translations: { ar: { name: "شاحن لاسلكي" } },
    });

    const ar = await app.inject({ url: `/v1/public/${slug}/catalog?lang=ar` });
    const arItem = ar.json().items.find((i: { productId: string }) => i.productId === productId);
    expect(arItem.name).toBe("شاحن لاسلكي");
    expect(arItem.description).toBe("شاحن سريع بقدرة 20 واط بمنفذ USB-C.");

    const en = await app.inject({ url: `/v1/public/${slug}/catalog?lang=en` });
    const enItem = en.json().items.find((i: { productId: string }) => i.productId === productId);
    expect(enItem.name).toBe("Wireless Charger");
    expect(enItem.description).toBe("Fast 20W USB-C charger.");

    // No lang param → English (base fields).
    const noLang = await app.inject({ url: `/v1/public/${slug}/catalog` });
    const bareItem = noLang.json().items.find(
      (i: { productId: string }) => i.productId === productId,
    );
    expect(bareItem.name).toBe("Wireless Charger");
  });

  it("PUT merges (does not replace) — updating name keeps prior description", async () => {
    await put(`/v1/products/${productId}/translations`, {
      lang: "ar",
      name: "شاحن لاسلكي فاخر",
    });
    const ar = await app.inject({ url: `/v1/public/${slug}/catalog?lang=ar` });
    const item = ar.json().items.find((i: { productId: string }) => i.productId === productId);
    expect(item.name).toBe("شاحن لاسلكي فاخر");
    // description came from the previous PUT and must still be present.
    expect(item.description).toBe("شاحن سريع بقدرة 20 واط بمنفذ USB-C.");
  });

  it("PUT surfaces translations on the authenticated /v1/products list", async () => {
    const list = await app.inject({ url: "/v1/products", headers: authed() });
    expect(list.statusCode).toBe(200);
    const row = list.json().items.find((r: { id: string }) => r.id === productId);
    expect(row.translations?.ar?.name).toBe("شاحن لاسلكي فاخر");
    expect(row.translations?.ar?.description).toBe("شاحن سريع بقدرة 20 واط بمنفذ USB-C.");
  });

  it("PUT requires manager/owner role — cashier is 403", async () => {
    // Enroll a cashier user under the same tenant, then log in as them.
    await post("/v1/users", {
      email: `cashier@${slug}.test`,
      fullName: "Cash",
      role: "cashier",
      password: "cashier-password-12345",
    });
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        slug,
        email: `cashier@${slug}.test`,
        password: "cashier-password-12345",
      },
    });
    const cashierToken = login.json().accessToken as string;
    const res = await app.inject({
      method: "PUT",
      url: `/v1/products/${productId}/translations`,
      headers: { authorization: `Bearer ${cashierToken}` },
      payload: { lang: "ar", name: "hack" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("CHECK constraint rejects non-object translations values", async () => {
    // Sidesteps the API (which won't let a non-object through) to prove the
    // DB-level guard exists — the invariant belongs to the schema, not the
    // route handler.
    const admin = new pg.Client({ connectionString: ADMIN_URL! });
    await admin.connect();
    try {
      await expect(
        admin.query("UPDATE product SET translations = '[]'::jsonb WHERE id = $1", [productId]),
      ).rejects.toThrow(/check constraint|violates check/i);
      await expect(
        admin.query('UPDATE product SET translations = \'"hi"\'::jsonb WHERE id = $1', [productId]),
      ).rejects.toThrow(/check constraint|violates check/i);
    } finally {
      await admin.end();
    }
  });

  it("unknown lang code passes through and returns English fallback", async () => {
    const res = await app.inject({ url: `/v1/public/${slug}/catalog?lang=fr` });
    expect(res.statusCode).toBe(200);
    const item = res.json().items.find((i: { productId: string }) => i.productId === productId);
    expect(item.name).toBe("Wireless Charger");
  });
});
