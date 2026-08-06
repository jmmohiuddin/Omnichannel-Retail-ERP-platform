# ADR-003: TypeScript end-to-end, pnpm + Turborepo monorepo

**Status:** Accepted · 2026-08-06

## Context
The platform spans API, web admin, storefront, desktop POS, mobile, and worker processes.
Domain rules (availability math, discount rules, validation) must be identical across
server and offline POS client.

## Decision
TypeScript everywhere (strict mode, ESM). pnpm workspaces + Turborepo for task caching.
The pure domain package (`@omniretail/domain`) is shared by server and clients, so offline
POS enforces the same invariants the server does. Zod schemas are the single source for
validation, static types, and OpenAPI.

## Alternatives rejected
- **Go/Java/C# backend + TS frontends:** stronger raw perf per node, but duplicates the
  domain layer across languages — the offline POS would reimplement (and drift from)
  server rules, which is where inventory bugs are born. Node + Postgres comfortably meets
  our latency targets; hot paths are DB-bound anyway.
- **Nx instead of Turborepo:** more powerful, heavier; Turborepo's simplicity fits.

## Consequences
One hiring profile, shared types from DB to UI. Node's single-thread limits are handled by
horizontal API replicas and moving CPU-heavy work (reports, forecasts) to workers.
