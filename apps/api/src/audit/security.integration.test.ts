/**
 * Security hardening on real PostgreSQL: TOTP MFA login enforcement, the
 * hash-chained audit trail, and channel/listing management.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "@omniretail/db";
import { buildPgApp } from "../pgApp.js";
import { totpCode } from "../auth/totp.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const run = Boolean(ADMIN_URL && APP_URL);

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const base32Decode = (s: string): Buffer => {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

describe.skipIf(!run)("MFA, audit chain, channels", () => {
  let app: ReturnType<typeof buildPgApp>;
  let admin: pg.Pool;
  let ownerToken = "";
  let managerToken = "";
  let tenantId = "";
  let variantId = "";
  const suffix = randomUUID().slice(0, 8);
  const slug = `sec-shop-${suffix}`;
  const ownerEmail = `owner@${slug}.test`;
  const password = "correct-horse-battery";

  const authed = (t: string) => ({ authorization: `Bearer ${t}` });
  const post = (t: string, url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: authed(t), payload: payload as never });
  const login = (body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/v1/auth/login", payload: { slug, password, ...body } });

  beforeAll(async () => {
    await migrate(ADMIN_URL!);
    admin = new pg.Pool({ connectionString: ADMIN_URL!, max: 2 });
    app = buildPgApp({
      databaseUrl: APP_URL!,
      jwtSecret: "integration-test-secret-0123456789abcdef",
    });
    const reg = await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: { tenantName: "Sec Shop", slug, fullName: "Owner", email: ownerEmail, password },
    });
    ownerToken = reg.json().accessToken;
    tenantId = reg.json().tenantId;

    await post(ownerToken, "/v1/users", {
      email: `mgr@${slug}.test`, password: "employee-pass-123", fullName: "Mgr", role: "manager",
    });
    managerToken = (await app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { slug, email: `mgr@${slug}.test`, password: "employee-pass-123" },
    })).json().accessToken;

    const productId = (await post(ownerToken, "/v1/products",
      { name: "Widget", slug: "widget", tracking: "none" })).json().id;
    variantId = (await post(ownerToken, `/v1/products/${productId}/variants`,
      { sku: "WG-1", priceMinor: 1000, currency: "AED" })).json().id;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  it("MFA: enroll → activate → login requires a valid code", async () => {
    const enroll = await post(ownerToken, "/v1/auth/mfa/enroll");
    expect(enroll.statusCode).toBe(200);
    const { base32, otpauthUri } = enroll.json();
    expect(otpauthUri).toContain("otpauth://totp/");
    const secret = base32Decode(base32);

    // Wrong code cannot activate.
    const bad = await post(ownerToken, "/v1/auth/mfa/activate", { code: "000000" });
    expect(bad.statusCode).toBe(401);

    // Enrollment not yet active: password-only login still works.
    expect((await login({ email: ownerEmail })).statusCode).toBe(200);

    const good = await post(ownerToken, "/v1/auth/mfa/activate", {
      code: totpCode(secret, Date.now()),
    });
    expect(good.statusCode).toBe(200);

    // Now: no code → MFA_REQUIRED; wrong code → INVALID_MFA; right code → tokens.
    const noCode = await login({ email: ownerEmail });
    expect(noCode.statusCode).toBe(401);
    expect(noCode.json().error).toBe("MFA_REQUIRED");

    const wrong = await login({ email: ownerEmail, mfaCode: "123456" });
    expect([401]).toContain(wrong.statusCode);

    const ok = await login({ email: ownerEmail, mfaCode: totpCode(secret, Date.now()) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().accessToken).toBeTruthy();
  });

  it("audit trail records sensitive actions and the hash chain verifies", async () => {
    // Generate an approval decision (recorded to the audit log).
    await post(ownerToken, "/v1/inventory/movements", {
      id: randomUUID(), movementType: "receipt", variantId, quantity: 5,
      to: { locationId: (await post(ownerToken, "/v1/locations",
        { kind: "store", name: "S", code: "S9" })).json().id, state: "on_hand" },
      reference: { type: "grn", id: randomUUID() },
    });

    const auditList = await app.inject({ url: "/v1/audit", headers: authed(managerToken) });
    expect(auditList.statusCode).toBe(200);
    const actions = auditList.json().items.map((i: { action: string }) => i.action);
    expect(actions).toContain("user.created");
    expect(actions).toContain("mfa.enabled");

    const verify = await app.inject({ url: "/v1/audit/verify", headers: authed(managerToken) });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().valid).toBe(true);
    expect(verify.json().entries).toBeGreaterThanOrEqual(2);

    // Cashless tamper check: the DB trigger makes audit rows immutable even
    // for the schema owner.
    await expect(
      admin.query("UPDATE audit_log SET action = 'x' WHERE tenant_id = $1", [tenantId]),
    ).rejects.toThrow(/immutable/);
  });

  it("channels + listings: manager publishes a listing the sync engine can push", async () => {
    const channel = await post(managerToken, "/v1/channels", {
      kind: "marketplace", name: "Noon AE", connector: "noon",
    });
    expect(channel.statusCode).toBe(201);
    const channelId = channel.json().id;

    const listing = await app.inject({
      method: "PUT",
      url: `/v1/channels/${channelId}/listings/${variantId}`,
      headers: authed(managerToken),
      payload: { published: true, bufferQty: 2 },
    });
    expect(listing.statusCode).toBe(200);

    const { rows } = await admin.query(
      `SELECT published, buffer_qty FROM channel_listing
        WHERE channel_id = $1 AND variant_id = $2`,
      [channelId, variantId],
    );
    expect(rows[0]).toMatchObject({ published: true });
    expect(Number(rows[0].buffer_qty)).toBe(2);

    const list = await app.inject({ url: "/v1/channels", headers: authed(ownerToken) });
    expect(list.json().items.some((c: { connector: string }) => c.connector === "noon")).toBe(true);
  });
});
