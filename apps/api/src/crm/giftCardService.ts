import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { Db } from "../db.js";

export class GiftCardError extends Error {
  constructor(
    readonly code:
      | "CARD_NOT_FOUND"
      | "CARD_NOT_ACTIVE"
      | "CARD_EXPIRED"
      | "INSUFFICIENT_BALANCE"
      | "BAD_AMOUNT",
    message: string,
  ) {
    super(message);
    this.name = "GiftCardError";
  }
}

/** 32 unambiguous characters — no 0/O or 1/I. 32 divides 256, so `byte % 32` is unbiased. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface GiftCardRow {
  id: string;
  code: string;
  balance_minor: string;
  initial_minor: string;
  currency: string;
  status: "active" | "depleted" | "cancelled";
  expires_at: string | null;
  expired: boolean;
}

const assertAmount = (amountMinor: number): void => {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new GiftCardError("BAD_AMOUNT", `amountMinor must be a positive integer, got ${amountMinor}`);
  }
};

/**
 * Gift-card ledger (mirrors LoyaltyService): gift_card.balance_minor is a
 * derived balance maintained in the same transaction as each immutable
 * gift_card_transaction row. `redeemWith` runs on a caller-provided
 * transaction client so redemption is atomic with the sale itself — a sale
 * can never complete with gift-card value it failed to deduct.
 */
export class GiftCardService {
  constructor(private readonly db: Db) {}

  /** Crypto-random code, e.g. GC-7XK2-9MPQ-4WVN. */
  generateCode(): string {
    const bytes = randomBytes(12);
    const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
    return `GC-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
  }

  /** Issue a new card in the tenant's base currency (+ its 'issue' ledger row). */
  async issue(
    tenantId: string,
    userId: string,
    opts: { amountMinor: number; expiresAt?: string; orderId?: string },
  ): Promise<{ giftCardId: string; code: string; balanceMinor: number }> {
    assertAmount(opts.amountMinor);
    return this.db.withTenant(tenantId, async (c) => {
      const { rows: tenant } = await c.query<{ base_currency: string }>(
        "SELECT base_currency FROM tenant WHERE id = $1",
        [tenantId],
      );
      const currency = tenant[0]?.base_currency ?? "AED";
      const giftCardId = randomUUID();
      const code = this.generateCode();
      await c.query(
        `INSERT INTO gift_card
           (id, tenant_id, code, balance_minor, initial_minor, currency, issued_by, issued_order_id, expires_at)
         VALUES ($1,$2,upper($3),$4,$4,$5,$6,$7,$8)`,
        [giftCardId, tenantId, code, opts.amountMinor, currency, userId,
         opts.orderId ?? null, opts.expiresAt ?? null],
      );
      await c.query(
        `INSERT INTO gift_card_transaction (id, tenant_id, gift_card_id, order_id, kind, amount_minor, note)
         VALUES ($1,$2,$3,$4,'issue',$5,$6)`,
        [randomUUID(), tenantId, giftCardId, opts.orderId ?? null, opts.amountMinor,
         `issued by ${userId}`],
      );
      return { giftCardId, code, balanceMinor: opts.amountMinor };
    });
  }

  /** Card status/balance/expiry by code (case-insensitive) + last 20 ledger rows. */
  async balance(tenantId: string, code: string): Promise<{
    giftCardId: string;
    code: string;
    status: "active" | "depleted" | "cancelled";
    balanceMinor: number;
    initialMinor: number;
    currency: string;
    expiresAt: string | null;
    expired: boolean;
    transactions: { kind: string; amountMinor: number; note: string | null; orderId: string | null; createdAt: string }[];
  }> {
    return this.db.withTenant(tenantId, async (c) => {
      const card = await this.lookup(c, code, false);
      const { rows } = await c.query<{
        kind: string; amount_minor: string; note: string | null;
        order_id: string | null; created_at: string;
      }>(
        `SELECT kind, amount_minor, note, order_id, created_at
           FROM gift_card_transaction WHERE gift_card_id = $1
          ORDER BY created_at DESC LIMIT 20`,
        [card.id],
      );
      return {
        giftCardId: card.id,
        code: card.code,
        status: card.status,
        balanceMinor: Number(card.balance_minor),
        initialMinor: Number(card.initial_minor),
        currency: card.currency,
        expiresAt: card.expires_at,
        expired: card.expired,
        transactions: rows.map((r) => ({
          kind: r.kind,
          amountMinor: Number(r.amount_minor),
          note: r.note,
          orderId: r.order_id,
          createdAt: r.created_at,
        })),
      };
    });
  }

  /**
   * Redeem `amountMinor` against a card inside the sale transaction.
   * The card row is locked FOR UPDATE for the duration; a replay of the same
   * (order, card) redemption returns the prior amount without double-debiting
   * (partial unique index gift_card_redeem_once_uq is the backstop).
   */
  async redeemWith(
    c: pg.PoolClient,
    tenantId: string,
    code: string,
    orderId: string,
    amountMinor: number,
  ): Promise<{ redeemedMinor: number; remainingMinor: number }> {
    assertAmount(amountMinor);
    const card = await this.lookup(c, code, true);
    // Idempotent replay: an existing redemption for this (order, card) wins
    // before any state checks — the card may have been depleted by that very
    // redemption, and a replayed sale must still succeed without re-debiting.
    const prior = await this.priorRedemption(c, card.id, orderId);
    if (prior !== null) return { redeemedMinor: prior, remainingMinor: Number(card.balance_minor) };
    if (card.status !== "active") {
      throw new GiftCardError("CARD_NOT_ACTIVE", `gift card is ${card.status}`);
    }
    if (card.expired) {
      throw new GiftCardError("CARD_EXPIRED", `gift card expired on ${card.expires_at}`);
    }
    const balance = Number(card.balance_minor);
    if (balance < amountMinor) {
      throw new GiftCardError(
        "INSUFFICIENT_BALANCE",
        `redeeming ${amountMinor}, card has ${balance}`,
      );
    }
    const inserted = await c.query(
      `INSERT INTO gift_card_transaction (id, tenant_id, gift_card_id, order_id, kind, amount_minor, note)
       VALUES ($1,$2,$3,$4,'redeem',$5,$6)
       ON CONFLICT DO NOTHING`,
      [randomUUID(), tenantId, card.id, orderId, -amountMinor,
       `redeemed against order ${orderId}`],
    );
    if (inserted.rowCount === 0) {
      // Lost a race we cannot lose under the row lock — treat as replay anyway.
      const raced = await this.priorRedemption(c, card.id, orderId);
      return { redeemedMinor: raced ?? 0, remainingMinor: balance };
    }
    const { rows } = await c.query<{ balance_minor: string }>(
      `UPDATE gift_card
          SET balance_minor = balance_minor - $2,
              status = CASE WHEN balance_minor - $2 = 0 THEN 'depleted' ELSE status END
        WHERE id = $1
        RETURNING balance_minor`,
      [card.id, amountMinor],
    );
    return { redeemedMinor: amountMinor, remainingMinor: Number(rows[0]!.balance_minor) };
  }

  /** Cancel an active card: remaining balance → 0 via a 'cancel' ledger row. */
  async cancel(
    tenantId: string,
    userId: string,
    giftCardId: string,
    reason: string,
  ): Promise<{ cancelledMinor: number }> {
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ balance_minor: string; status: string }>(
        "SELECT balance_minor, status FROM gift_card WHERE id = $1 FOR UPDATE",
        [giftCardId],
      );
      if (!rows[0]) throw new GiftCardError("CARD_NOT_FOUND", "gift card not found");
      if (rows[0].status !== "active") {
        throw new GiftCardError("CARD_NOT_ACTIVE", `gift card is ${rows[0].status}`);
      }
      const remaining = Number(rows[0].balance_minor);
      if (remaining > 0) {
        await c.query(
          `INSERT INTO gift_card_transaction (id, tenant_id, gift_card_id, kind, amount_minor, note)
           VALUES ($1,$2,$3,'cancel',$4,$5)`,
          [randomUUID(), tenantId, giftCardId, -remaining,
           `cancelled by ${userId}: ${reason}`],
        );
      }
      await c.query(
        "UPDATE gift_card SET balance_minor = 0, status = 'cancelled' WHERE id = $1",
        [giftCardId],
      );
      return { cancelledMinor: remaining };
    });
  }

  private async lookup(c: pg.PoolClient, code: string, forUpdate: boolean): Promise<GiftCardRow> {
    const { rows } = await c.query<GiftCardRow>(
      `SELECT id, code, balance_minor, initial_minor, currency, status, expires_at,
              (expires_at IS NOT NULL AND expires_at < CURRENT_DATE) AS expired
         FROM gift_card WHERE code = upper($1)${forUpdate ? " FOR UPDATE" : ""}`,
      [code],
    );
    if (!rows[0]) throw new GiftCardError("CARD_NOT_FOUND", "gift card not found");
    return rows[0];
  }

  /** Positive amount of a prior redemption for (card, order), or null. */
  private async priorRedemption(
    c: pg.PoolClient,
    giftCardId: string,
    orderId: string,
  ): Promise<number | null> {
    const { rows } = await c.query<{ amount_minor: string }>(
      `SELECT amount_minor FROM gift_card_transaction
        WHERE gift_card_id = $1 AND order_id = $2 AND kind = 'redeem'`,
      [giftCardId, orderId],
    );
    return rows[0] ? -Number(rows[0].amount_minor) : null;
  }
}
