import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export interface AccessClaims {
  userId: string;
  tenantId: string;
  roles: string[];
}

const ISSUER = "omniretail-api";
const ACCESS_TTL = "15m";

export class TokenService {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    if (secret.length < 32) {
      throw new Error("JWT_SECRET must be at least 32 characters");
    }
    this.key = new TextEncoder().encode(secret);
  }

  async signAccess(claims: AccessClaims): Promise<string> {
    return new SignJWT({ ten: claims.tenantId, roles: claims.roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(ACCESS_TTL)
      .sign(this.key);
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER });
    if (typeof payload.sub !== "string" || typeof payload.ten !== "string") {
      throw new Error("malformed token");
    }
    return {
      userId: payload.sub,
      tenantId: payload.ten,
      roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
    };
  }
}

/** Opaque refresh token: 256-bit random; only its sha256 is stored (rotating). */
export function newRefreshToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
