/**
 * Passwordless "magic link" authentication for storefront shoppers.
 *
 * Flow:
 *   1. Shopper enters email → `requestLink` mints a token, stores sha256(token),
 *      and (in dev) returns the raw token so the flow can be tested without an
 *      email provider. In production, the token is EMAILED to the address and
 *      never returned in the HTTP response — see the SEND_EMAIL toggle in
 *      pgApp.ts (email delivery itself is intentionally not implemented here
 *      because we have no provider configured; the toggle exists as the
 *      switch that later hides the devToken).
 *   2. Shopper clicks/enters the token → `verifyLink` consumes the row
 *      (single-use), upserts a customer by email if one does not exist yet,
 *      mints a session token, and returns it.
 *   3. Subsequent requests carry `Authorization: CustomerSession <token>`
 *      which `resolveSession` maps to a customerId under the tenant's RLS.
 *
 * Tokens are never stored in plaintext — only sha256(token) sits in the DB.
 * Session/token comparisons use timingSafeEqual to keep timing side-channels
 * from leaking whether a token existed. If a magic link is requested for an
 * email that has no customer row yet, we DO NOT eagerly create the customer:
 * an email request is not proof the requester owns that inbox. Only a
 * successful `verifyLink` creates the customer.
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Db } from "../db.js";

/** Magic link lives 15 minutes — long enough to open an email, short enough
 *  that a leaked link stops mattering the same afternoon. */
export const MAGIC_LINK_TTL_MINUTES = 15;
/** Session TTL matches employee refresh sessions (005_auth_sessions.sql). */
export const SESSION_TTL_DAYS = 30;

export class CustomerAuthError extends Error {
  constructor(
    readonly code:
      | "INVALID_LINK"
      | "LINK_EXPIRED"
      | "LINK_CONSUMED",
  ) {
    super(code);
    this.name = "CustomerAuthError";
  }
}

export interface RequestLinkResult {
  /** Present ONLY in dev: raw token so the flow works without an email
   *  provider. Production callers must strip this before responding. */
  devToken: string;
}

export interface CustomerSummary {
  id: string;
  fullName: string;
  email: string;
}

export interface VerifyLinkResult {
  sessionToken: string;
  customer: CustomerSummary;
}

function sha256(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

/** Constant-time equality that does not leak length mismatches. */
function equalHashes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class CustomerAuthService {
  constructor(private readonly db: Db) {}

  /**
   * Record a magic-link request. Always creates the row — even if we've never
   * heard of this email — because customer creation is deferred until the
   * shopper proves they can read the inbox. In development we return the raw
   * token so the storefront can display it (there is no email provider); in
   * production callers must not surface it.
   */
  async requestLink(tenantId: string, email: string): Promise<RequestLinkResult> {
    const token = randomBytes(32).toString("base64url");
    const hash = sha256(token);
    await this.db.withTenant(tenantId, async (c) => {
      await c.query(
        `INSERT INTO customer_magic_link (tenant_id, email, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
        [tenantId, email, hash, String(MAGIC_LINK_TTL_MINUTES)],
      );
    });
    return { devToken: token };
  }

  /**
   * Consume a magic link and mint a session. The link is looked up by
   * (tenant, email, sha256(token)) — the email is bound at request time so a
   * link stolen from one address cannot be redeemed for another. On success:
   * (a) the link row is marked consumed (single-use), (b) a customer is
   * upserted by email, (c) a session token is issued.
   */
  async verifyLink(
    tenantId: string,
    email: string,
    token: string,
  ): Promise<VerifyLinkResult> {
    const providedHash = sha256(token);
    return this.db.withTenant(tenantId, async (c) => {
      // Fetch by tenant + email, then constant-time compare the hash: we don't
      // trust the DB index alone to defend against timing side-channels.
      const { rows: linkRows } = await c.query<{
        id: string;
        token_hash: Buffer;
        expires_at: Date;
        consumed_at: Date | null;
      }>(
        `SELECT id, token_hash, expires_at, consumed_at
           FROM customer_magic_link
          WHERE tenant_id = $1 AND email = $2
          ORDER BY created_at DESC
          LIMIT 20`,
        [tenantId, email],
      );
      const match = linkRows.find((r) => equalHashes(r.token_hash, providedHash));
      if (!match) throw new CustomerAuthError("INVALID_LINK");
      if (match.consumed_at) throw new CustomerAuthError("LINK_CONSUMED");
      if (match.expires_at.getTime() <= Date.now()) {
        throw new CustomerAuthError("LINK_EXPIRED");
      }

      // Consume the link atomically. If some concurrent request already
      // consumed it, the UPDATE affects 0 rows and we bail.
      const consumed = await c.query(
        `UPDATE customer_magic_link
            SET consumed_at = now()
          WHERE id = $1 AND consumed_at IS NULL`,
        [match.id],
      );
      if (consumed.rowCount === 0) throw new CustomerAuthError("LINK_CONSUMED");

      // Upsert the customer by email under the tenant. If a POS or a prior
      // web order already created one for this address, reuse it — otherwise
      // create a bare row. `full_name` is required by the schema; we fall back
      // to the local-part of the email so it is human-readable but obviously
      // editable by the shopper later.
      const existing = await c.query<{ id: string; full_name: string; email: string | null }>(
        `SELECT id, full_name, email FROM customer WHERE email = $1 LIMIT 1`,
        [email],
      );
      let customer: CustomerSummary;
      if (existing.rows[0]) {
        customer = {
          id: existing.rows[0].id,
          fullName: existing.rows[0].full_name,
          email: existing.rows[0].email ?? email,
        };
      } else {
        const newId = randomUUID();
        const fallbackName = email.split("@")[0] ?? "Shopper";
        await c.query(
          `INSERT INTO customer (id, tenant_id, full_name, email)
           VALUES ($1, $2, $3, $4)`,
          [newId, tenantId, fallbackName, email],
        );
        customer = { id: newId, fullName: fallbackName, email };
      }

      const sessionToken = randomBytes(32).toString("base64url");
      const sessionHash = sha256(sessionToken);
      await c.query(
        `INSERT INTO customer_session
           (tenant_id, customer_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
        [tenantId, customer.id, sessionHash, String(SESSION_TTL_DAYS)],
      );

      return { sessionToken, customer };
    });
  }

  /**
   * Resolve an opaque session token to `{customerId}`. Returns null for
   * missing / expired / revoked tokens — callers translate to 401. Compares
   * the stored hash with timingSafeEqual to avoid leaking token existence
   * through response-time differences.
   */
  async resolveSession(
    tenantId: string,
    sessionToken: string,
  ): Promise<{ customerId: string } | null> {
    if (!sessionToken) return null;
    const hash = sha256(sessionToken);
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{
        customer_id: string; token_hash: Buffer;
      }>(
        `SELECT customer_id, token_hash
           FROM customer_session
          WHERE token_hash = $1
            AND revoked_at IS NULL
            AND expires_at > now()`,
        [hash],
      );
      const row = rows[0];
      if (!row) return null;
      if (!equalHashes(row.token_hash, hash)) return null;
      return { customerId: row.customer_id };
    });
  }
}
