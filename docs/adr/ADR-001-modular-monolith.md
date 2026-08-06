# ADR-001: Modular monolith first, services by extraction

**Status:** Accepted · 2026-08-06

## Context
An omnichannel ERP's hardest correctness problems (inventory + orders + payments) are
transactional. A small team must ship an MVP, iterate fast, and still scale to thousands of
tenants.

## Decision
One deployable TypeScript application with strict internal module boundaries (own tables,
service interfaces, lint-enforced import rules) + a transactional outbox. Connector and AI
workers run as separate processes from day one because they are queue-driven and bursty.

## Alternatives rejected
- **Microservices from day one:** distributed transactions or sagas for the core
  inventory/order path would multiply complexity and failure modes before we have a single
  customer; cross-service data consistency is exactly the problem an inventory ledger must
  not have.
- **Plain monolith (no boundaries):** becomes unextractable; module ownership of tables and
  event contracts is cheap now, priceless later.

## Consequences
Single DB transaction covers sale + movement + level + outbox (our core guarantee).
Extraction path: workers → analytics read replica → per-module services, guided by the
already-defined event contracts. Risk: discipline required to keep boundaries honest —
mitigated by lint rules and code review.
