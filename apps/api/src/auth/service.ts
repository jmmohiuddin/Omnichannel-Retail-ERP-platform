import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { TokenService, hashRefreshToken, newRefreshToken } from "./tokens.js";

const REFRESH_TTL_DAYS = 30;

export class AuthError extends Error {
  constructor(readonly code: "INVALID_CREDENTIALS" | "INVALID_REFRESH" | "SLUG_TAKEN") {
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
  ) {}

  async registerTenant(input: RegisterInput): Promise<TokenPair> {
    const tenantId = randomUUID();
    const userId = randomUUID();
    try {
      await this.db.withPlatform(async (c) => {
        await c.query(
          "INSERT INTO tenant (id, name, slug, base_currency) VALUES ($1,$2,$3,$4)",
          [tenantId, input.tenantName, input.slug, input.currency ?? "USD"],
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
      const roleId = randomUUID();
      await c.query(
        `INSERT INTO role (id, tenant_id, name, is_system, permissions)
         VALUES ($1,$2,'owner',true,'{*}')`,
        [roleId, tenantId],
      );
      await c.query(
        "INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1,$2,$3)",
        [userId, roleId, tenantId],
      );
    });
    return this.issue(tenantId, userId, ["owner"]);
  }

  async login(slug: string, email: string, password: string): Promise<TokenPair> {
    const tenant = await this.db.withPlatform(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM tenant WHERE slug = $1 AND status = 'active'",
        [slug],
      );
      return rows[0];
    });
    if (!tenant) throw new AuthError("INVALID_CREDENTIALS");

    const user = await this.db.withTenant(tenant.id, async (c) => {
      const { rows } = await c.query<{ id: string; password_hash: string | null; roles: string[] }>(
        `SELECT u.id, u.password_hash,
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
    return this.issue(tenant.id, user.id, user.roles);
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
