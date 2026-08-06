# Security Architecture — OmniRetail OS

> **Scope.** Multi-tenant SaaS: Fastify API (TypeScript modular monolith), PostgreSQL (single cluster, `tenant_id` + RLS), Redis/BullMQ workers, Tauri desktop POS (offline SQLite queue), React Native mobile, Next.js admin portal and storefront. Inventory is an append-only ledger; every mutation is attributable to `(user_id, device_id)`.
>
> **Audience.** Backend engineers, DevOps, security reviewers. This document is normative: "MUST/SHOULD" carry RFC 2119 meaning.

---

## 1. Threat Model (STRIDE per surface)

Assets we protect, in priority order:

1. Tenant business data (sales, inventory, customers, pricing) — confidentiality + integrity across tenants.
2. The inventory/financial ledger — integrity and attributability (fraud evidence).
3. Credentials and tokens (user JWTs, device tokens, webhook secrets, gateway API keys).
4. Availability of POS checkout (revenue-blocking if down; offline mode is the mitigation).

### 1.1 API (Fastify)

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S**poofing | Stolen/replayed JWT; forged tenant claim | Short-lived access tokens (10 min), `aud`/`iss`/`alg` pinned (ES256 only, reject `none`/`HS256`), refresh rotation with reuse detection (§2.4) |
| **T**ampering | Mass-assignment, IDOR on `tenant_id`/`id` params | Zod/TypeBox schema validation with `additionalProperties: false` on every route; `tenant_id` NEVER read from request body — always from token; RLS as second layer (§3) |
| **R**epudiation | "I never issued that refund" | Hash-chained audit log (§9); all mutations carry `actor_user_id`, `device_id`, `request_id` |
| **I**nfo disclosure | Error leakage, verbose 500s, timing oracles on login | Central error mapper strips stack traces in prod; uniform 401 messages; constant-time credential compare (argon2 verify is inherently so) |
| **D**oS | Credential stuffing, report endpoints as CPU sinks | Rate limits (§7), pagination hard caps, report generation pushed to BullMQ with per-tenant concurrency limits |
| **E**levation | Cashier calls admin route; horizontal privilege across stores | Permission-string check in a Fastify `preHandler` on every route (no "default allow"); store-scope claims checked server-side |

### 1.2 POS device (Tauri desktop)

| STRIDE | Threat | Mitigation |
|---|---|---|
| Spoofing | Rogue device pretending to be a registered till | Device registration + device-bound tokens (§2.5); device key in OS keychain (Keychain/DPAPI via Tauri) |
| Tampering | Editing the offline SQLite queue to alter prices/quantities before sync | Each queued mutation signed with the device key (HMAC over canonical JSON); server verifies on sync; server re-prices from its own catalog — client-sent prices are advisory only except where an authorized override event exists |
| Repudiation | Cashier denies a void/no-sale | Every POS event carries `user_id` (PIN/badge session) + `device_id` + monotonic local sequence number; sequence gaps are flagged on sync |
| Info disclosure | Theft of the physical machine | SQLite queue encrypted (SQLCipher), key in OS keychain; queue holds operational data only — no card PANs ever (PCI §12); remote device revocation kills sync |
| DoS | Offline queue flooding, clock rollback to dodge after-hours rules | Queue size caps; server timestamps are authoritative — client clock recorded but never trusted for policy decisions |
| Elevation | Cashier using an abandoned manager session | POS session auto-lock (default 60 s idle, configurable per tenant); manager override requires fresh second-factor entry (badge/PIN), never session reuse |

### 1.3 Webhooks (inbound: payment gateways, carriers; outbound: tenant integrations)

| STRIDE | Threat | Mitigation |
|---|---|---|
| Spoofing | Forged "payment succeeded" callback | Signature verification (§6); order state machine also polls gateway API for authoritative status on high-value orders |
| Tampering | Modified payload in transit | TLS + HMAC over raw body (verify before JSON parse) |
| Repudiation | Dispute over delivery of outbound webhooks | Delivery log with response codes, retry history, signed payload hash |
| Info disclosure | SSRF via tenant-configured webhook URLs | Outbound URLs validated: https only, DNS-resolved IP must not be RFC1918/link-local/metadata (re-check at connect time to stop DNS rebinding); egress via dedicated proxy |
| DoS | Replay floods of valid signed events | Timestamp tolerance ±5 min + event-ID idempotency table; per-source rate limits |
| Elevation | Webhook body inducing privileged actions | Webhook handlers run as system principals with narrow, hard-coded permissions; they enqueue jobs, never call admin service methods directly |

### 1.4 Admin portal (Next.js)

| STRIDE | Threat | Mitigation |
|---|---|---|
| Spoofing | Session theft via XSS | Tokens in httpOnly, `Secure`, `SameSite=Lax` cookies for the portal; strict CSP (no `unsafe-inline`, nonce-based); React escaping + no `dangerouslySetInnerHTML` without sanitizer |
| Tampering | CSRF on state-changing calls | SameSite + double-submit CSRF token on cookie-authenticated routes; JSON content-type enforcement |
| Repudiation | Disputed config/pricing changes | Audit log covers settings mutations with before/after diffs |
| Info disclosure | Cross-tenant data in cached SSR pages | `Cache-Control: private, no-store` on tenant pages; no shared-CDN caching of authenticated HTML; tenant ID never a cache key input from user control |
| DoS | Expensive exports triggered repeatedly | Exports are BullMQ jobs with per-tenant quotas and dedupe keys |
| Elevation | Manager granting self higher role | Role changes require `rbac:manage` (owner/admin only); nobody can grant a role ≥ their own; owner role transfer requires MFA re-auth step-up |

### 1.5 Storefront (Next.js, public)

| STRIDE | Threat | Mitigation |
|---|---|---|
| Spoofing | Account takeover of shopper accounts | Argon2id hashing, breached-password check on set, login rate limits, optional TOTP |
| Tampering | Client-side price/cart manipulation | Server recomputes every cart line from catalog + promotion engine at checkout; client totals are display-only |
| Repudiation | "I didn't place this order" | Order records bind session, IP, user-agent; payment handled by gateway (3DS where mandated) |
| Info disclosure | Enumeration (emails, order IDs, gift-card codes) | Uniform responses on account endpoints; ULIDs not sequential ints for public IDs; gift-card balance checks rate-limited + require partial PIN |
| DoS | Inventory-hold abuse (carting out stock), scraping | Short reservation TTLs; bot heuristics + rate limits on cart/checkout; scraping mitigations at CDN |
| Elevation | Storefront session reaching admin APIs | Separate token audience (`aud: storefront`); admin routes reject storefront-audience tokens outright |

### 1.6 Job workers (BullMQ/Redis)

| STRIDE | Threat | Mitigation |
|---|---|---|
| Spoofing | Unauthorized job injection into Redis | Redis requires AUTH + TLS, bound to private network; no internet exposure; ACLs restrict commands per service user |
| Tampering | Poisoned job payloads | Workers re-validate payloads with the same Zod schemas as API ingress; payloads carry `tenant_id` which the worker sets as the RLS GUC before any query (§3.3) |
| Repudiation | "Which job changed this?" | Jobs carry `request_id`/`actor` provenance from the originating request; audit entries written by workers include `job_id` |
| Info disclosure | Sensitive data lingering in Redis | Job payloads carry IDs, not documents; `removeOnComplete`/`removeOnFail` with short retention; Redis persistence (RDB/AOF) on encrypted volumes |
| DoS | One tenant's jobs starving others | Per-tenant rate/concurrency via BullMQ group limiter pattern; separate queues for latency-sensitive (stock sync) vs batch (reports) |
| Elevation | Worker using superuser DB role | Workers connect as `app_worker` role: no BYPASSRLS, no DDL; RLS applies to workers exactly as to the API (§3.3) |

---

## 2. Authentication & Authorization

### 2.1 RBAC with permission strings

Authorization decisions are made on **permission strings**, never role names. Roles are bundles of permissions; checks in code look like:

```ts
// route definition
app.post('/refunds', {
  preHandler: [authn, requirePermission('sales:refund:create')],
}, handler);
```

Permission grammar: `domain:resource:action[:qualifier]` — e.g. `inventory:adjustment:approve`, `sales:refund:create`, `pos:price-override`, `reports:financial:read`, `rbac:manage`, `device:register`.

**Role hierarchy** (each level inherits nothing implicitly — bundles are explicit, hierarchy governs *administration*, i.e. who may assign what):

```
owner > admin > manager > cashier / warehouse
```

- **owner** — everything, including billing, `rbac:manage`, owner transfer. Exactly one per tenant (transferable with MFA step-up).
- **admin** — all operational permissions, user management below admin.
- **manager** — store-scoped: approvals (refunds/write-offs/overrides), reports, shift management. Cannot edit roles or tenant settings.
- **cashier** — `pos:sale:create`, `pos:return:initiate`, `pos:drawer:*` events. No approvals, no reports.
- **warehouse** — `inventory:receive`, `inventory:transfer:*`, `inventory:count:submit`. No sales permissions.

Rules:

- A user may hold multiple roles but store-scoped roles carry a `store_ids` scope claim; the server checks scope on every store-bound resource.
- Nobody can grant a permission or role they do not themselves hold ("no privilege amplification").
- Custom roles (Enterprise plan) are compositions of the same permission strings — the check code never changes.
- Deny-by-default: a route without an explicit `requirePermission` fails CI (a route-table lint test walks the Fastify route tree).

### 2.2 MFA (TOTP)

- TOTP (RFC 6238, 30 s step, ±1 step skew), secrets encrypted at rest (§5), 10 single-use recovery codes (argon2-hashed).
- **Mandatory** for owner and admin; per-tenant policy can require it for managers.
- Step-up re-auth (fresh TOTP within 5 min) required for: role changes, device revocation, webhook secret reveal/rotation, data export, owner transfer, disabling MFA.
- Rate limit: 5 TOTP attempts per 5 min per account, then lockout with audit event.

### 2.3 Session policies

| Context | Access token TTL | Refresh TTL | Idle policy |
|---|---|---|---|
| Admin portal | 10 min | 12 h, rotating | Absolute session cap 12 h; re-auth for step-up actions |
| POS device (device token) | 15 min | 30 d, rotating, device-bound | Cashier *user* session on the till locks after 60 s idle (configurable 30–300 s) |
| Mobile app | 10 min | 30 d, rotating | Biometric unlock gates local app open |
| Storefront | 15 min | 90 d, rotating | — |

### 2.4 JWT + rotating refresh tokens

- Access token: ES256, claims `sub`, `tenant_id`, `roles`, `perm_ver` (permission version — bumped on role change so stale tokens fail a cheap Redis check), `aud` (`api` | `pos` | `storefront`), `device_id` (POS/mobile), `jti`.
- Refresh tokens are opaque 256-bit random values, stored hashed (SHA-256) in `auth_sessions` with `family_id`.
- **Rotation with reuse detection:** every refresh issues a new token and marks the old one consumed. Presenting a consumed token ⇒ the whole family is revoked, all sessions for that user+device killed, `auth.refresh_reuse` audit event + security alert. This is the standard defense against refresh-token theft.
- Revocation: `perm_ver` bump (role change), family revoke (logout-all, compromise), device revoke (§2.5). Access tokens are short enough that we accept the ≤10 min revocation lag everywhere except step-up actions, which re-verify against the DB.

### 2.5 Device registration & device-bound POS tokens

1. Admin/manager generates a one-time enrollment code (TTL 15 min) in the portal for a specific store.
2. POS app generates a keypair (P-256) in the OS keystore; sends public key + enrollment code + hardware fingerprint (hostname, OS, Tauri app version; fingerprint is informational, the key is the identity).
3. Server creates `devices` row (`device_id`, `tenant_id`, `store_id`, `pubkey`, `status=active`) and issues a device refresh token **bound to the key**: refresh requests must be signed (DPoP-style proof: signature over `htm`, `htu`, `iat`, `jti` with the device key). A stolen refresh token is useless without the private key, which never leaves the keystore.
4. Cashier login on a registered device = short PIN or badge scan → user session *layered on* the device session. Sales require both: `device_id` from the device token, `user_id` from the cashier session.
5. Revocation (`status=revoked`) takes effect at next token refresh (≤15 min) and immediately blocks sync endpoints via a Redis device-status check.

Offline: the device keeps working against local SQLite; queued mutations are signed with the device key and verified at sync. A revoked device's queued events are quarantined for manager review, not silently applied.

---

## 3. Multi-Tenant Isolation (Postgres RLS)

### 3.1 Design

Single database, every tenant-owned table has `tenant_id UUID NOT NULL`. Isolation is enforced **in the database**, not only in application code — a bug in a query can't cross tenants.

```sql
-- Every tenant table:
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales FORCE ROW LEVEL SECURITY;  -- applies to table owner too

CREATE POLICY tenant_isolation ON sales
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

- `current_setting('app.tenant_id')` with **no** `missing_ok=true` fallback in the policy: if the GUC is unset, the query errors instead of returning zero rows silently masking a bug. (We deliberately do not use `current_setting(..., true)` + `COALESCE` — fail loud.)
- `WITH CHECK` on the same policy blocks cross-tenant INSERT/UPDATE, not just reads.
- App connects as `app_user` / `app_worker`: `NOSUPERUSER`, `NOBYPASSRLS`, no DDL. Migrations run as a separate `app_migrator` role in CI/CD only.
- `tenant_id` also participates in composite indexes as the leading column (`(tenant_id, created_at)` etc.), so RLS predicates stay index-friendly.

### 3.2 Setting the GUC safely with a pool

With pg-pool, `SET` leaks across checkouts. We use transaction-scoped settings:

```ts
await pool.transaction(async (tx) => {
  await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]); // true = transaction-local
  // ... all queries for this request
});
```

The data-access layer exposes only `withTenant(tenantId, fn)`; raw pool access is lint-banned outside that module. `tenantId` comes exclusively from the verified JWT — never from a header, body, or query param.

### 3.3 Workers

BullMQ processors receive `tenant_id` in the job payload (written by the enqueuing request, which took it from the token). The worker wrapper sets the GUC identically before invoking the processor. A processor that queries without the wrapper hits the fail-loud policy error.

### 3.4 Isolation testing strategy

- **Policy coverage test:** CI query against `pg_tables`/`pg_policies` asserting every table containing a `tenant_id` column has RLS enabled + forced + a `WITH CHECK` policy. New table without a policy = red build.
- **Two-tenant fixture suite:** seed tenants A and B with overlapping data shapes; for every repository method, run as A and assert zero B rows returned, and assert INSERT/UPDATE with B's `tenant_id` under A's GUC raises. Auto-generated per repository via a shared harness.
- **GUC-unset test:** every repository method under an unset GUC must error, not return `[]`.
- **API-level probes:** integration tests replay real routes with tenant A's token but tenant B's resource IDs → expect 404 (not 403, to avoid existence leaks).
- **Quarterly manual red-team pass** on new endpoints, focusing on aggregate/report endpoints and raw-SQL analytics paths (the historical RLS escape hatches: views owned by privileged roles, `SECURITY DEFINER` functions — both require security review to merge).

---

## 4. Secrets Management

- **Source of truth:** cloud secrets manager (AWS Secrets Manager / GCP Secret Manager). No secrets in env files in repos, no secrets in CI logs. Local dev uses `.env` with dev-only values; `.env*` is gitignored and gitleaks runs in CI + pre-commit.
- **Categories & rotation:**
  - DB credentials — rotated 90 d (or IAM auth where available).
  - JWT signing keys — ES256 keypair, rotated 90 d with `kid` in header; JWKS endpoint retains previous key for the overlap window.
  - Webhook signing secrets — per tenant *and* per endpoint, rotated on demand with dual-secret overlap (§6).
  - Gateway API keys — per tenant, stored encrypted with envelope encryption (KMS data keys), decrypted only in the payment module process path.
  - TOTP seeds — encrypted at rest with a dedicated KMS key (never the general app key).
- **Access:** services get only their own secrets via IAM; humans access production secrets through break-glass with audit trail; no shared "prod password" documents.
- POS devices hold exactly one secret: their private key, in the OS keystore. No API keys ship in the desktop/mobile binaries (anything in a client binary is public).

## 5. Encryption

**In transit:** TLS 1.2+ (1.3 preferred) everywhere external; internal service↔DB/Redis also TLS. HSTS (2 y, preload) on all web properties. Certificates via managed ACME; no self-signed in prod.

**At rest:**

- Postgres volumes + WAL archive + backups: provider block-level encryption (AES-256) with KMS keys.
- Column-level (application-layer, AES-256-GCM envelope): TOTP seeds, gateway credentials, webhook secrets, OAuth tokens for integrations. Nonce per record; key IDs stored beside ciphertext for rotation.
- POS SQLite: SQLCipher, per-device key from OS keystore.
- We do **not** store card PANs/CVV anywhere, in any form (§12).
- Redis: no durable business data; encrypted volume + short TTLs.

## 6. Webhook Signature Verification

**Inbound (gateways, carriers):** verify the provider's HMAC over the **raw body** (Fastify raw-body capture on webhook routes only), constant-time compare, check timestamp tolerance (±5 min), then idempotency-check the event ID in `webhook_events (provider, event_id UNIQUE)`. Only then parse and enqueue. Verification failures return 401 and increment an alert counter (spike = someone probing).

**Outbound (tenant integrations):**

```
X-OmniRetail-Signature: t=1717430400,v1=hex(hmac_sha256(secret, `${t}.${rawBody}`))
```

- Timestamp inside the signed string prevents replay; documented tolerance ±5 min.
- Per-endpoint secrets, shown once at creation; rotation issues a second secret and we sign with both (`v1=` twice) for 24 h so tenants can roll without downtime.
- Retries with exponential backoff (immediately, 1 min, 10 min, 1 h, 8 h), then endpoint auto-disabled after 3 days of failure + email to tenant admins.
- Delivery log retains status codes and payload hash (not full payload) for dispute resolution.

## 7. Rate Limiting & Abuse Prevention

Sliding-window counters in Redis (`@fastify/rate-limit` with Redis store), keyed per concern:

| Endpoint class | Key | Limit (default) |
|---|---|---|
| Login / token | IP **and** account (both must pass) | 10/min IP, 5/5min account, exponential lockout with audit event |
| TOTP verify | account | 5/5min |
| Password reset request | IP + email | 3/h |
| Public storefront API | IP | 120/min |
| Authenticated API | tenant + user | 600/min tenant, 120/min user (plan-scaled) |
| POS sync | device | 60/min (burst tolerant for post-offline catch-up) |
| Gift card balance / promo validation | IP + code prefix | 10/min (enumeration targets) |
| Webhook ingest | provider IP allowlist where published + 429 beyond 100/min/source | |

Additional abuse controls: response-size caps and mandatory pagination (max 200 rows); global per-tenant BullMQ job quotas; anomaly alerts on 401/403/429 rate spikes per tenant; CAPTCHA only as escalation on storefront auth (never on POS). All limits return `Retry-After` and are logged with the rate-limit key (not the raw credential).

## 8. OWASP Top 10 (2021) → Concrete Mitigations

| # | Category | Mitigation in this stack |
|---|---|---|
| A01 | Broken Access Control | Deny-by-default `requirePermission` preHandler + route-lint test; store-scope claims; RLS as DB backstop; 404-not-403 for cross-tenant IDs |
| A02 | Cryptographic Failures | TLS everywhere, argon2id passwords, AES-256-GCM envelope for sensitive columns, ES256 JWTs with pinned alg, no home-rolled crypto (libsodium/node:crypto only) |
| A03 | Injection | Parameterized queries only (query-builder w/ bound params); lint ban on template-string SQL; Zod validation at every ingress incl. workers; no `eval`, no shell-outs with user input |
| A04 | Insecure Design | This document + threat-model review required in PR template for new surfaces; ledger append-only by construction |
| A05 | Security Misconfiguration | IaC-managed infra, CIS-benchmarked images, `@fastify/helmet`, strict CSP, no default creds, prod/staging config drift detection |
| A06 | Vulnerable Components | Renovate + `npm audit`/OSV scanning in CI (fail on high), lockfiles committed, SBOM generated per release, Tauri/RN dependency pinning |
| A07 | Ident./Authn Failures | MFA, rotation+reuse detection, device binding, breached-password checks, uniform auth errors, session policies (§2.3) |
| A08 | Software & Data Integrity | Signed POS updates (Tauri updater signature), signed offline queue entries, hash-chained audit log, CI provenance (locked runners, no `curl \| bash`) |
| A09 | Logging & Monitoring Failures | Structured logs w/ `request_id`/`tenant_id`, security event stream (§9), alerting on auth anomalies, 400-day audit retention |
| A10 | SSRF | Outbound webhook/integration URL validation with IP re-resolution, egress proxy, metadata endpoint blocked at network policy |

## 9. Audit Logging (append-only, hash-chained)

**Table:**

```sql
CREATE TABLE audit_log (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     UUID NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id UUID,          -- NULL for system/webhook principals
  actor_type    TEXT NOT NULL, -- user | device | system | webhook
  device_id     UUID,
  request_id    TEXT,
  event_type    TEXT NOT NULL, -- e.g. 'sales.refund.approved'
  entity_type   TEXT, entity_id TEXT,
  payload       JSONB NOT NULL,       -- before/after diff or event data
  prev_hash     BYTEA NOT NULL,
  entry_hash    BYTEA NOT NULL        -- sha256(prev_hash || canonical(row fields))
);
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM app_user, app_worker;
```

- **Hash chain per tenant:** `entry_hash = SHA-256(prev_hash ‖ canonical_json(tenant_id, occurred_at, actor, event_type, entity, payload))`. Computed in a DB trigger so application code cannot skip it. Any retroactive edit breaks every subsequent hash.
- **Anchoring:** nightly job writes each tenant's latest `entry_hash` to external write-once storage (S3 Object Lock, compliance mode). Verification job re-walks recent chain segments and compares against anchors; mismatch = P1 incident.
- **What gets logged:** all auth events (login, MFA, refresh reuse, lockout), all RBAC changes, device lifecycle, every approval/override (see fraud doc), settings and price changes (with diffs), data exports, webhook secret operations. Business mutations themselves live in domain event tables; `audit_log` links via `entity_type/entity_id`.
- **Redaction:** payloads never contain secrets, PANs, or password material — enforced by a serializer allowlist per event type.
- Retention: 400 days hot, then archived to object storage (7 y for financial-relevant events, per tenant jurisdiction config).

## 10. Backup & Disaster Recovery

- **RPO 5 min:** continuous WAL archiving (pgBackRest/WAL-G) to object storage in a second region, `archive_timeout=300s` forcing a segment ship at least every 5 min even under low write volume.
- Nightly full base backup + WAL = point-in-time recovery to any second within retention (35 d).
- **RTO targets:** primary AZ loss → streaming replica promotion, ≤15 min (automated, tested monthly). Region loss → restore from cross-region WAL archive, ≤4 h. Single-tenant logical corruption (bad import, malicious admin) → PITR clone + targeted `tenant_id` extract, ≤8 h, without touching other tenants.
- Backups encrypted with distinct KMS keys; restore requires a role no app service holds.
- **Restore drills:** monthly automated restore of latest backup into an isolated env + row-count/checksum verification; a backup that hasn't been restored is Schrödinger's backup.
- Redis is rebuildable (jobs re-enqueued from outbox tables); POS devices are inherently their own edge cache — offline mode is the availability story for checkout during any backend incident.

## 11. Incident Response Basics

- **Severities:** P1 cross-tenant data exposure / active breach / ledger integrity failure; P2 single-tenant compromise, token-theft indicators, POS fleet issue; P3 vuln found internally, no exploitation evidence.
- **First hour (P1/P2):** assign incident commander; snapshot evidence (don't reboot away logs); contain — revoke affected token families and devices, bump `perm_ver`, rotate exposed secrets, feature-flag off affected surface; RLS + audit chain give the blast-radius query ("which tenants' rows did this principal touch").
- Kill switches (pre-built, tested): global logout (family revoke all), per-tenant API freeze, per-device revoke, webhook egress pause.
- Notification: tenant owners notified for confirmed exposure of their data per contract/DPA timelines; regulators per jurisdiction (e.g., 72 h GDPR).
- Post-incident: blameless review within 5 business days; action items tracked to closure; detection gap analysis (why didn't §9 alerts fire earlier?).
- Contact surface: `security@` + `/.well-known/security.txt`; safe-harbor vulnerability disclosure policy.

## 12. PCI Scope Avoidance (Gateway Tokenization)

Design goal: keep OmniRetail OS out of PCI DSS SAQ D by **never touching PANs**.

- **Storefront:** gateway-hosted fields/iframes (Stripe Elements-class) — card data goes browser→gateway; we receive only a payment token + last4/brand metadata.
- **POS card-present:** semi-integrated terminals. The POS sends amount+reference to the terminal (local IP/cloud API); the terminal handles card capture, P2PE, and returns an authorization reference. Card data never crosses the POS app, the SQLite queue, or our API. Offline card capture is **not supported** — offline queue accepts cash/other tenders only, or store-and-forward handled entirely inside the terminal vendor's certified stack.
- **Refunds** reference the gateway charge ID; card-not-present refunds to a different card are impossible by construction (also a fraud control — see FP-014 in the fraud doc).
- We store: gateway customer/payment-method tokens, last4, brand, expiry month/year (allowed data), auth references. We never store: PAN, full track, CVV (storage of CVV is prohibited even encrypted).
- Resulting scope: SAQ A / A-EP posture for e-com flows and the terminal vendor's P2PE listing for card-present; annual review of gateway integrations to confirm no PAN path has crept in (grep-able CI check for PAN-like regex in logs is also a DLP guard).

---

*Companion document: [`02-fraud-prevention-controls.md`](./02-fraud-prevention-controls.md) — internal (employee-facing) fraud controls built on this architecture, especially §2.5 device binding and §9 audit logging.*
