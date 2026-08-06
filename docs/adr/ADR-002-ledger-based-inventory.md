# ADR-002: Ledger-based (append-only) inventory

**Status:** Accepted · 2026-08-06

## Context
Requirements demand: no silent inventory changes, full traceability, employee fraud
prevention, offline POS sync, and multi-channel consistency.

## Decision
Stock levels are derived from an append-only `stock_movement` ledger (double-entry style:
movements between typed stock buckets). A transactionally-maintained `stock_level` table is
a read-model only, verifiable by replay. Corrections are compensating movements.
Serialized units (IMEI) are individually tracked rows with their own state machine.

## Alternatives rejected
- **Mutable quantity columns + audit log table:** audit can diverge from state (the classic
  ERP hole fraud walks through); replay/verification impossible.
- **Event sourcing the whole system:** right idea for inventory, overkill for catalog/CRM;
  full ES adds snapshotting/versioning complexity everywhere for benefit only inventory
  needs.

## Consequences
Every stock question ("why is on-hand 3?") has a provable answer. The ledger sequence
doubles as the sync cursor for POS and connectors. Costs: writes do slightly more work
(movement + level upsert in one tx); a periodic drift-check job compares replayed vs
materialized levels and alarms on mismatch.
