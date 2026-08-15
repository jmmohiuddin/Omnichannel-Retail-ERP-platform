/**
 * Tax credit notes, against real PostgreSQL (R7.8).
 *
 * A refund used to move money and stock and produce no tax document. Under
 * UAE VAT the credit note is the instrument that reverses OUTPUT TAX — without
 * one, VAT collected on a sale that was given back is never reversed.
 *
 * The invariant these tests exist to protect is the PRD §10 edge case:
 * "Return of a serialised unit sold under RCM → credit note mirrors the
 * original tax treatment." A handset sold under the domestic reverse charge
 * carried no VAT, so crediting it must carry no VAT — even after the buyer's
 * declaration has been revoked.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

const SUPPLIER_TRN = "100123456700003";
const BUYER_TRN = "100987654300003";
const PHONE_PRICE_MINOR = 210_000; // AED 2,100.00 inc. 5% VAT

describe.skipIf(!run)("credit notes", () => {
  let app: ReturnType<typeof buildPgApp>;
  let ownerToken = "";
  let managerToken = "";
  let locationId = "";
  let deviceId = "";
  let phoneVariantId = "";
  let businessCustomerId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `cn-shop-${suffix}`;

  const post = (token: string, url: string, payload?: unknown) =>
    app.inject({
      method: "POST", url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as never,
    });
  const put = (token: string, url: string, payload?: unknown) =>
    app.inject({
      method: "PUT", url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as never,
    });
  const get = (token: string, url: string) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  const sell = (body: Record<string, unknown>) =>
    post(ownerToken, "/v1/pos/sales", { id: randomUUID(), deviceId, locationId, ...body });

  /** Request a refund and have the manager approve it. */
  const refundAndApprove = async (
    orderId: string,
    body: Record<string, unknown>,
  ): Promise<void> => {
    const req = await post(ownerToken, `/v1/orders/${orderId}/refunds`, body);
    expect(req.statusCode).toBe(201);
    const decide = await post(
      managerToken, `/v1/approvals/${req.json().approvalId}/decision`, { approve: true },
    );
    expect(decide.statusCode).toBe(200);
  };

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    ownerToken = (
      await app.inject({
        method: "POST", url: "/v1/auth/register",
        payload: {
          tenantName: "Credit Note Shop", slug, fullName: "Owner",
          email: `owner@${slug}.test`, password: "correct-horse-battery",
        },
      })
    ).json().accessToken;

    // A refund needs an approver who is not the requester.
    await post(ownerToken, "/v1/users", {
      email: `mgr@${slug}.test`, password: "employee-pass-123",
      fullName: "Manager", role: "manager",
    });
    managerToken = (
      await app.inject({
        method: "POST", url: "/v1/auth/login",
        payload: { slug, email: `mgr@${slug}.test`, password: "employee-pass-123" },
      })
    ).json().accessToken;

    await put(ownerToken, "/v1/settings/supplier", {
      trn: SUPPLIER_TRN,
      address: { line1: "Shop 12, Naif Road", city: "Dubai", emirate: "DU", country: "AE" },
    });

    locationId = (
      await post(ownerToken, "/v1/locations", { kind: "store", name: "Shop", code: "S1" })
    ).json().id;
    deviceId = (
      await post(ownerToken, "/v1/devices", { kind: "pos_register", name: "R1", locationId })
    ).json().id;
    await post(ownerToken, "/v1/cash-sessions", { deviceId, openingFloatMinor: 0 });

    const productId = (
      await post(ownerToken, "/v1/products", {
        name: "Phone C", slug: `phone-c-${suffix}`, deviceClass: "smart_phone",
      })
    ).json().id;
    phoneVariantId = (
      await post(ownerToken, `/v1/products/${productId}/variants`, {
        sku: `PC-${suffix}`, priceMinor: PHONE_PRICE_MINOR, currency: "AED",
      })
    ).json().id;
    await post(ownerToken, "/v1/inventory/receipts", {
      locationId, lines: [{ variantId: phoneVariantId, quantity: 50 }],
    });

    businessCustomerId = (
      await post(ownerToken, "/v1/customers", {
        fullName: "Yusuf Rahman",
        isBusiness: true,
        legalName: "Gulf Devices Trading L.L.C",
        trn: BUYER_TRN,
      })
    ).json().id;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  describe("a refund produces its tax document", () => {
    it("issues a credit note in the same transaction as the refund", async () => {
      const order = (
        await sell({
          lines: [{ variantId: phoneVariantId, quantity: 1, unitPriceMinor: PHONE_PRICE_MINOR }],
          payments: [{ method: "cash", amountMinor: PHONE_PRICE_MINOR }],
        })
      ).json();

      await refundAndApprove(order.orderId, {
        amountMinor: PHONE_PRICE_MINOR,
        reason: "customer changed their mind",
        method: "cash",
        restock: [{ variantId: phoneVariantId, quantity: 1 }],
      });

      const notes = (await get(ownerToken, `/v1/orders/${order.orderId}/credit-notes`)).json().items;
      expect(notes).toHaveLength(1);
      expect(notes[0].noteNo).toMatch(/^CN-\d{6}$/);
      // The whole point: the VAT charged on the sale is reversed.
      expect(notes[0].taxMinor).toBe(10_000);
      expect(notes[0].totalMinor).toBe(PHONE_PRICE_MINOR);
    });

    it("numbers credit notes gaplessly in their own series", async () => {
      const noteNos: string[] = [];
      for (let i = 0; i < 3; i++) {
        const order = (
          await sell({
            lines: [{ variantId: phoneVariantId, quantity: 1, unitPriceMinor: PHONE_PRICE_MINOR }],
            payments: [{ method: "cash", amountMinor: PHONE_PRICE_MINOR }],
          })
        ).json();
        await refundAndApprove(order.orderId, {
          amountMinor: PHONE_PRICE_MINOR,
          reason: `sequence probe ${i}`,
          method: "cash",
          restock: [{ variantId: phoneVariantId, quantity: 1 }],
        });
        const notes = (
          await get(ownerToken, `/v1/orders/${order.orderId}/credit-notes`)
        ).json().items;
        noteNos.push(notes[0].noteNo);
      }

      const numbers = noteNos.map((n) => Number(n.slice(3)));
      // Consecutive, no holes. This is the property a Postgres SEQUENCE
      // cannot give — nextval does not roll back.
      expect(numbers[1]).toBe(numbers[0]! + 1);
      expect(numbers[2]).toBe(numbers[1]! + 1);
      // And it is a separate series from the INV- invoice numbers.
      expect(noteNos.every((n) => n.startsWith("CN-"))).toBe(true);
    });
  });

  describe("PRD §10 — the credit note mirrors the original tax treatment", () => {
    it("credits a reverse-charged sale with no VAT", async () => {
      const declarationId = (
        await post(ownerToken, `/v1/customers/${businessCustomerId}/rcm-declarations`, {
          declaresResaleOrManufacture: true,
          declaresFtaRegistered: true,
        })
      ).json().id;
      await post(ownerToken, `/v1/rcm-declarations/${declarationId}/verify`, {
        method: "fta_portal", outcome: "verified",
      });

      const order = (
        await sell({
          customerId: businessCustomerId,
          businessSale: true,
          lines: [{ variantId: phoneVariantId, quantity: 1, unitPriceMinor: PHONE_PRICE_MINOR }],
          payments: [{ method: "cash", amountMinor: 200_000 }],
        })
      ).json();
      expect(order.taxTreatment).toBe("reverse_charge");

      await refundAndApprove(order.orderId, {
        amountMinor: 200_000,
        reason: "returned under warranty",
        method: "cash",
        restock: [{ variantId: phoneVariantId, quantity: 1 }],
      });

      const noteId = (
        await get(ownerToken, `/v1/orders/${order.orderId}/credit-notes`)
      ).json().items[0].id;
      const note = (await get(ownerToken, `/v1/credit-notes/${noteId}`)).json();

      expect(note.taxTreatment).toBe("reverse_charge");
      // No VAT was charged, so none is credited back.
      expect(note.totals.taxMinor).toBe(0);
      expect(note.totals.totalMinor).toBe(200_000);
      expect(note.lines[0].taxCategory).toBe("AE");
      expect(note.lines[0].taxRateBp).toBe(0);
      // The buyer's identity carries onto the credit note, as it must on any
      // document that credits a full tax invoice.
      expect(note.buyer).toMatchObject({
        legalName: "Gulf Devices Trading L.L.C",
        trn: BUYER_TRN,
      });
      expect(note.seller.trn).toBe(SUPPLIER_TRN);
    });

    it("still credits with no VAT after the declaration is revoked", async () => {
      // The invariant that makes "mirror, never recompute" matter. Recomputing
      // today's treatment for a sale made under yesterday's rules would credit
      // 5% VAT that was never charged.
      const declarationId = (
        await post(ownerToken, `/v1/customers/${businessCustomerId}/rcm-declarations`, {
          declaresResaleOrManufacture: true,
          declaresFtaRegistered: true,
        })
      ).json().id;
      await post(ownerToken, `/v1/rcm-declarations/${declarationId}/verify`, {
        method: "fta_portal", outcome: "verified",
      });

      const order = (
        await sell({
          customerId: businessCustomerId,
          businessSale: true,
          lines: [{ variantId: phoneVariantId, quantity: 1, unitPriceMinor: PHONE_PRICE_MINOR }],
          payments: [{ method: "cash", amountMinor: 200_000 }],
        })
      ).json();
      expect(order.taxTreatment).toBe("reverse_charge");

      await post(ownerToken, `/v1/rcm-declarations/${declarationId}/revoke`, {
        reason: "buyer deregistered",
      });

      await refundAndApprove(order.orderId, {
        amountMinor: 200_000,
        reason: "returned after the buyer deregistered",
        method: "cash",
        restock: [{ variantId: phoneVariantId, quantity: 1 }],
      });

      const noteId = (
        await get(ownerToken, `/v1/orders/${order.orderId}/credit-notes`)
      ).json().items[0].id;
      const note = (await get(ownerToken, `/v1/credit-notes/${noteId}`)).json();

      expect(note.taxTreatment).toBe("reverse_charge");
      expect(note.totals.taxMinor).toBe(0);
    });
  });

  describe("standalone credit notes", () => {
    it("credits an invoice with no money moving", async () => {
      const order = (
        await sell({
          lines: [{ variantId: phoneVariantId, quantity: 2, unitPriceMinor: PHONE_PRICE_MINOR }],
          payments: [{ method: "cash", amountMinor: PHONE_PRICE_MINOR * 2 }],
        })
      ).json();

      const res = await post(ownerToken, `/v1/orders/${order.orderId}/credit-notes`, {
        reason: "line was priced against the wrong tier",
      });

      expect(res.statusCode).toBe(201);
      const note = res.json();
      expect(note.totals.totalMinor).toBe(PHONE_PRICE_MINOR * 2);
      expect(note.totals.taxMinor).toBe(20_000);
      expect(note.orderNo).toBe(
        (await get(ownerToken, `/v1/orders/${order.orderId}/receipt`)).json().orderNo,
      );
    });

    it("refuses to credit a larger quantity than was invoiced", async () => {
      const order = (
        await sell({
          lines: [{ variantId: phoneVariantId, quantity: 2, unitPriceMinor: PHONE_PRICE_MINOR }],
          payments: [{ method: "cash", amountMinor: PHONE_PRICE_MINOR * 2 }],
        })
      ).json();

      // Credit the whole invoice once to learn the invoice line's id, which
      // the credit note carries as its audit trail back to the sale.
      const whole = await post(ownerToken, `/v1/orders/${order.orderId}/credit-notes`, {
        reason: "full credit",
      });
      expect(whole.statusCode).toBe(201);
      const orderLineId = whole.json().lines[0].orderLineId;
      expect(orderLineId).toBeTruthy();

      const tooMuch = await post(ownerToken, `/v1/orders/${order.orderId}/credit-notes`, {
        reason: "credit three of two",
        lines: [{ orderLineId, quantity: 3 }],
      });
      expect(tooMuch.statusCode).toBe(422);
      expect(tooMuch.json().error).toBe("EXCEEDS_INVOICE");
    });

    it("pro-rates a partial credit from the invoiced line, tax included", async () => {
      const order = (
        await sell({
          lines: [{ variantId: phoneVariantId, quantity: 2, unitPriceMinor: PHONE_PRICE_MINOR }],
          payments: [{ method: "cash", amountMinor: PHONE_PRICE_MINOR * 2 }],
        })
      ).json();
      const full = await post(ownerToken, `/v1/orders/${order.orderId}/credit-notes`, {
        reason: "learn the line id",
      });
      const orderLineId = full.json().lines[0].orderLineId;

      const half = await post(ownerToken, `/v1/orders/${order.orderId}/credit-notes`, {
        reason: "one of the two handsets came back",
        lines: [{ orderLineId, quantity: 1 }],
      });

      expect(half.statusCode).toBe(201);
      // Half the line: half the money and half the VAT, in whole fils.
      expect(half.json().totals.totalMinor).toBe(PHONE_PRICE_MINOR);
      expect(half.json().totals.taxMinor).toBe(10_000);
    });

    it("refuses to credit a line that is not on the invoice", async () => {
      const order = (
        await sell({
          lines: [{ variantId: phoneVariantId, quantity: 1, unitPriceMinor: PHONE_PRICE_MINOR }],
          payments: [{ method: "cash", amountMinor: PHONE_PRICE_MINOR }],
        })
      ).json();

      const res = await post(ownerToken, `/v1/orders/${order.orderId}/credit-notes`, {
        reason: "line belongs to another invoice",
        lines: [{ orderLineId: randomUUID(), quantity: 1 }],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("NOTHING_TO_CREDIT");
    });

    it("refuses a credit note for an order that does not exist", async () => {
      const res = await post(ownerToken, `/v1/orders/${randomUUID()}/credit-notes`, {
        reason: "no such order",
      });
      expect(res.statusCode).toBe(404);
    });

    it("is not issuable by a cashier", async () => {
      await post(ownerToken, "/v1/users", {
        email: `pos@${slug}.test`, password: "employee-pass-123",
        fullName: "Cashier", role: "cashier",
      });
      const cashierToken = (
        await app.inject({
          method: "POST", url: "/v1/auth/login",
          payload: { slug, email: `pos@${slug}.test`, password: "employee-pass-123" },
        })
      ).json().accessToken;

      const order = (
        await sell({
          lines: [{ variantId: phoneVariantId, quantity: 1, unitPriceMinor: PHONE_PRICE_MINOR }],
          payments: [{ method: "cash", amountMinor: PHONE_PRICE_MINOR }],
        })
      ).json();

      const res = await post(cashierToken, `/v1/orders/${order.orderId}/credit-notes`, {
        reason: "cashier attempt",
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
