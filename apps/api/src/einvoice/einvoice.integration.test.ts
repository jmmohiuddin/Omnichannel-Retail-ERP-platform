/**
 * E-invoice generation integration test (real PostgreSQL — skipped without
 * ADMIN_DATABASE_URL / DATABASE_URL, same convention as
 * finance.integration.test.ts).
 *
 * Provisioning (tenant, catalog, sale) goes through the HTTP app; the
 * EInvoiceService is then exercised directly against a Db built on the
 * app-role DATABASE_URL, so RLS applies.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";
import { Db } from "../db.js";
import { EInvoiceService } from "./einvoiceService.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

describe.skipIf(!run)("einvoice: draft PINT-AE document generation", () => {
  let app: ReturnType<typeof buildPgApp>;
  let db: Db;
  let einvoice: EInvoiceService;
  let ownerToken = "";
  let tenantId = "";
  let saleId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `einv-shop-${suffix}`;

  // 1 phone @ 4199.00 + 2 chargers @ 89.00 (VAT-inclusive, 5%):
  // tax = 19995 + 848 = 20843; total = 437700; net = 416857.
  const SALE_TOTAL = 419900 + 17800;
  const SALE_TAX = 19995 + 848;

  const authed = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (token: string, url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: authed(token), payload: payload as never });

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    db = new Db(APP_URL!);
    einvoice = new EInvoiceService(db);

    const reg = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        tenantName: "EInvoice Test Shop", slug,
        fullName: "Owner", email: `owner@${slug}.test`,
        password: "correct-horse-battery",
      },
    });
    expect(reg.statusCode).toBe(201);
    ownerToken = reg.json().accessToken;
    tenantId = reg.json().tenantId;

    const locationId = (
      await post(ownerToken, "/v1/locations", { kind: "store", name: "Shop", code: "S1" })
    ).json().id;
    const deviceId = (
      await post(ownerToken, "/v1/devices", {
        kind: "pos_register", name: "Register 1", locationId,
      })
    ).json().id;

    const mkVariant = async (
      name: string, vslug: string, sku: string, priceMinor: number, qty: number,
    ) => {
      const productId = (
        await post(ownerToken, "/v1/products", { name, slug: vslug, tracking: "none" })
      ).json().id;
      const variantId = (
        await post(ownerToken, `/v1/products/${productId}/variants`, {
          sku, priceMinor, currency: "AED",
        })
      ).json().id;
      const receipt = await post(ownerToken, "/v1/inventory/movements", {
        id: randomUUID(), movementType: "receipt", variantId, quantity: qty,
        to: { locationId, state: "on_hand" },
        reference: { type: "grn", id: randomUUID() },
      });
      expect(receipt.statusCode).toBe(201);
      return variantId;
    };
    const phoneVariantId = await mkVariant("Phone Pro", "phone-pro", "PP-1", 419900, 5);
    const chargerVariantId = await mkVariant("Charger", "charger", "CH-1", 8900, 10);

    saleId = randomUUID();
    const sale = await post(ownerToken, "/v1/pos/sales", {
      id: saleId, deviceId, locationId,
      lines: [
        { variantId: phoneVariantId, quantity: 1, unitPriceMinor: 419900 },
        { variantId: chargerVariantId, quantity: 2, unitPriceMinor: 8900 },
      ],
      payments: [{ method: "cash", amountMinor: SALE_TOTAL }],
    });
    expect(sale.statusCode).toBe(201);
    expect(sale.json().totals.taxMinor).toBe(SALE_TAX);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  it("generateForOrder returns a valid draft with the right totals and a TRN warning", async () => {
    const doc = await einvoice.generateForOrder(tenantId, saleId);
    expect(doc).toBeDefined();
    const { model, xml, validation } = doc!;

    // Model integrity against the known sale numbers.
    expect(model.profile).toBe("PINT-AE-draft");
    expect(model.invoiceNumber).toMatch(/^INV-\d{6}$/);
    expect(model.currency).toBe("AED");
    expect(model.simplified).toBe(true); // walk-in POS sale, no customer attached
    expect(model.monetaryTotals.taxInclusiveMinor).toBe(SALE_TOTAL);
    expect(model.taxTotal.taxAmountMinor).toBe(SALE_TAX);
    expect(model.monetaryTotals.taxExclusiveMinor).toBe(SALE_TOTAL - SALE_TAX);
    expect(model.lines).toHaveLength(2);

    // No structural errors; registration sets no TRN → warning, not error.
    expect(validation.errors).toEqual([]);
    expect(validation.warnings.some((w) => /TRN missing/.test(w))).toBe(true);

    // XML carries the totals and the required structure.
    expect(xml).toContain('xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"');
    expect(xml).toMatch(/<cbc:TaxInclusiveAmount currencyID="AED">4377\.00</);
    expect(xml).toMatch(/<cbc:TaxAmount currencyID="AED">208\.43</);
    expect(xml).toMatch(/<cbc:TaxExclusiveAmount currencyID="AED">4168\.57</);
    expect(xml).toContain("<cbc:Name>EInvoice Test Shop</cbc:Name>");
    expect(xml).not.toContain("schemeID=\"TRN\""); // no TRN registered yet
    expect(xml).not.toContain("<cac:AccountingCustomerParty>");
    expect(xml).toContain("verify against current FTA/Peppol PINT-AE docs");

    // Unknown order → undefined, not a throw.
    expect(await einvoice.generateForOrder(tenantId, randomUUID())).toBeUndefined();
  });
});
