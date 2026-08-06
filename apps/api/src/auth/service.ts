import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { TokenService, hashRefreshToken, newRefreshToken } from "./tokens.js";
import {
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  otpauthUri,
  verifyTotp,
} from "./totp.js";

const REFRESH_TTL_DAYS = 30;

export class AuthError extends Error {
  constructor(
    readonly code:
      | "INVALID_CREDENTIALS"
      | "INVALID_REFRESH"
      | "SLUG_TAKEN"
      | "UNKNOWN_ROLE"
      | "MFA_REQUIRED"
      | "INVALID_MFA",
  ) {
    super(code);
    this.name = "AuthError";
  }
}

export interface RegisterInput {
  tenantName: string;
  slug: string;
  currency?: string;
  fullName: string;
  email: string;
  password: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  userId: string;
  tenantId: string;
}

/**
 * Tenant provisioning + credential auth + rotating refresh sessions.
 * Every login/refresh is attributable; refresh tokens are stored only as
 * sha256 hashes and are single-use (rotation chains via rotated_from).
 */
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly tokens: TokenService,
    /** App secret for MFA secret encryption (JWT secret in v1). */
    private readonly appSecret: string,
    private readonly audit?: import("../audit/auditService.js").AuditService,
  ) {}

  async registerTenant(input: RegisterInput): Promise<TokenPair> {
    const tenantId = randomUUID();
    const userId = randomUUID();
    try {
      await this.db.withPlatform(async (c) => {
        await c.query(
          "INSERT INTO tenant (id, name, slug, base_currency) VALUES ($1,$2,$3,$4)",
          [tenantId, input.tenantName, input.slug, input.currency ?? "AED"],
        );
      });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new AuthError("SLUG_TAKEN");
      throw err;
    }

    const passwordHash = await hashPassword(input.password);
    await this.db.withTenant(tenantId, async (c) => {
      await c.query(
        `INSERT INTO app_user (id, tenant_id, email, full_name, password_hash, status)
         VALUES ($1,$2,$3,$4,$5,'active')`,
        [userId, tenantId, input.email, input.fullName, passwordHash],
      );
      // System roles. Permission strings are coarse in v1; the role names are
      // what approval/decision checks key on (manager and up may approve).
      const roleId = randomUUID();
      await c.query(
        `INSERT INTO role (id, tenant_id, name, is_system, permissions) VALUES
           ($1,$5,'owner',true,'{*}'),
           ($2,$5,'manager',true,'{sales.*,inventory.*,approvals.decide,catalog.*}'),
           ($3,$5,'cashier',true,'{sales.create,catalog.read,inventory.read}'),
           ($4,$5,'warehouse',true,'{inventory.*,catalog.read}')`,
        [roleId, randomUUID(), randomUUID(), randomUUID(), tenantId],
      );
      await c.query(
        "INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1,$2,$3)",
        [userId, roleId, tenantId],
      );
      // Native channels exist from day one; marketplace channels attach later.
      await c.query(
        `INSERT INTO channel (id, tenant_id, kind, name) VALUES
         ($1,$3,'pos','Main POS'), ($2,$3,'web','Web Store')`,
        [randomUUID(), randomUUID(), tenantId],
      );
      // System actor: attributes automated movements (web reservations, sync
      // jobs) in the ledger. No password — it can never log in.
      await c.query(
        `INSERT INTO app_user (id, tenant_id, email, full_name, status)
         VALUES ($1,$2,'system@omniretail.internal','System','active')`,
        [randomUUID(), tenantId],
      );
    });
    return this.issue(tenantId, userId, ["owner"]);
  }

  /** Step 1 of MFA enrollment: mint a secret, return it for the authenticator app. */
  async enrollMfa(
    tenantId: string,
    userId: string,
  ): Promise<{ base32: string; otpauthUri: string }> {
    const { secret, base32 } = generateTotpSecret();
    const email = await this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ email: string | null }>(
        "SELECT email FROM app_user WHERE id = $1",
        [userId],
      );
      if (!rows[0]) throw new AuthError("INVALID_CREDENTIALS");
      // Not enabled until a code is verified — losing the phone mid-enrollment
      // must not lock the account.
      await c.query(
        "UPDATE app_user SET totp_secret_enc = $2, mfa_enabled = false WHERE id = $1",
        [userId, encryptSecret(secret, this.appSecret)],
      );
      return rows[0].email ?? "user";
    });
    return { base32, otpauthUri: otpauthUri(base32, email) };
  }

  /** Step 2: prove possession of the authenticator, then enforce MFA at login. */
  async activateMfa(tenantId: string, userId: string, code: string): Promise<{ enabled: true }> {
    await this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ totp_secret_enc: Buffer | null }>(
        "SELECT totp_secret_enc FROM app_user WHERE id = $1",
        [userId],
      );
      const enc = rows[0]?.totp_secret_enc;
      if (!enc) throw new AuthError("INVALID_MFA");
      if (!verifyTotp(decryptSecret(enc, this.appSecret), code, Date.now())) {
        throw new AuthError("INVALID_MFA");
      }
      await c.query("UPDATE app_user SET mfa_enabled = true WHERE id = $1", [userId]);
      await this.audit?.recordWith(c, tenantId, {
        actorUserId: userId,
        action: "mfa.enabled",
        entityType: "app_user",
        entityId: userId,
      });
    });
    return { enabled: true };
  }

  async login(slug: string, email: string, password: string, mfaCode?: string): Promise<TokenPair> {
    const tenant = await this.db.withPlatform(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM tenant WHERE slug = $1 AND status = 'active'",
        [slug],
      );
      return rows[0];
    });
    if (!tenant) throw new AuthError("INVALID_CREDENTIALS");

    const user = await this.db.withTenant(tenant.id, async (c) => {
      const { rows } = await c.query<{
        id: string; password_hash: string | null; roles: string[];
        mfa_enabled: boolean; totp_secret_enc: Buffer | null;
      }>(
        `SELECT u.id, u.password_hash, u.mfa_enabled, u.totp_secret_enc,
                coalesce(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
           FROM app_user u
           LEFT JOIN user_role ur ON ur.user_id = u.id
           LEFT JOIN role r ON r.id = ur.role_id
          WHERE u.email = $1 AND u.status = 'active'
          GROUP BY u.id`,
        [email],
      );
      return rows[0];
    });
    if (!user?.password_hash || !(await verifyPassword(password, user.password_hash))) {
      throw new AuthError("INVALID_CREDENTIALS");
    }
    if (user.mfa_enabled) {
      if (!mfaCode) throw new AuthError("MFA_REQUIRED");
      if (!user.totp_secret_enc ||
          !verifyTotp(decryptSecret(user.totp_secret_enc, this.appSecret), mfaCode, Date.now())) {
        throw new AuthError("INVALID_MFA");
      }
    }
    return this.issue(tenant.id, user.id, user.roles);
  }

  /** Create an employee user with one system role (owner/admin action). */
  async createUser(
    tenantId: string,
    input: { email: string; password: string; fullName: string; role: string },
  ): Promise<{ userId: string }> {
    const userId = randomUUID();
    const passwordHash = await hashPassword(input.password);
    await this.db.withTenant(tenantId, async (c) => {
      const role = await c.query<{ id: string }>(
        "SELECT id FROM role WHERE name = $1",
        [input.role],
      );
      if (!role.rows[0]) throw new AuthError("UNKNOWN_ROLE");
      await c.query(
        `INSERT INTO app_user (id, tenant_id, email, full_name, password_hash, status)
         VALUES ($1,$2,$3,$4,$5,'active')`,
        [userId, tenantId, input.email, input.fullName, passwordHash],
      );
      await c.query(
        "INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1,$2,$3)",
        [userId, role.rows[0].id, tenantId],
      );
      await this.audit?.recordWith(c, tenantId, {
        action: "user.created",
        entityType: "app_user",
        entityId: userId,
        after: { email: input.email, role: input.role },
      });
    });
    return { userId };
  }

  /**
   * Rotate a refresh token. The tenant comes from the caller's (possibly
   * expired) access token claims — session rows are tenant-scoped under RLS,
   * so an unscoped lookup would see nothing.
   */
  async refreshForTenant(tenantId: string, refreshToken: string): Promise<TokenPair> {
    const hash = hashRefreshToken(refreshToken);
    return this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM user_session
          WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [hash],
      );
      const session = rows[0];
      if (!session) throw new AuthError("INVALID_REFRESH");

      await c.query("UPDATE user_session SET revoked_at = now() WHERE id = $1", [session.id]);

      const { rows: roleRows } = await c.query<{ name: string }>(
        `SELECT r.name FROM role r JOIN user_role ur ON ur.role_id = r.id
          WHERE ur.user_id = $1`,
        [session.user_id],
      );
      const next = newRefreshToken();
      await c.query(
        `INSERT INTO user_session (tenant_id, user_id, refresh_token_hash, expires_at, rotated_from)
         VALUES ($1,$2,$3, now() + interval '${REFRESH_TTL_DAYS} days', $4)`,
        [tenantId, session.user_id, next.hash, session.id],
      );
      const accessToken = await this.tokens.signAccess({
        userId: session.user_id,
        tenantId,
        roles: roleRows.map((r) => r.name),
      });
      return { accessToken, refreshToken: next.token, userId: session.user_id, tenantId };
    });
  }

  private async issue(tenantId: string, userId: string, roles: string[]): Promise<TokenPair> {
    const refresh = newRefreshToken();
    await this.db.withTenant(tenantId, async (c) => {
      await c.query(
        `INSERT INTO user_session (tenant_id, user_id, refresh_token_hash, expires_at)
         VALUES ($1,$2,$3, now() + interval '${REFRESH_TTL_DAYS} days')`,
        [tenantId, userId, refresh.hash],
      );
    });
    const accessToken = await this.tokens.signAccess({ userId, tenantId, roles });
    return { accessToken, refreshToken: refresh.token, userId, tenantId };
  }
}
