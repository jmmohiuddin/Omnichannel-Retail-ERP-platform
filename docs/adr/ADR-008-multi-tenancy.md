# ADR-008: Multi-tenancy — shared schema + Postgres RLS

**Status:** Accepted · 2026-08-06

## Context
SaaS for thousands of small-to-mid retailers; strict isolation is a security requirement;
cost per tenant must be near zero at the low end.

## Decision
Single database, shared schema, `tenant_id UUID` on every tenant-owned row, **row-level
security** policies keyed on `current_setting('app.tenant_id')`. The API sets the GUC per
pooled connection at checkout (after JWT verification) and runs as a non-superuser role
that cannot bypass RLS. Cross-tenant queries exist only for the platform-ops role via a
separate connection path, logged.

## Alternatives rejected
- **Schema-per-tenant:** migration fan-out across thousands of schemas is operationally
  painful; connection pooling fragments.
- **Database-per-tenant:** best isolation, worst cost/ops at our tenant size; reserved as
  the *escape hatch* for large enterprise tenants (shared-schema design keeps this move
  possible).
- **App-layer filtering only:** one forgotten `WHERE tenant_id=` is a breach. RLS makes the
  database the enforcement point; app-layer filters remain as defense-in-depth.

## Consequences
Isolation is testable (a CI suite asserts cross-tenant reads return zero rows even with
malicious queries). Slight planner overhead per query — acceptable; indexes lead with
`tenant_id`.
