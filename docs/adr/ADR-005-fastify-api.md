# ADR-005: Fastify + Zod + OpenAPI for the API layer

**Status:** Accepted · 2026-08-06

## Context
The API must be low-latency (POS commits), well-documented (tenant integrations), and
strictly validated (multi-tenant safety).

## Decision
Fastify as the HTTP host (fastest mainstream Node framework, first-class schema
validation, plugin encapsulation maps cleanly to our modules). Zod defines every
request/response schema once → runtime validation + TS types + generated OpenAPI 3.1.
REST resource design; webhooks out to tenants with HMAC signatures.

## Alternatives rejected
- **NestJS:** popular in enterprise, but its DI/decorator framework adds indirection and
  startup cost without adding correctness; our module system already provides structure.
- **tRPC/GraphQL as the primary API:** tRPC couples clients to TS internals (bad for
  public API); GraphQL's flexible queries complicate rate limiting, caching, and RLS
  reasoning for v1. GraphQL may later front the admin BFF if screen-shaped queries demand it.

## Consequences
One schema source of truth; public API docs fall out of the build. Fastify plugins give
per-module encapsulation (auth, rate limits) that mirrors ADR-001 boundaries.
