/**
 * Domestic reverse charge, end to end against real PostgreSQL (R7.3 / R7.3a).
 *
 * This walks the PRD's acceptance criteria for R7.3 as written:
 *
 *   Given   a walk-in buyer presents a TRN and states the handsets are for resale
 *   When    the cashier marks the sale as business-to-business with intent to resell
 *   Then    the POS requires the buyer's TRN, legal name and address,
 *           and requires a declaration capturing BOTH resale/manufacture intent
 *           AND the buyer's confirmation that it is registered with the FTA
 *   And     the supplier-side registration verification step is recorded
 *   And     the sale is priced VAT-exclusive with a 0%-RCM tax code on
 *           qualifying device lines only
 *   And     accessory lines and any zero-rated export lines stay outside RCM
 *   And     the printed invoice is a full tax invoice carrying the
 *           reverse-charge statement and a reference to Cabinet Decision 91/2023
 *   And     without a captured and verified declaration, the sale falls back to
 *           a standard 5% VAT sale and the cashier is told why, in one sentence
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

// AED 2,100.00 inclusive of 5% VAT → 2,000.00 net, 100.00 VAT.
const PHONE_PRICE_MINOR = 210_000;
// AED 105.00 inclusive → 100.00 net, 5.00 VAT.
const CASE_PRICE_MINOR = 10_500;

describe.skipIf(!run)("domestic reverse charge (CD 91/2023)", () => {
  let app: ReturnType<typeof buildPgApp>;
  let ownerToken = "";
  let locationId = "";
  let deviceId = "";
  let phoneVariantId = "";
  let caseVariantId = "";
  let businessCustomerId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `rcm-shop-${suffix}`;

  const authed = () => ({ authorization: `Bearer ${ownerToken}` });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(), payload: payload as never });
  const put = (url: string, payload?: unknown) =>
    app.inject({ method: "PUT", url, headers: authed(), payload: payload as never });
  const get = (url: string) => app.inject({ method: "GET", url, headers: authed() });

  /** Ring a sale and return the parsed body. */
  const sell = (body: Record<string, unknown>) =>
    post("/v1/pos/sales", { id: randomUUID(), deviceId, locationId, ...body });

  const phoneLine = (extra: Record<string, unknown> = {}) => ({
    variantId: phoneVariantId,
    quantity: 1,
    unitPriceMinor: PHONE_PRICE_MINOR,
    ...extra,
  });
  const caseLine = () => ({
    variantId: caseVariantId,
    quantity: 1,
    unitPriceMinor: CASE_PRICE_MINOR,
  });

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    ownerToken = (
      await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        payload: {
          tenantName: "RCM Shop",
          slug,
          fullName: "Owner",
          email: `owner@${slug}.test`,
          password: "correct-horse-battery",
        },
      })
    ).json().accessToken;

    // The shop's own registration — condition 1 of CD 91/2023 — plus the
    // address R7.1 makes mandatory on every tax invoice.
    await put("/v1/settings/supplier", {
      trn: SUPPLIER_TRN,
      address: { line1: "Shop 12, Naif Road", city: "Dubai", emirate: "DU", country: "AE" },
    });

    locationId = (await post("/v1/locations", { kind: "store", name: "Deira", code: "DEI" })).json().id;
    deviceId = (
      await post("/v1/devices", { kind: "pos_register", name: "Till 1", locationId })
    ).json().id;
    await post("/v1/cash-sessions", { deviceId, openingFloatMinor: 0 });

    // A qualifying electronic device …
    const phoneProduct = (
      await post("/v1/products", {
        name: "Phone R", slug: `phone-r-${suffix}`, deviceClass: "smart_phone",
      })
    ).json().id;
    phoneVariantId = (
      await post(`/v1/products/${phoneProduct}/variants`, {
        sku: `PR-${suffix}`, priceMinor: PHONE_PRICE_MINOR, currency: "AED",
      })
    ).json().id;

    // … and an accessory, which is not a device and must stay standard-rated.
    const caseProduct = (
      await post("/v1/products", { name: "Case R", slug: `case-r-${suffix}` })
    ).json().id;
    caseVariantId = (
      await post(`/v1/products/${caseProduct}/variants`, {
        sku: `CR-${suffix}`, priceMinor: CASE_PRICE_MINOR, currency: "AED",
      })
    ).json().id;

    await post("/v1/inventory/receipts", {
      locationId,
      lines: [
        { variantId: phoneVariantId, quantity: 50 },
        { variantId: caseVariantId, quantity: 50 },
      ],
    });

    businessCustomerId = (
      await post("/v1/customers", {
        fullName: "Yusuf Rahman",
        phone: `+9715${suffix.slice(0, 7)}`,
        isBusiness: true,
        legalName: "Gulf Devices Trading L.L.C",
        trn: BUYER_TRN,
        billingAddress: { line1: "Office 401, Al Fahidi", city: "Dubai", emirate: "DU", country: "AE" },
      })
    ).json().id;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  /** Capture and verify a declaration, leaving the customer RCM-eligible. */
  const captureVerified = async (): Promise<string> => {
    const declarationId = (
      await post(`/v1/customers/${businessCustomerId}/rcm-declarations`, {
        declaresResaleOrManufacture: true,
        declaresFtaRegistered: true,
      })
    ).json().id;
    await post(`/v1/rcm-declarations/${declarationId}/verify`, {
      method: "fta_portal",
      outcome: "verified",
      reference: `FTA-CHK-${suffix}`,
    });
    return declarationId;
  };

  describe("the business customer record (R9.3)", () => {
    it("rejects a business customer with no legal name to invoice", async () => {
      const res = await post("/v1/customers", {
        fullName: "Nameless Co Contact",
        isBusiness: true,
        trn: BUYER_TRN,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("LEGAL_NAME_REQUIRED");
    });

    it("rejects a malformed TRN before it can reach an invoice", async () => {
      const res = await post("/v1/customers", {
        fullName: "Typo Co",
        isBusiness: true,
        legalName: "Typo Trading L.L.C",
        trn: "1001234567", // 10 digits, not 15
      });
      expect(res.statusCode).toBe(400);
    });

    it("refuses a declaration for a customer with no TRN", async () => {
      const plainId = (
        await post("/v1/customers", { fullName: `Walk In ${suffix}` })
      ).json().id;
      const res = await post(`/v1/customers/${plainId}/rcm-declarations`, {
        declaresResaleOrManufacture: true,
        declaresFtaRegistered: true,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("NOT_A_BUSINESS_CUSTOMER");
    });
  });

  describe("R7.3a — a declaration alone is not sufficient", () => {
    it("falls back to 5% and explains why when verification never happened", async () => {
      const isolated = (
        await post("/v1/customers", {
          fullName: "Unverified Contact",
          isBusiness: true,
          legalName: `Unverified Trading ${suffix} L.L.C`,
          trn: BUYER_TRN,
        })
      ).json().id;
      await post(`/v1/customers/${isolated}/rcm-declarations`, {
        declaresResaleOrManufacture: true,
        declaresFtaRegistered: true,
      });

      const res = await sell({
        customerId: isolated,
        businessSale: true,
        lines: [phoneLine()],
        payments: [{ method: "cash", amountMinor: PHONE_PRICE_MINOR }],
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.taxTreatment).toBe("standard");
      // The whole VAT-inclusive price is charged, and VAT is inside it.
      expect(body.totals.totalMinor).toBe(PHONE_PRICE_MINOR);
      expect(body.totals.taxMinor).toBe(10_000);
      // One sentence, at the till.
      expect(body.rcmRefusedMessage).toContain("has not been verified");
      expect(body.rcmRefusedMessage.split(". ").filter(Boolean)).toHaveLength(1);
    });

    it("records the verification step against the declaration", async () => {
      const declarationId = await captureVerified();
      const items = (
        await get(`/v1/customers/${businessCustomerId}/rcm-declarations`)
      ).json().items;
      const record = items.find((d: { id: string }) => d.id === declarationId);

      expect(record).toMatchObject({
        verificationMethod: "fta_portal",
        verificationOutcome: "verified",
        verificationRef: `FTA-CHK-${suffix}`,
        usable: true,
      });
      expect(record.verifiedAt).toBeTruthy();
    });

    it("treats an unavailable lookup as not verified, not as verified", async () => {
      // PRD Q10 is open — no counter-side lookup is guaranteed to exist. That
      // must never be allowed to read as a pass.
      const isolated = (
        await post("/v1/customers", {
          fullName: "Unavailable Contact",
          isBusiness: true,
          legalName: `Unavailable Trading ${suffix} L.L.C`,
          trn: BUYER_TRN,
        })
      ).json().id;
      const declarationId = (
        await post(`/v1/customers/${isolated}/rcm-declarations`, {
          declaresResaleOrManufacture: true,
          declaresFtaRegistered: true,
        })
      ).json().id;
      await post(`/v1/rcm-declarations/${declarationId}/verify`, {
        method: "fta_portal",
        outcome: "unavailable",
        reference: "portal returned 503",
      });

      const res = await sell({
        customerId: isolated,
        businessSale: true,
        lines: [phoneLine()],
        payments: [{ method: "cash", amountMinor: PHONE_PRICE_MINOR }],
      });
      expect(res.json().taxTreatment).toBe("standard");
      expect(res.json().rcmRefusedMessage).toContain("not been verified");
    });
  });

  describe("a fully qualifying sale", () => {
    beforeAll(async () => {
      await captureVerified();
    });

    it("prices the device VAT-exclusive with no VAT charged", async () => {
      const res = await sell({
        customerId: businessCustomerId,
        businessSale: true,
        lines: [phoneLine()],
        payments: [{ method: "cash", amountMinor: 200_000 }],
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.taxTreatment).toBe("reverse_charge");
      // The subtle part: the shelf price is 2,100.00 inclusive, but the
      // reverse-charged invoice is for 2,000.00 with zero VAT. RCM is not the
      // same price relabelled.
      expect(body.totals.totalMinor).toBe(200_000);
      expect(body.totals.taxMinor).toBe(0);
      expect(body.rcmRefusedMessage).toBeUndefined();
    });

    it("rejects a tender for the VAT-inclusive amount", async () => {
      // A till that has not applied the reverse charge would offer 2,100.00.
      // The server recomputes and refuses rather than quietly banking 100.00
      // of VAT it is not charging.
      const res = await sell({
        customerId: businessCustomerId,
        businessSale: true,
        lines: [phoneLine()],
        payments: [{ method: "cash", amountMinor: PHONE_PRICE_MINOR }],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("PAYMENT_MISMATCH");
    });

    it("leaves the accessory standard-rated on the same invoice", async () => {
      const res = await sell({
        customerId: businessCustomerId,
        businessSale: true,
        lines: [phoneLine(), caseLine()],
        // 2,000.00 for the phone (RCM) + 105.00 for the case (inc. VAT).
        payments: [{ method: "cash", amountMinor: 200_000 + CASE_PRICE_MINOR }],
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.taxTreatment).toBe("mixed");
      // Only the accessory's VAT is charged.
      expect(body.totals.taxMinor).toBe(500);

      const receipt = (await get(`/v1/orders/${body.orderId}/receipt`)).json();
      const byCategory = Object.fromEntries(
        receipt.lines.map((l: { taxCategory: string; taxMinor: number }) => [
          l.taxCategory,
          l.taxMinor,
        ]),
      );
      expect(byCategory.AE).toBe(0);
      expect(byCategory.S).toBe(500);
    });

    it("R7.3a: a zero-rated export line stays zero-rated, not reverse-charged", async () => {
      const res = await sell({
        customerId: businessCustomerId,
        businessSale: true,
        lines: [phoneLine(), phoneLine({ zeroRated: true })],
        // RCM phone at 2,000.00 + zero-rated phone at its 2,100.00 price
        // (a zero-rated price contains no VAT to strip).
        payments: [{ method: "cash", amountMinor: 200_000 + PHONE_PRICE_MINOR }],
      });

      expect(res.statusCode).toBe(201);
      const receipt = (await get(`/v1/orders/${res.json().orderId}/receipt`)).json();
      const categories = receipt.lines.map((l: { taxCategory: string }) => l.taxCategory).sort();
      expect(categories).toEqual(["AE", "Z"]);
      expect(receipt.totals.taxMinor).toBe(0);
    });

    it("issues a full tax invoice carrying the CD 91/2023 statement", async () => {
      const res = await sell({
        customerId: businessCustomerId,
        businessSale: true,
        lines: [phoneLine()],
        payments: [{ method: "cash", amountMinor: 200_000 }],
      });
      const receipt = (await get(`/v1/orders/${res.json().orderId}/receipt`)).json();

      // R7.2: a supply to a registrant is a FULL tax invoice, not simplified.
      expect(receipt.kind).toBe("full_tax_invoice");
      expect(receipt.buyer).toMatchObject({
        legalName: "Gulf Devices Trading L.L.C",
        trn: BUYER_TRN,
      });
      // R7.1: supplier name, address AND TRN.
      expect(receipt.seller.trn).toBe(SUPPLIER_TRN);
      expect(receipt.seller.address).toMatchObject({ line1: "Shop 12, Naif Road", emirate: "DU" });
      // R7.2/R7.3: the statement, bilingual, citing the Cabinet Decision.
      expect(receipt.reverseChargeStatement.en).toContain("91 of 2023");
      expect(receipt.reverseChargeStatement.ar).toContain("2023");
      expect(receipt.taxTreatment).toBe("reverse_charge");
    });

    it("stops reverse-charging once the declaration is revoked", async () => {
      const isolated = (
        await post("/v1/customers", {
          fullName: "Lapsed Contact",
          isBusiness: true,
          legalName: `Lapsed Trading ${suffix} L.L.C`,
          trn: BUYER_TRN,
        })
      ).json().id;
      const declarationId = (
        await post(`/v1/customers/${isolated}/rcm-declarations`, {
          declaresResaleOrManufacture: true,
          declaresFtaRegistered: true,
        })
      ).json().id;
      await post(`/v1/rcm-declarations/${declarationId}/verify`, {
        method: "certificate",
        outcome: "verified",
      });

      const qualified = await sell({
        customerId: isolated,
        businessSale: true,
        lines: [phoneLine()],
        payments: [{ method: "cash", amountMinor: 200_000 }],
      });
      expect(qualified.json().taxTreatment).toBe("reverse_charge");

      await post(`/v1/rcm-declarations/${declarationId}/revoke`, {
        reason: "buyer deregistered for VAT",
      });

      const afterRevoke = await sell({
        customerId: isolated,
        businessSale: true,
        lines: [phoneLine()],
        payments: [{ method: "cash", amountMinor: PHONE_PRICE_MINOR }],
      });
      expect(afterRevoke.json().taxTreatment).toBe("standard");
      expect(afterRevoke.json().totals.taxMinor).toBe(10_000);
    });
  });

  describe("the ordinary consumer sale is untouched", () => {
    it("charges 5% and says nothing about reverse charge", async () => {
      const res = await sell({
        lines: [phoneLine()],
        payments: [{ method: "cash", amountMinor: PHONE_PRICE_MINOR }],
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.taxTreatment).toBe("standard");
      expect(body.totals.taxMinor).toBe(10_000);
      expect(body.rcmRefusedMessage).toBeUndefined();

      const receipt = (await get(`/v1/orders/${body.orderId}/receipt`)).json();
      expect(receipt.kind).toBe("simplified_tax_invoice");
      expect(receipt.reverseChargeStatement).toBeUndefined();
      expect(receipt.buyer).toBeUndefined();
      // R7.1 applies to simplified invoices too.
      expect(receipt.seller.trn).toBe(SUPPLIER_TRN);
      expect(receipt.seller.address).toBeTruthy();
      expect(receipt.lines[0].taxCategory).toBe("S");
      expect(receipt.lines[0].taxRateBp).toBe(500);
    });

    it("refuses reverse charge on a sale with no customer attached", async () => {
      const res = await sell({
        businessSale: true,
        lines: [phoneLine()],
        payments: [{ method: "cash", amountMinor: PHONE_PRICE_MINOR }],
      });
      expect(res.json().taxTreatment).toBe("standard");
      // With no customer there is no TRN either, and the refusal names the
      // first thing the cashier has to fix rather than the last: capture the
      // buyer before asking for their paperwork.
      expect(res.json().rcmRefusedMessage).toContain("buyer's TRN");
    });
  });
});
