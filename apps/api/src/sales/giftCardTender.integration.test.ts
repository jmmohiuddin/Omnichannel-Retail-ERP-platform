/**
 * Gift-card tender at POS (real PostgreSQL): issue → split payment → balance.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("gift card tender", () => {
  let app: ReturnType<typeof buildPgApp>;
  let token = "";
  let locationId = "";
  let deviceId = "";
  let variantId = "";
  let code = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `gift-shop-${suffix}`;

  const authed = () => ({ authorization: `Bearer ${token}` });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    token = (await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: { tenantName: "Gift Shop", slug, fullName: "Owner",
                 email: `owner@${slug}.test`, password: "correct-horse-battery" },
    })).json().accessToken;
    locationId = (await post("/v1/locations", { kind: "store", name: "S", code: "S1" })).json().id;
    deviceId = (await post("/v1/devices", { kind: "pos_register", name: "R1", locationId })).json().id;
    const productId = (await post("/v1/products", { name: "Lamp", slug: "lamp", tracking: "none" })).json().id;
    variantId = (await post(`/v1/products/${productId}/variants`, {
      sku: "LM-1", priceMinor: 10500, currency: "AED",
    })).json().id;
    await post("/v1/inventory/movements", {
      id: randomUUID(), movementType: "receipt", variantId, quantity: 10,
      to: { locationId, state: "on_hand" }, reference: { type: "grn", id: randomUUID() },
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it("issues a card and pays a sale with gift card + cash split", async () => {
    const issued = await post("/v1/gift-cards", { amountMinor: 5000 });
    expect(issued.statusCode).toBe(201);
    code = issued.json().code;
    expect(code).toMatch(/^GC-/);

    const sale = await post("/v1/pos/sales", {
      id: randomUUID(), deviceId, locationId,
      lines: [{ variantId, quantity: 1, unitPriceMinor: 10500 }],
      payments: [
        { method: "gift_card", amountMinor: 5000, giftCardCode: code },
        { method: "cash", amountMinor: 5500 },
      ],
    });
    expect(sale.statusCode).toBe(201);

    const balance = await app.inject({ url: `/v1/gift-cards/${code}`, headers: authed() });
    expect(balance.json().balanceMinor).toBe(0);
    expect(balance.json().status).toBe("depleted");
  });

  it("overspending a card rolls back the whole sale including stock", async () => {
    const issued = await post("/v1/gift-cards", { amountMinor: 1000 });
    const code2 = issued.json().code;

    const before = (await app.inject({
      url: `/v1/inventory/availability/${variantId}/${locationId}`, headers: authed(),
    })).json().onHand;

    const sale = await post("/v1/pos/sales", {
      id: randomUUID(), deviceId, locationId,
      lines: [{ variantId, quantity: 1, unitPriceMinor: 10500 }],
      payments: [{ method: "gift_card", amountMinor: 10500, giftCardCode: code2 }],
    });
    expect(sale.statusCode).toBe(422);
    expect(sale.json().error).toBe("INSUFFICIENT_BALANCE");

    const after = (await app.inject({
      url: `/v1/inventory/availability/${variantId}/${locationId}`, headers: authed(),
    })).json().onHand;
    expect(after).toBe(before);
    expect((await app.inject({ url: `/v1/gift-cards/${code2}`, headers: authed() }))
      .json().balanceMinor).toBe(1000);
  });

  it("gift_card payment without a code is rejected", async () => {
    const sale = await post("/v1/pos/sales", {
      id: randomUUID(), deviceId, locationId,
      lines: [{ variantId, quantity: 1, unitPriceMinor: 10500 }],
      payments: [{ method: "gift_card", amountMinor: 10500 }],
    });
    expect(sale.statusCode).toBe(422);
  });
});
