import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Db } from "../db.js";

export class LoyaltyError extends Error {
  constructor(
    readonly code: "CUSTOMER_NOT_FOUND" | "INSUFFICIENT_POINTS",
    message: string,
  ) {
    super(message);
    this.name = "LoyaltyError";
  }
}

export interface LoyaltyConfig {
  /** Points earned per this many fils of eligible spend (default: 1 pt / AED 10). */
  earnPerMinor: number;
  /** Redemption value of one point, in fils (default: 5 fils = AED 0.05). */
  redeemValueMinor: number;
}

export const DEFAULT_LOYALTY: LoyaltyConfig = { earnPerMinor: 1000, redeemValueMinor: 5 };

export function loyaltyConfigFrom(settings: unknown): LoyaltyConfig {
  const raw = (settings as { loyalty?: Partial<LoyaltyConfig> } | null)?.loyalty ?? {};
  const earnPerMinor = Number(raw.earnPerMinor);
  const redeemValueMinor = Number(raw.redeemValueMinor);
  return {
    earnPerMinor: Number.isInteger(earnPerMinor) && earnPerMinor > 0
      ? earnPerMinor : DEFAULT_LOYALTY.earnPerMinor,
    redeemValueMinor: Number.isInteger(redeemValueMinor) && redeemValueMinor > 0
      ? redeemValueMinor : DEFAULT_LOYALTY.redeemValueMinor,
  };
}

/**
 * Loyalty ledger. Both methods that move points run on a caller-provided
 * transaction client so redemption/accrual is atomic with the sale itself —
 * a sale can never complete with points it failed to deduct.
 */
export class LoyaltyService {
  constructor(private readonly db: Db) {}

  async configFor(c: pg.PoolClient, tenantId: string): Promise<LoyaltyConfig> {
    const { rows } = await c.query<{ settings: unknown }>(
      "SELECT settings FROM tenant WHERE id = $1",
      [tenantId],
    );
    return loyaltyConfigFrom(rows[0]?.settings);
  }

  /**
   * Redeem points worth `amountMinor` inside the sale transaction.
   * Points needed = ceil(amount / redeemValue); balance is decremented under
   * the customer row lock, and the CHECK (loyalty_points >= 0) is the backstop.
   */
  async redeemWith(
    c: pg.PoolClient,
    tenantId: string,
    customerId: string,
    orderId: string,
    amountMinor: number,
  ): Promise<{ pointsRedeemed: number }> {
    const config = await this.configFor(c, tenantId);
    const pointsNeeded = Math.ceil(amountMinor / config.redeemValueMinor);
    const customer = await c.query<{ loyalty_points: string }>(
      "SELECT loyalty_points FROM customer WHERE id = $1 FOR UPDATE",
      [customerId],
    );
    if (!customer.rows[0]) throw new LoyaltyError("CUSTOMER_NOT_FOUND", "customer not found");
    const balance = Number(customer.rows[0].loyalty_points);
    if (balance < pointsNeeded) {
      throw new LoyaltyError(
        "INSUFFICIENT_POINTS",
        `needs ${pointsNeeded} points (worth ${amountMinor} fils), customer has ${balance}`,
      );
    }
    await c.query(
      `INSERT INTO loyalty_transaction (id, tenant_id, customer_id, order_id, kind, points, note)
       VALUES ($1,$2,$3,$4,'redeem',$5,$6)`,
      [randomUUID(), tenantId, customerId, orderId, -pointsNeeded,
       `redeemed against ${amountMinor} fils`],
    );
    await c.query(
      "UPDATE customer SET loyalty_points = loyalty_points - $2 WHERE id = $1",
      [customerId, pointsNeeded],
    );
    return { pointsRedeemed: pointsNeeded };
  }

  /**
   * Accrue points for an order (idempotent via the partial unique index —
   * a replayed call is a no-op). Eligible spend excludes the loyalty-paid part.
   */
  async accrueWith(
    c: pg.PoolClient,
    tenantId: string,
    customerId: string,
    orderId: string,
    eligibleMinor: number,
  ): Promise<{ pointsEarned: number }> {
    const config = await this.configFor(c, tenantId);
    const points = Math.floor(eligibleMinor / config.earnPerMinor);
    if (points <= 0) return { pointsEarned: 0 };
    const inserted = await c.query(
      `INSERT INTO loyalty_transaction (id, tenant_id, customer_id, order_id, kind, points, note)
       VALUES ($1,$2,$3,$4,'earn',$5,$6)
       ON CONFLICT DO NOTHING`,
      [randomUUID(), tenantId, customerId, orderId, points,
       `earned on ${eligibleMinor} fils`],
    );
    if (inserted.rowCount === 0) return { pointsEarned: 0 }; // replay
    await c.query(
      "UPDATE customer SET loyalty_points = loyalty_points + $2 WHERE id = $1",
      [customerId, points],
    );
    return { pointsEarned: points };
  }

  async balance(tenantId: string, customerId: string): Promise<{
    points: number; valueMinor: number; history: unknown[];
  }> {
    return this.db.withTenant(tenantId, async (c) => {
      const config = await this.configFor(c, tenantId);
      const customer = await c.query<{ loyalty_points: string }>(
        "SELECT loyalty_points FROM customer WHERE id = $1",
        [customerId],
      );
      if (!customer.rows[0]) throw new LoyaltyError("CUSTOMER_NOT_FOUND", "customer not found");
      const points = Number(customer.rows[0].loyalty_points);
      const { rows: history } = await c.query(
        `SELECT kind, points, note, order_id AS "orderId", created_at AS "createdAt"
           FROM loyalty_transaction WHERE customer_id = $1
          ORDER BY created_at DESC LIMIT 50`,
        [customerId],
      );
      return {
        points,
        valueMinor: points * config.redeemValueMinor,
        history: history.map((h) => ({ ...h, points: Number(h.points) })),
      };
    });
  }
}
