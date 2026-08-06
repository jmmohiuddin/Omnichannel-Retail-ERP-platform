import { randomUUID } from "node:crypto";
import type pg from "pg";
import { isPgError, type Db } from "../db.js";

export class FinanceError extends Error {
  constructor(
    readonly code:
      | "ORDER_NOT_FOUND"
      | "NO_PAYMENTS"
      | "REFUND_NOT_FOUND"
      | "REFUND_NOT_PROCESSED",
    message: string,
  ) {
    super(message);
    this.name = "FinanceError";
  }
}

/**
 * System chart of accounts, created lazily per tenant at first posting.
 * Codes are stable identifiers; ids are tenant-local.
 */
export const CORE_ACCOUNTS = [
  { code: "1000", name: "Cash", kind: "asset" },
  { code: "1100", name: "Card Clearing", kind: "asset" },
  { code: "1200", name: "Accounts Receivable", kind: "asset" },
  { code: "1300", name: "Inventory", kind: "asset" },
  { code: "2200", name: "VAT Payable", kind: "liability" },
  { code: "4000", name: "Sales Revenue", kind: "revenue" },
  { code: "4900", name: "Refunds", kind: "revenue" }, // contra-revenue
  { code: "5000", name: "Cost of Goods Sold", kind: "expense" },
] as const;

export interface JournalLineView {
  accountId: string;
  accountCode: string;
  accountName: string;
  debitMinor: number;
  creditMinor: number;
}

export interface JournalEntryView {
  id: string;
  entryNo: number;
  sourceType: string;
  sourceId: string;
  memo: string | null;
  postedAt: string;
  lines: JournalLineView[];
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  kind: string;
  debitMinor: number;
  creditMinor: number;
  /** debit − credit: positive = net debit balance (assets/expenses). */
  balanceMinor: number;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebitMinor: number;
  totalCreditMinor: number;
  /** Always 0 for a consistent ledger — the DB trigger guarantees it. */
  netMinor: number;
}

export interface ProfitAndLoss {
  fromIso: string;
  toIso: string;
  grossRevenueMinor: number;
  refundsMinor: number;
  netRevenueMinor: number;
  /** v1: cost of sales is not posted to the journal yet (no COGS entries).
   *  Always 0 until the inventory-cost integration lands. */
  costOfSalesMinor: number;
  costOfSalesNote: string;
  vatCollectedMinor: number;
}

const COGS_NOTE =
  "COGS uses recorded unit cost (serialized units) or variant cost at sale time; " +
  "lines without cost data contribute 0, so review cost coverage before relying on margin.";

/**
 * Minimal double-entry finance module (AED, minor units / fils).
 *
 * Posting is idempotent per business event via the journal_entry
 * UNIQUE (tenant_id, source_type, source_id) constraint: a replayed
 * postSale/postRefund catches 23505 and returns the already-posted entry.
 * Balance (sum debits = sum credits) is enforced by a deferred DB trigger,
 * and posted rows are immutable (forbid_change trigger).
 */
export class FinanceService {
  constructor(private readonly db: Db) {}

  /** Idempotently create the system accounts for a tenant; returns code→id. */
  async ensureCoreAccounts(tenantId: string): Promise<Record<string, string>> {
    return this.db.withTenant(tenantId, (c) => this.ensureCoreAccountsWith(c, tenantId));
  }

  private async ensureCoreAccountsWith(
    c: pg.PoolClient,
    tenantId: string,
  ): Promise<Record<string, string>> {
    for (const a of CORE_ACCOUNTS) {
      await c.query(
        `INSERT INTO account (tenant_id, code, name, kind)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ON CONSTRAINT account_tenant_code_key DO NOTHING`,
        [tenantId, a.code, a.name, a.kind],
      );
    }
    const { rows } = await c.query<{ id: string; code: string }>(
      "SELECT id, code FROM account WHERE code = ANY($1)",
      [CORE_ACCOUNTS.map((a) => a.code)],
    );
    return Object.fromEntries(rows.map((r) => [r.code, r.id]));
  }

  /**
   * Post the accounting entry for a completed sale:
   *   DR Cash / Card Clearing / Accounts Receivable  (per payment method)
   *   CR Sales Revenue (net of VAT)
   *   CR VAT Payable   (tax portion)
   * Pending gateway payments are receivables until captured.
   */
  async postSale(tenantId: string, orderId: string): Promise<JournalEntryView> {
    try {
      return await this.db.withTenant(tenantId, async (c) => {
        const accounts = await this.ensureCoreAccountsWith(c, tenantId);
        const order = await c.query<{
          order_no: string;
          total_minor: string;
          tax_minor: string;
          placed_at: Date;
        }>(
          "SELECT order_no, total_minor, tax_minor, placed_at FROM sales_order WHERE id = $1",
          [orderId],
        );
        const head = order.rows[0];
        if (!head) throw new FinanceError("ORDER_NOT_FOUND", `order ${orderId} not found`);

        const { rows: payments } = await c.query<{
          method: string;
          status: string;
          amount_minor: string;
        }>(
          `SELECT method, status, amount_minor FROM payment
            WHERE order_id = $1 AND amount_minor > 0`,
          [orderId],
        );
        if (payments.length === 0) {
          throw new FinanceError("NO_PAYMENTS", `order ${orderId} has no payments to post`);
        }

        // Aggregate debits per account (a sale may be split cash + card).
        const debits = new Map<string, number>();
        for (const p of payments) {
          const code =
            p.method === "cash"
              ? "1000"
              : p.method === "gateway" && p.status === "pending"
                ? "1200" // not yet settled → Accounts Receivable
                : "1100"; // card & other captured electronic tenders → clearing
          debits.set(code, (debits.get(code) ?? 0) + Number(p.amount_minor));
        }

        const totalMinor = Number(head.total_minor);
        const taxMinor = Number(head.tax_minor);
        const netMinor = totalMinor - taxMinor;

        // COGS: cost of the units sold, from the serialized unit's recorded
        // cost where available, else the variant's cost_minor. Lines without
        // any cost data contribute 0 (the P&L notes the gap honestly).
        const cogs = await c.query<{ cost: string | null }>(
          `SELECT sum(l.quantity * coalesce(su.unit_cost_minor, v.cost_minor, 0))::bigint AS cost
             FROM sales_order_line l
             JOIN variant v ON v.id = l.variant_id
             LEFT JOIN stock_unit su ON su.id = l.stock_unit_id
            WHERE l.order_id = $1`,
          [orderId],
        );
        const cogsMinor = Number(cogs.rows[0]?.cost ?? 0);

        const lines: { code: string; debit: number; credit: number }[] = [
          ...[...debits.entries()].map(([code, amount]) => ({
            code,
            debit: amount,
            credit: 0,
          })),
          { code: "4000", debit: 0, credit: netMinor },
          { code: "2200", debit: 0, credit: taxMinor },
          // Balanced pair: DR COGS / CR Inventory — zero when no cost data.
          { code: "5000", debit: cogsMinor, credit: 0 },
          { code: "1300", debit: 0, credit: cogsMinor },
        ].filter((l) => l.debit !== 0 || l.credit !== 0);

        return this.insertEntry(c, tenantId, accounts, {
          sourceType: "sale",
          sourceId: orderId,
          memo: `POS sale ${head.order_no}`,
          postedAt: head.placed_at,
          lines,
        });
      });
    } catch (err) {
      const existing = await this.existingEntryFor(err, tenantId, "sale", orderId);
      if (existing) return existing;
      throw err;
    }
  }

  /**
   * Post the reversal for a processed refund:
   *   DR Refunds (contra-revenue, gross − tax portion)
   *   DR VAT Payable (tax portion = refund × order tax ratio, rounded)
   *   CR Cash / Card Clearing (per the refund's tender)
   */
  async postRefund(tenantId: string, refundId: string): Promise<JournalEntryView> {
    try {
      return await this.db.withTenant(tenantId, async (c) => {
        const accounts = await this.ensureCoreAccountsWith(c, tenantId);
        const refund = await c.query<{
          amount_minor: string;
          status: string;
          processed_at: Date | null;
          approval_id: string | null;
          order_no: string;
          total_minor: string;
          tax_minor: string;
        }>(
          `SELECT r.amount_minor, r.status, r.processed_at, r.approval_id,
                  o.order_no, o.total_minor, o.tax_minor
             FROM refund r JOIN sales_order o ON o.id = r.order_id
            WHERE r.id = $1`,
          [refundId],
        );
        const head = refund.rows[0];
        if (!head) throw new FinanceError("REFUND_NOT_FOUND", `refund ${refundId} not found`);
        if (head.status !== "processed") {
          throw new FinanceError(
            "REFUND_NOT_PROCESSED",
            `refund ${refundId} is ${head.status}; only processed refunds are posted`,
          );
        }

        // Tender: recorded on the approval payload by the refund workflow.
        let method = "cash";
        if (head.approval_id) {
          const approval = await c.query<{ method: string | null }>(
            "SELECT payload->>'method' AS method FROM approval WHERE id = $1",
            [head.approval_id],
          );
          method = approval.rows[0]?.method ?? "cash";
        }

        const amountMinor = Number(head.amount_minor);
        const orderTotal = Number(head.total_minor);
        const orderTax = Number(head.tax_minor);
        // VAT portion of the refund, proportional to the order's tax ratio.
        const taxPortion = orderTotal === 0 ? 0 : Math.round((amountMinor * orderTax) / orderTotal);

        const lines = [
          { code: "4900", debit: amountMinor - taxPortion, credit: 0 },
          { code: "2200", debit: taxPortion, credit: 0 },
          { code: method === "cash" ? "1000" : "1100", debit: 0, credit: amountMinor },
        ].filter((l) => l.debit !== 0 || l.credit !== 0);

        return this.insertEntry(c, tenantId, accounts, {
          sourceType: "refund",
          sourceId: refundId,
          memo: `Refund on ${head.order_no}`,
          postedAt: head.processed_at ?? new Date(),
          lines,
        });
      });
    } catch (err) {
      const existing = await this.existingEntryFor(err, tenantId, "refund", refundId);
      if (existing) return existing;
      throw err;
    }
  }

  /** Per-account debit/credit/balance totals. Nets to zero by construction. */
  async trialBalance(tenantId: string): Promise<TrialBalance> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{
        id: string;
        code: string;
        name: string;
        kind: string;
        debit: string;
        credit: string;
      }>(
        `SELECT a.id, a.code, a.name, a.kind,
                coalesce(sum(l.debit_minor), 0)  AS debit,
                coalesce(sum(l.credit_minor), 0) AS credit
           FROM account a
           LEFT JOIN journal_line l ON l.account_id = a.id
          GROUP BY a.id, a.code, a.name, a.kind
          ORDER BY a.code`,
      );
      const out: TrialBalanceRow[] = rows.map((r) => ({
        accountId: r.id,
        code: r.code,
        name: r.name,
        kind: r.kind,
        debitMinor: Number(r.debit),
        creditMinor: Number(r.credit),
        balanceMinor: Number(r.debit) - Number(r.credit),
      }));
      const totalDebitMinor = out.reduce((s, r) => s + r.debitMinor, 0);
      const totalCreditMinor = out.reduce((s, r) => s + r.creditMinor, 0);
      return {
        rows: out,
        totalDebitMinor,
        totalCreditMinor,
        netMinor: totalDebitMinor - totalCreditMinor,
      };
    });
  }

  /** Revenue − refunds over [fromIso, toIso]. COGS is not tracked in v1. */
  async profitAndLoss(
    tenantId: string,
    range: { fromIso: string; toIso: string },
  ): Promise<ProfitAndLoss> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ code: string; debit: string; credit: string }>(
        `SELECT a.code,
                coalesce(sum(l.debit_minor), 0)  AS debit,
                coalesce(sum(l.credit_minor), 0) AS credit
           FROM journal_line l
           JOIN journal_entry e ON e.id = l.entry_id
           JOIN account a ON a.id = l.account_id
          WHERE e.posted_at >= $1 AND e.posted_at <= $2
          GROUP BY a.code`,
        [range.fromIso, range.toIso],
      );
      const byCode = new Map(rows.map((r) => [r.code, r]));
      const creditBalance = (code: string) => {
        const r = byCode.get(code);
        return r ? Number(r.credit) - Number(r.debit) : 0;
      };
      const grossRevenueMinor = creditBalance("4000");
      const refundsMinor = -creditBalance("4900"); // contra-revenue: debit balance
      return {
        fromIso: range.fromIso,
        toIso: range.toIso,
        grossRevenueMinor,
        refundsMinor,
        netRevenueMinor: grossRevenueMinor - refundsMinor,
        costOfSalesMinor: -creditBalance("5000") || 0, // expense: debit balance (|| 0 avoids -0)
        costOfSalesNote: COGS_NOTE,
        vatCollectedMinor: creditBalance("2200"),
      };
    });
  }

  // -------------------------------------------------------------------------

  private async insertEntry(
    c: pg.PoolClient,
    tenantId: string,
    accounts: Record<string, string>,
    entry: {
      sourceType: string;
      sourceId: string;
      memo: string;
      postedAt: Date;
      lines: { code: string; debit: number; credit: number }[];
    },
  ): Promise<JournalEntryView> {
    const entryId = randomUUID();
    const inserted = await c.query<{ entry_no: string; posted_at: Date }>(
      `INSERT INTO journal_entry (id, tenant_id, source_type, source_id, memo, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING entry_no, posted_at`,
      [entryId, tenantId, entry.sourceType, entry.sourceId, entry.memo, entry.postedAt],
    );
    const lines: JournalLineView[] = [];
    for (const line of entry.lines) {
      const accountId = accounts[line.code];
      if (!accountId) throw new Error(`missing system account ${line.code}`);
      await c.query(
        `INSERT INTO journal_line (id, tenant_id, entry_id, account_id, debit_minor, credit_minor)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), tenantId, entryId, accountId, line.debit, line.credit],
      );
      const meta = CORE_ACCOUNTS.find((a) => a.code === line.code);
      lines.push({
        accountId,
        accountCode: line.code,
        accountName: meta?.name ?? line.code,
        debitMinor: line.debit,
        creditMinor: line.credit,
      });
    }
    return {
      id: entryId,
      entryNo: Number(inserted.rows[0]!.entry_no),
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      memo: entry.memo,
      postedAt: inserted.rows[0]!.posted_at.toISOString(),
      lines,
    };
  }

  /** If `err` is the idempotency conflict, load and return the existing entry. */
  private async existingEntryFor(
    err: unknown,
    tenantId: string,
    sourceType: string,
    sourceId: string,
  ): Promise<JournalEntryView | undefined> {
    if (!isPgError(err) || err.code !== "23505" || err.constraint !== "journal_entry_source_key") {
      return undefined;
    }
    return this.entryBySource(tenantId, sourceType, sourceId);
  }

  /** Load a posted entry (with lines) by its business source. */
  async entryBySource(
    tenantId: string,
    sourceType: string,
    sourceId: string,
  ): Promise<JournalEntryView | undefined> {
    return this.db.withTenant(tenantId, async (c) => {
      const entry = await c.query<{
        id: string;
        entry_no: string;
        memo: string | null;
        posted_at: Date;
      }>(
        `SELECT id, entry_no, memo, posted_at FROM journal_entry
          WHERE source_type = $1 AND source_id = $2`,
        [sourceType, sourceId],
      );
      const head = entry.rows[0];
      if (!head) return undefined;
      const { rows: lines } = await c.query<{
        account_id: string;
        code: string;
        name: string;
        debit_minor: string;
        credit_minor: string;
      }>(
        `SELECT l.account_id, a.code, a.name, l.debit_minor, l.credit_minor
           FROM journal_line l JOIN account a ON a.id = l.account_id
          WHERE l.entry_id = $1
          ORDER BY a.code`,
        [head.id],
      );
      return {
        id: head.id,
        entryNo: Number(head.entry_no),
        sourceType,
        sourceId,
        memo: head.memo,
        postedAt: head.posted_at.toISOString(),
        lines: lines.map((l) => ({
          accountId: l.account_id,
          accountCode: l.code,
          accountName: l.name,
          debitMinor: Number(l.debit_minor),
          creditMinor: Number(l.credit_minor),
        })),
      };
    });
  }
}
