# ADR-006: Transactional outbox + BullMQ/Redis; Kafka deferred

**Status:** Accepted · 2026-08-06

## Context
Inventory changes must propagate to channels reliably — no lost events (silent stock
drift) and no phantom events (events for rolled-back transactions).

## Decision
Domain events are inserted into an `outbox` table in the same DB transaction as the state
change. A relay polls with `FOR UPDATE SKIP LOCKED` and enqueues to BullMQ (Redis).
Consumers are idempotent; event id is the dedupe key; per-aggregate ordering preserved by
sequence number. Retries with exponential backoff; poisoned messages go to a DLQ with an
operator dashboard.

## Alternatives rejected
- **Publish directly to Redis/Kafka in application code:** dual-write problem — a crash
  between commit and publish silently desyncs channels; unacceptable for inventory.
- **Kafka now:** durable log semantics are attractive (and the outbox pattern ports to it
  cleanly later), but operating Kafka for an MVP-scale event volume is pure cost. The
  outbox table already gives us replayable history.
- **Postgres-only queues (Graphile Worker):** viable and considered; BullMQ chosen for its
  mature rate limiting, delayed jobs, and per-queue concurrency controls that connector
  rate-limit compliance needs.

## Consequences
Exactly-once *effect* via at-least-once delivery + idempotent consumers. Outbox table
growth is managed by archival after relay + retention window.
