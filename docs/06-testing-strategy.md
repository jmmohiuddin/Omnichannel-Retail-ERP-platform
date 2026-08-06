# Testing Strategy

411+ tests across 10 packages. The strategy is layered, and the layers are deliberate:
the bugs each layer has actually caught are listed at the bottom, because that is the
evidence the strategy works.

## Layers

1. **Pure domain units** (`packages/domain`, pos-core, connector-sdk, frontend `lib/`
   modules): the ledger engine, VAT/forecast math, IMEI rules, cart/tender logic, rate
   limiting/retry — all deterministic, no I/O, injectable clocks/randomness. Fast enough
   to run on every save.
2. **Postgres integration** (`*.integration.test.ts`): run against a real PostgreSQL 16
   with the REAL runtime roles — the API suite connects as `omniretail_app` (forced RLS
   active), worker suites as `omniretail_worker`. Auto-skip unless `ADMIN_DATABASE_URL`
   (+ `DATABASE_URL` for API suites) are set, so `pnpm -r test` still passes anywhere.
   These tests exercise the DB's own enforcement: CHECK constraints, partial unique
   indexes, triggers, RLS policies — not mocks of them.
3. **HTTP contract**: integration tests drive the app via `fastify.inject` end-to-end
   (register → catalog → sell → refund → journal), asserting status codes and the exact
   error taxonomy clients depend on.
4. **Frontend logic units**: every app keeps logic in pure `src/lib` modules tested with
   mocked fetch; components stay thin. No browser E2E yet — that is the next investment
   (Playwright against docker-compose) when UI churn slows.

## Conventions that matter

- **Fresh-or-populated must both pass.** CI and local runs execute the whole suite twice
  against the same database. Anything that only passes on a fresh DB is a bug in the
  test (unscoped assertions) or in the code (global-uniqueness collisions) — both kinds
  were caught this way (see below).
- **Tenant-scoped assertions.** Suites share one database and run files in parallel;
  every assertion filters by the suite's own randomly-suffixed tenant.
- **Idempotency is tested explicitly**: offline sale replay, webhook redelivery,
  migration re-runs, importer re-pulls, accrual replays.
- **No sleeping/polling in tests**; injectable clocks (rate limiter, AI budget) and
  scripted fakes (courier feeds, connector pulls) keep them deterministic.
- **Migration discipline**: the runner refuses checksum-changed applied migrations; the
  advisory lock makes parallel `migrate()` calls (parallel test files, multi-replica
  boot) safe.

## CI

GitHub Actions (`.github/workflows/ci.yml`): Postgres 16 service container; install →
build → typecheck → full test suite with both DB URLs, so every integration test runs
on every push. The mobile app is verified by strict typecheck + logic units only (no
native toolchain in CI) and says so in its README.

## Bugs these layers actually caught (kept as regression rationale)

- `INSERT … ON CONFLICT` cannot apply negative deltas: CHECK constraints evaluate on the
  proposed row *before* conflict resolution — stock debits must UPDATE-or-fail.
- Order-import movement ids derived only from the marketplace order id collided across
  channels/tenants on the global `stock_movement` PK (fresh-vs-populated double run).
- `current_setting('app.tenant_id')` reads back as an **empty string** (not NULL) on
  reused pooled connections → `''::uuid` crashes; `current_tenant_id()` now NULLIFs.
- Tenantless webhooks could see zero `payment_intent` rows under forced RLS — fixed with
  a transaction-local opt-in lookup policy rather than any blanket bypass.
- Outbox relay tests with global count assertions flaked against sibling suites —
  rewritten tenant-scoped with drain loops (test-quality bug, same class as above).
