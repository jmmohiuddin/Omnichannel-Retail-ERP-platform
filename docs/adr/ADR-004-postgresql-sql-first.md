# ADR-004: PostgreSQL 16, SQL-first migrations

**Status:** Accepted · 2026-08-06

## Context
We need ACID transactions across inventory/orders, row-level multi-tenant isolation,
serializable-grade correctness on stock, full-text search, and JSON flexibility for
product specs and connector payloads — plus boring, provable backup/restore.

## Decision
PostgreSQL 16 as the single source of truth. Migrations are hand-written SQL files
(`packages/db/sql/NNN_*.sql`) — the schema *is* a deliverable, with constraints
(uniqueness, checks, FKs, RLS) doing real enforcement work. Application data access uses a
thin typed query layer; no heavyweight ORM owns the schema.

## Alternatives rejected
- **MySQL:** weaker RLS story, weaker JSON/FTS; no advantage.
- **MongoDB (any document store) for core data:** inventory correctness is relational and
  transactional by nature; "flexible schema" is what audit trails must not have.
- **ORM-generated schema (Prisma migrate):** convenient, but hides the constraints and RLS
  policies that are our actual security/correctness surface. (Prisma/Drizzle may still be
  used as a *client*; the SQL stays authoritative.)

## Consequences
DBAs and auditors can read the schema directly. Postgres also covers queues-lite (outbox
via `SKIP LOCKED`), FTS (v1 search), and `LISTEN/NOTIFY` (admin live updates), deferring
extra infrastructure until scale demands it.
