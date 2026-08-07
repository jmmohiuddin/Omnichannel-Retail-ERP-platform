import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Db } from "../db.js";

export class StoreCreditError extends Error {
  constructor(
    readonly code:
      | "CUSTOMER_NOT_FOUND"
      | "INSUFFICIENT_BALANCE"
      | "BAD_AMOUNT"
      | "ACCOUNT_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "StoreCreditError";
  }
}

export interface StoreCreditBalance {
  balanceMinor: number;
  currency: string;
  transactions: Array<{
    kind: "issue" | "redeem" | "adjust";
    amountMinor: number;
    reason: string;
    orderId: string | null;
    createdAt: Date;
  }>;
}

/**
 * Store credit — direct money attached to a customer. Same ledger discipline
 * as loyalty and gift cards: an immutable signed transaction log, a derived
 * balance guarded by CHECK(balance >= 0), and a redeemWith() that runs on the
 * caller's transaction client so a failed debit rolls back the whole sale.
 *
 * Design note: store credit is per-customer (one account), unlike gift cards
 * which are per-code and transferable. A customer can have store credit AND
 * gift cards AND loyalty points — three parallel wallets, sale can draw from
 * any combination via split tenders.
 */
export class StoreCreditService {
  constructor(private readonly db: Db) {}

  async issue(
    tenantId: string,
    actorUserId: string,
    input: { customerId: string; amountMinor: number; reason: string },
  ): Promise<{ balanceMinor: number }> {
    if (input.amountMinor <= 0) {
      throw new StoreCreditError("BAD_AMOUNT", "amountMinor must be positive");
    }
    return this.db.withTenant(tenantId, async (c) => {
      const customer = await c.query<{ id: string }>(
        "SELECT id FROM customer WHERE id = $1",
        [input.customerId],
      );
      if (!customer.rows[0]) {
        throw new StoreCreditError("CUSTOMER_NOT_FOUND", "customer not found");
      }
      const tenant = await c.query<{ base_currency: string }>(
        "SELECT base_currency FROM tenant WHERE id = $1",
        [tenantId],
      );
      const currency = tenant.rows[0]!.base_currency;

      await c.query(
        `INSERT INTO store_credit_account
           (tenant_id, customer_id, balance_minor, currency, updated_at)
         VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (tenant_id, customer_id)
         DO UPDATE SET balance_minor = store_credit_account.balance_minor + EXCLUDED.balance_minor,
                       updated_at = now()`,
        [tenantId, input.customerId, input.amountMinor, currency],
      );
      await c.query(
        `INSERT INTO store_credit_transaction
           (id, tenant_id, customer_id, kind, amount_minor, reason, actor_user_id)
         VALUES ($1,$2,$3,'issue',$4,$5,$6)`,
        [randomUUID(), tenantId, input.customerId, input.amountMinor,
         input.reason, actorUserId],
      );
      const updated = await c.query<{ balance_minor: string }>(
        "SELECT balance_minor FROM store_credit_account WHERE tenant_id = $1 AND customer_id = $2",
        [tenantId, input.customerId],
      );
      return { balanceMinor: Number(updated.rows[0]!.balance_minor) };
    });
  }

  /**
   * Redeem store credit inside the sale transaction. Idempotent per
   * (customer, order) via the partial unique index — a replayed sale that
   * already redeemed returns the prior amount instead of double-debiting.
   */
  async redeemWith(
    c: pg.PoolClient,
    tenantId: string,
    customerId: string,
    orderId: string,
    amountMinor: number,
  ): Promise<{ redeemedMinor: number; remainingMinor: number }> {
    if (amountMinor <= 0) {
      throw new StoreCreditError("BAD_AMOUNT", "amountMinor must be positive");
    }
    // Prior redemption for this order? (idempotent replay)
    const prior = await c.query<{ amount_minor: string }>(
      `SELECT amount_minor FROM store_credit_transaction
        WHERE tenant_id = $1 AND customer_id = $2 AND order_id = $3 AND kind = 'redeem'`,
      [tenantId, customerId, orderId],
    );
    if (prior.rows[0]) {
      const bal = await c.query<{ balance_minor: string }>(
        "SELECT balance_minor FROM store_credit_account WHERE tenant_id = $1 AND customer_id = $2",
        [tenantId, customerId],
      );
      return {
        redeemedMinor: -Number(prior.rows[0].amount_minor), // stored as negative
        remainingMinor: Number(bal.rows[0]?.balance_minor ?? 0),
      };
    }

    const account = await c.query<{ balance_minor: string }>(
      `SELECT balance_minor FROM store_credit_account
        WHERE tenant_id = $1 AND customer_id = $2 FOR UPDATE`,
      [tenantId, customerId],
    );
    const balance = Number(account.rows[0]?.balance_minor ?? 0);
    if (balance < amountMinor) {
      throw new StoreCreditError(
        "INSUFFICIENT_BALANCE",
        `store credit balance ${balance} is less than requested ${amountMinor}`,
      );
    }
    await c.query(
      "UPDATE store_credit_account SET balance_minor = balance_minor - $3, updated_at = now() WHERE tenant_id = $1 AND customer_id = $2",
      [tenantId, customerId, amountMinor],
    );
    await c.query(
      `INSERT INTO store_credit_transaction
         (id, tenant_id, customer_id, order_id, kind, amount_minor, reason)
       VALUES ($1,$2,$3,$4,'redeem',$5,$6)`,
      [randomUUID(), tenantId, customerId, orderId, -amountMinor,
       `redeemed against order`],
    );
    return { redeemedMinor: amountMinor, remainingMinor: balance - amountMinor };
  }

  async balance(tenantId: string, customerId: string): Promise<StoreCreditBalance> {
    return this.db.withTenant(tenantId, async (c) => {
      const account = await c.query<{ balance_minor: string; currency: string }>(
        "SELECT balance_minor, currency FROM store_credit_account WHERE tenant_id = $1 AND customer_id = $2",
        [tenantId, customerId],
      );
      const tenant = await c.query<{ base_currency: string }>(
        "SELECT base_currency FROM tenant WHERE id = $1", [tenantId],
      );
      const { rows: txns } = await c.query<{
        kind: "issue" | "redeem" | "adjust"; amount_minor: string;
        reason: string; order_id: string | null; created_at: Date;
      }>(
        `SELECT kind, amount_minor, reason, order_id, created_at
           FROM store_credit_transaction
          WHERE tenant_id = $1 AND customer_id = $2
          ORDER BY created_at DESC LIMIT 50`,
        [tenantId, customerId],
      );
      return {
        balanceMinor: Number(account.rows[0]?.balance_minor ?? 0),
        currency: account.rows[0]?.currency ?? tenant.rows[0]!.base_currency,
        transactions: txns.map((t) => ({
          kind: t.kind,
          amountMinor: Number(t.amount_minor),
          reason: t.reason,
          orderId: t.order_id,
          createdAt: t.created_at,
        })),
      };
    });
  }
}
