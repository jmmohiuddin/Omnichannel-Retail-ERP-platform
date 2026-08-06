# Deployment Guide

Production topology (ADR-001/ADR-006): stateless **API** replicas + one-or-more **worker**
processes over managed **PostgreSQL 16** and **Redis**, static frontends on a CDN.

## 1. Prerequisites

- PostgreSQL 16+ (managed: RDS/Cloud SQL/Neon; UAE residency → AWS me-central-1 or
  Azure UAE North per docs/08 §6) with WAL archiving / PITR enabled (RPO ≤ 5 min).
- Redis 7+ (managed) for BullMQ.
- Node 22+ runtime images; `npx -y pnpm` for builds.

## 2. Database roles & migrations

Migrations are SQL-first (`packages/db/sql`, applied in order by the checksum-verified
runner). Three roles, least privilege:

| Role | Used by | Powers |
| --- | --- | --- |
| schema owner (e.g. `omniretail_admin`) | migrations only | DDL |
| `omniretail_app` | API | DML under **forced RLS**; no BYPASSRLS |
| `omniretail_worker` | worker | tenant-GUC DML + narrow `USING(true)` discovery policies |

Migrations 006/008 create the runtime roles with **dev passwords — rotate immediately**:

```bash
psql "$ADMIN_DATABASE_URL" -c "ALTER ROLE omniretail_app PASSWORD '<strong>';"
```

```bash
psql "$ADMIN_DATABASE_URL" -c "ALTER ROLE omniretail_worker PASSWORD '<strong>';"
```

Apply migrations out-of-band or let the API do it at boot (it runs the migrator when
`ADMIN_DATABASE_URL` is set; the advisory lock makes concurrent boots safe):

```bash
DATABASE_URL=... node packages/db/dist/migrate.js
```

## 3. Processes & environment

**API** (`apps/api`, N replicas behind a load balancer):

| Var | Notes |
| --- | --- |
| `DATABASE_URL` | as `omniretail_app` |
| `ADMIN_DATABASE_URL` | optional; boot-time migrations |
| `JWT_SECRET` | ≥ 32 chars, rotated via dual-secret window |
| `ANTHROPIC_API_KEY` | optional; enables Claude narration |
| `PORT` | default 3001 |

**Worker** (`apps/worker`, 1+ instances — outbox relay, event consumer/channel sync,
reservation janitor, hourly ledger drift check):

| Var | Notes |
| --- | --- |
| `WORKER_DATABASE_URL` | as `omniretail_worker` |
| `REDIS_URL` | BullMQ |

**Frontends** (`apps/admin`, `apps/pos`, `apps/storefront`): `vite build` with
`VITE_API_URL` set; deploy `dist/` to a CDN. Pin API CORS origins in production
(replace the dev `origin: true` in `pgApp.ts` with the real origins as part of go-live).

Build once, ship artifacts:

```bash
npx -y pnpm install --frozen-lockfile && npx -y pnpm -r build
```

## 4. Go-live checklist

- [ ] Runtime role passwords rotated; TLS enforced on DB/Redis connections
- [ ] CORS origins pinned; rate limiting enabled at the edge (LB/WAF)
- [ ] Payment gateway adapter configured with merchant credentials + webhook secret;
      webhook URL registered (`/v1/webhooks/payments/<gateway>`)
- [ ] Tenant TRN set before issuing tax invoices (e-invoice validation warns otherwise)
- [ ] Backups verified by an actual restore drill; PITR window confirmed
- [ ] Monitoring: API p95 latency, outbox lag (`SELECT count(*) FROM outbox WHERE
      relayed_at IS NULL`), DLQ depth, `inventory.drift.detected` events (page on any),
      cash-session variance events
- [ ] Log aggregation with tenant/request ids; error alerting
- [ ] Isolation smoke test against prod schema (two tenants, cross-read must be empty)

## 5. Serverless (Vercel) deployment

The repo also deploys to Vercel: the API runs as one serverless function
(`api/index.ts`, reusing a warm Fastify instance), and each frontend deploys as
a static build with `VITE_API_URL` compiled in. Notes that bit us and are now
encoded in `vercel.json` / `api/index.ts`:

- The function entry uses a **dynamic** `import()` of the ESM app — Vercel
  compiles the entry to CommonJS, so a static import fails with `ERR_REQUIRE_ESM`.
- Build frontends from the **repo root** (or prebuilt), never the app
  subdirectory, or `tsconfig.base.json` is missing and TypeScript silently
  falls back to ES3.
- **No migrations at boot** — a cold start must never mutate the schema.

The worker's two self-contained Postgres jobs run as **Vercel Cron** functions
(`api/cron/reservation-janitor`, `api/cron/drift-check`), guarded by a
`CRON_SECRET` bearer token and connecting as `omniretail_worker`
(`WORKER_DATABASE_URL`). **Vercel's Hobby plan caps cron frequency at once/day**,
so these are scheduled daily there; the endpoints are also invokable directly
with the secret, so a Pro plan (real cron cadence) or any external scheduler can
drive them at their intended interval (janitor ~15 min, drift ~hourly).

The **outbox relay and connector/channel sync are NOT on serverless** — they are
queue-consumer processes (BullMQ/Redis) that need a persistent runtime. Host
`apps/worker` on a process platform (Railway/Fly/a VPS) when marketplace sync is
switched on; until then, `order.created`/`inventory.level.changed` events durably
accumulate in the `outbox` table and simply aren't relayed.

## 6. Scaling path

API is stateless — scale horizontally. Workers scale by splitting queues (relay vs
connectors vs jobs); `FOR UPDATE SKIP LOCKED` makes multiple relays safe. Postgres:
read replica for analytics first, partition `stock_movement`/`outbox` by month when hot,
per-tenant database escape hatch for the largest tenants (ADR-008). Search moves to
Meilisearch when catalog scale demands (ADR targets).
