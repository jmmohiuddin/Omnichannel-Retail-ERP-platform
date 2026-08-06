/**
 * Double-entry finance module integration tests (real PostgreSQL — see
 * pgApp.integration.test.ts for environment requirements; skipped without
 * ADMIN_DATABASE_URL / DATABASE_URL).
 *
 * Provisioning (tenant, catalog, sale, refund) goes through the HTTP app like
 * sales.integration.test.ts; the FinanceService itself is exercised directly
 * against a Db built on the app-role DATABASE_URL, so RLS applies.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";
import { Db } from "../db.js";
import { FinanceService, type JournalEntryView } from "./financeService.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

const lineFor = (entry: JournalEntryView, code: string) =>
  entry.lines.find((l) => l.accountCode === code);

describe.skipIf(!run)("finance: double-entry journal", () => {
  let app: ReturnType<typeof buildPgApp>;
  let db: Db;
  let finance: FinanceService;
  let ownerToken = "";
  let managerToken = "";
  let tenantId = "";
  let locationId = "";
  let deviceId = "";
  let phoneVariantId = "";
  let chargerVariantId = "";
  let cashSaleId = "";
  let refundId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `fin-shop-${suffix}`;

  // Cash sale: 1 phone @ 4199.00 + 2 chargers @ 89.00 (VAT-inclusive).
  // 5% VAT extracted: 19995 + 848 = 20843 fils.
  const SALE_TOTAL = 419900 + 17800; // 437700
  const SALE_TAX = 19995 + 848; // 20843
  const SALE_NET = SALE_TOTAL - SALE_TAX; // 416857
  // Card sale: 1 charger @ 89.00 → tax 424, net 8476.
  const CARD_TOTAL = 8900;
  const CARD_TAX = 424;
  // Refund of the two chargers from the cash sale.
  const REFUND_AMOUNT = 17800;
  const REFUND_TAX = Math.round((REFUND_AMOUNT * SALE_TAX) / SALE_TOTAL); // 848

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
    finance = new FinanceService(db);

    const reg = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        tenantName: "Finance Test Shop", slug,
        fullName: "Owner", email: `owner@${slug}.test`,
        password: "correct-horse-battery",
      },
    });
    expect(reg.statusCode).toBe(201);
    ownerToken = reg.json().accessToken;
    tenantId = reg.json().tenantId;

    // A second human so refunds can be approved (requester ≠ approver).
    const mgr = await post(ownerToken, "/v1/users", {
      email: `mgr@${slug}.test`, password: "employee-pass-123",
      fullName: "Manager", role: "manager",
    });
    expect(mgr.statusCode).toBe(201);
    const login = await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { slug, email: `mgr@${slug}.test`, password: "employee-pass-123" },
    });
    managerToken = login.json().accessToken;

    locationId = (await post(ownerToken, "/v1/locations", { kind: "store", name: "Shop", code: "S1" })).json().id;
    deviceId = (await post(ownerToken, "/v1/devices", { kind: "pos_register", name: "Register 1", locationId })).json().id;

    const mkVariant = async (name: string, vslug: string, sku: string, priceMinor: number, qty: number) => {
      const productId = (await post(ownerToken, "/v1/products", { name, slug: vslug, tracking: "none" })).json().id;
      const variantId = (
        await post(ownerToken, `/v1/products/${productId}/variants`, { sku, priceMinor, currency: "AED" })
      ).json().id;
      const receipt = await post(ownerToken, "/v1/inventory/movements", {
        id: randomUUID(), movementType: "receipt", variantId, quantity: qty,
        to: { locationId, state: "on_hand" },
        reference: { type: "grn", id: randomUUID() },
      });
      expect(receipt.statusCode).toBe(201);
      return variantId;
    };
    phoneVariantId = await mkVariant("Phone Pro", "phone-pro", "PP-1", 419900, 5);
    chargerVariantId = await mkVariant("Charger", "charger", "CH-1", 8900, 10);

    cashSaleId = randomUUID();
    const sale = await post(ownerToken, "/v1/pos/sales", {
      id: cashSaleId, deviceId, locationId,
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

  it("ensureCoreAccounts is idempotent and returns the code→id map", async () => {
    const first = await finance.ensureCoreAccounts(tenantId);
    expect(Object.keys(first).sort()).toEqual(
      ["1000", "1100", "1200", "1300", "2200", "4000", "4900", "5000"],
    );

    const second = await finance.ensureCoreAccounts(tenantId);
    expect(second).toEqual(first); // same ids — nothing re-created
  });

  it("postSale posts a balanced entry: DR cash = total, CR revenue = net, CR VAT = tax", async () => {
    const entry = await finance.postSale(tenantId, cashSaleId);
    expect(entry.sourceType).toBe("sale");
    expect(entry.sourceId).toBe(cashSaleId);
    expect(entry.lines).toHaveLength(3);

    expect(lineFor(entry, "1000")).toMatchObject({ debitMinor: SALE_TOTAL, creditMinor: 0 });
    expect(lineFor(entry, "4000")).toMatchObject({ debitMinor: 0, creditMinor: SALE_NET });
    expect(lineFor(entry, "2200")).toMatchObject({ debitMinor: 0, creditMinor: SALE_TAX });

    const debits = entry.lines.reduce((s, l) => s + l.debitMinor, 0);
    const credits = entry.lines.reduce((s, l) => s + l.creditMinor, 0);
    expect(debits).toBe(credits);
  });

  it("postSale is idempotent: replay returns the existing entry, no duplicate", async () => {
    const first = await finance.entryBySource(tenantId, "sale", cashSaleId);
    const replay = await finance.postSale(tenantId, cashSaleId);
    expect(replay.id).toBe(first!.id);
    expect(replay.entryNo).toBe(first!.entryNo);
    expect(replay.lines).toHaveLength(3);

    // Ledger unchanged: still exactly one cash debit for the sale total.
    const tb = await finance.trialBalance(tenantId);
    expect(tb.rows.find((r) => r.code === "1000")!.debitMinor).toBe(SALE_TOTAL);
  });

  it("card payments post to Card Clearing; pending gateway would be AR", async () => {
    const cardSaleId = randomUUID();
    const sale = await post(ownerToken, "/v1/pos/sales", {
      id: cardSaleId, deviceId, locationId,
      lines: [{ variantId: chargerVariantId, quantity: 1, unitPriceMinor: 8900 }],
      payments: [{ method: "card", amountMinor: CARD_TOTAL }],
    });
    expect(sale.statusCode).toBe(201);

    const entry = await finance.postSale(tenantId, cardSaleId);
    expect(lineFor(entry, "1100")).toMatchObject({ debitMinor: CARD_TOTAL, creditMinor: 0 });
    expect(lineFor(entry, "2200")).toMatchObject({ creditMinor: CARD_TAX });
    expect(lineFor(entry, "1000")).toBeUndefined(); // no cash leg on a card sale
  });

  it("trial balance nets to zero", async () => {
    const tb = await finance.trialBalance(tenantId);
    expect(tb.totalDebitMinor).toBeGreaterThan(0);
    expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
    expect(tb.netMinor).toBe(0);

    expect(tb.rows.find((r) => r.code === "1000")!.balanceMinor).toBe(SALE_TOTAL);
    expect(tb.rows.find((r) => r.code === "1100")!.balanceMinor).toBe(CARD_TOTAL);
    // Revenue and VAT carry credit balances (negative in debit−credit terms).
    expect(tb.rows.find((r) => r.code === "4000")!.balanceMinor).toBe(
      -(SALE_NET + (CARD_TOTAL - CARD_TAX)),
    );
  });

  it("the database rejects an unbalanced entry at commit", async () => {
    await expect(
      db.withTenant(tenantId, async (c) => {
        const accounts = await c.query<{ id: string }>(
          "SELECT id FROM account WHERE code = '1000'",
        );
        const entryId = randomUUID();
        await c.query(
          `INSERT INTO journal_entry (id, tenant_id, source_type, source_id, memo)
           VALUES ($1, $2, 'manual', $3, 'lopsided')`,
          [entryId, tenantId, randomUUID()],
        );
        await c.query(
          `INSERT INTO journal_line (id, tenant_id, entry_id, account_id, debit_minor, credit_minor)
           VALUES ($1, $2, $3, $4, 100, 0)`,
          [randomUUID(), tenantId, entryId, accounts.rows[0]!.id],
        );
        // deferred trigger fires at COMMIT inside withTenant → throws
      }),
    ).rejects.toThrow(/unbalanced/);
  });

  it("posted journal rows are immutable", async () => {
    await expect(
      db.withTenant(tenantId, (c) =>
        c.query("UPDATE journal_line SET debit_minor = debit_minor + 1 WHERE debit_minor > 0"),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.withTenant(tenantId, (c) => c.query("DELETE FROM journal_entry")),
    ).rejects.toThrow(/immutable/);
  });

  it("postRefund posts a balanced reversal and is idempotent", async () => {
    // Two-human refund workflow: owner requests, manager approves (FP-004).
    const req = await post(ownerToken, `/v1/orders/${cashSaleId}/refunds`, {
      amountMinor: REFUND_AMOUNT, reason: "Customer returned the chargers", method: "cash",
      restock: [{ variantId: chargerVariantId, quantity: 2 }],
    });
    expect(req.statusCode).toBe(201);
    refundId = req.json().refundId;

    const decide = await post(managerToken, `/v1/approvals/${req.json().approvalId}/decision`, {
      approve: true,
    });
    expect(decide.statusCode).toBe(200);

    const entry = await finance.postRefund(tenantId, refundId);
    expect(entry.sourceType).toBe("refund");
    expect(lineFor(entry, "4900")).toMatchObject({
      debitMinor: REFUND_AMOUNT - REFUND_TAX, creditMinor: 0,
    });
    expect(lineFor(entry, "2200")).toMatchObject({ debitMinor: REFUND_TAX, creditMinor: 0 });
    expect(lineFor(entry, "1000")).toMatchObject({ debitMinor: 0, creditMinor: REFUND_AMOUNT });

    const replay = await finance.postRefund(tenantId, refundId);
    expect(replay.id).toBe(entry.id);

    // Still balanced after the reversal.
    const tb = await finance.trialBalance(tenantId);
    expect(tb.netMinor).toBe(0);
    expect(tb.rows.find((r) => r.code === "1000")!.balanceMinor).toBe(SALE_TOTAL - REFUND_AMOUNT);
  });

  it("P&L reflects refunds as contra-revenue and nets VAT", async () => {
    const pl = await finance.profitAndLoss(tenantId, {
      fromIso: "2000-01-01T00:00:00Z",
      toIso: "2100-01-01T00:00:00Z",
    });
    const grossRevenue = SALE_NET + (CARD_TOTAL - CARD_TAX);
    expect(pl.grossRevenueMinor).toBe(grossRevenue);
    expect(pl.refundsMinor).toBe(REFUND_AMOUNT - REFUND_TAX);
    expect(pl.netRevenueMinor).toBe(grossRevenue - (REFUND_AMOUNT - REFUND_TAX));
    expect(pl.vatCollectedMinor).toBe(SALE_TAX + CARD_TAX - REFUND_TAX);
    expect(pl.costOfSalesMinor).toBe(0); // COGS lands in a later increment
    expect(pl.costOfSalesNote).toMatch(/COGS/);
  });
});
