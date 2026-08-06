# Sync Policies

**Status:** Normative. These policies govern the sync engine and all connectors. Terms (buffers, `erpVersion`, error classes, queues) are defined in `01-connector-architecture.md`.

---

## 1. Inventory Allocation Across Channels

Two modes, selectable **per tenant, per SKU-group (category/tag), overridable per SKU**:

### 1.1 Shared pool (default)

All channels sell from one available-to-sell pool:

```
ATS(channel) = on_hand − hard_reservations − global_safety_stock − buffer(channel)
```

- `global_safety_stock`: absolute units or % of on-hand (default 0).
- `buffer(channel)`: `max(fixed_buffer, ceil(on_hand × buffer_pct))`, defaults by channel propagation speed (Shopify 0–1; Amazon/Meta 2 or 5%; Woo/Daraz 1 or 3%). See `02-marketplace-connectors.md` §10 for per-platform recommendations.
- Maximizes sell-through; oversell risk is bounded by buffers + the zero-fast rule.

### 1.2 Per-channel allocation

Fixed split of the pool: `alloc(channel)` units are ring-fenced; a channel can only sell its allocation. Used for: contractual commitments (Walmart in-stock SLAs), flash sales on one channel, marketplace penalty-sensitive SKUs.

- Allocations must sum to ≤ on_hand − global_safety_stock; the remainder ("unallocated") may back-fill channels per a priority list, or stay held.
- **Auto-switch threshold:** in shared-pool mode, when `on_hand − hard_reservations ≤ allocation_switch_threshold` (default 5 units), the engine may switch the SKU to allocation mode using the channel priority list (e.g. POS > Shopify > Amazon), so the last units go to the highest-margin/lowest-penalty channel. Switch and revert are logged and visible on the dashboard.

### 1.3 Rebalancing

Nightly job (and on-demand) recomputes allocations from trailing 14-day channel velocity. Manual pins always win. Every allocation change emits `inventory.allocation.changed` (audited).

---

## 2. Reservation Lifecycle

Reservations bridge "order seen" and "stock committed", preventing double-sale between channels and POS.

```
            created ──────► confirmed ──────► consumed (shipment/pos sale posts)
               │                 │
               │ TTL expiry      │ order cancelled / rejected
               ▼                 ▼
            released ◄────────────
```

| State | Meaning | TTL | On expiry |
|---|---|---|---|
| `created` | Soft hold from a not-yet-final signal (checkout started at POS, marketplace order in `pending`/unpaid, payment initiated) | POS cart: 15 min. E-com/marketplace unpaid: 60 min (Daraz/COD flows: 24 h, configurable) | auto-`released`, stock returns to pool, ATS re-pushed |
| `confirmed` | Hard reservation — order is paid/acknowledged; counts in `hard_reservations` | none (indefinite) | n/a — only leaves via consumed/released |
| `consumed` | Stock decremented by shipment/fulfillment posting | terminal | |
| `released` | Hold dropped (expiry, cancellation, import rejection) | terminal | |

Rules:

1. Transitions are recorded append-only (`reservation_events`), each carrying the causing event id (order import job, webhook, POS txn) for audit.
2. `created → confirmed` must be idempotent (payment webhook may arrive twice).
3. A `confirmed` reservation for a channel order survives ERP restarts and reconciliations; it is released **only** by a channel-confirmed cancellation or operator override (override requires reason code, is audited).
4. Any transition that changes `hard_reservations` triggers the inventory push pipeline (debounced, zero-fast rule applies).

---

## 3. Order Import State Machine

Applies to every channel order entering ERP, from webhook or poll (both converge on the same importer; dedupe on `(tenant, channel_account, channel_order_id)`).

```
 received ─► validated ─► mapped ─► reserved ─► imported ─► synced_back
     │            │           │          │
     ▼            ▼           ▼          ▼
  duplicate   quarantined  quarantined  imported(+oversell_risk flag)
  (discard,   (validation  (SKU/customer
   count)      errors)      mapping failed)
```

| State | Description | Failure handling |
|---|---|---|
| `received` | Raw payload persisted (webhook_inbox / poll page) | never lost; replayable |
| `validated` | Schema + business validation (currency known, totals consistent, lines ≥ 1) | `config`/`permanent` errors → `quarantined` with error taxonomy class; operator queue |
| `mapped` | Channel SKUs → ERP SKUs (connector mapping + alias table); customer matched/created per tenant policy | unmapped SKU → `quarantined` with one-click "create alias" operator action; auto-retry after alias fix |
| `reserved` | `confirmed` reservation per line (paid orders) or `created` (unpaid/COD) | insufficient stock → still import, flag `oversell_risk`, run §9.2 sequence |
| `imported` | ERP sales order created; financials (tax/fees) recorded from channel totals — **channel totals win**, ERP never recomputes a marketplace's tax | |
| `synced_back` | Acknowledge sent where required (Walmart/Daraz RTS), internal `order.created` outbox event emitted for downstream (OMS, accounting) | ack failure retries per taxonomy; overdue ack alerts (SLA-aware per channel) |

Lifecycle after import mirrors the channel (channel = source of truth): status updates from the channel map onto the ERP order (`cancelled`, `refunded`...); ERP-initiated changes go through the connector and apply only on channel confirmation.

---

## 4. Returns & Refunds per Channel

General flow: `return.requested (channel) → return.authorized → items received → disposition (restock | write-off | quarantine) → refund executed → refund confirmed`.

Policies:

1. **Refund executor is channel-specific:** marketplaces that control the money (Amazon, TikTok, Daraz, Walmart, eBay-managed-payments, Meta checkout) execute refunds on-platform — ERP *records* them (from webhooks/polls) and posts accounting entries; ERP never double-refunds. Direct channels (Shopify + gateway, Woo + gateway, POS) execute refunds **through the ERP** via the payment provider abstraction (`02` §11.5), then push status to the channel.
2. **Restock is disposition-gated:** a refund never auto-restocks. Stock returns to the pool only when a receiving user (or automated rule for pristine e-com returns) posts a disposition. Restock triggers the normal inventory push pipeline.
3. **Auto-approval rules** per channel account: value threshold, category exclusions, fraud-flag exclusion. Everything else lands in an operator queue with channel SLA countdown (marketplaces penalize slow return handling).
4. Partial refunds/returns are line-level; shipping-refund handling follows channel rules and is recorded distinctly for margin reporting.
5. All inbound return events are idempotent on `(channel_account, channel_return_id)`.

---

## 5. Price Sync Cadence

1. **Event-driven push** on `price.changed` (debounced 30 s per SKU per channel) — the primary mechanism.
2. **Scheduled promotions:** price changes with `effective_at` are pre-staged; the scheduler pushes at T−(channel propagation estimate) so the change lands on time (Amazon feed lead time ≈ minutes–hours; Shopify ≈ seconds).
3. **Daily price audit** (part of nightly reconciliation): full snapshot diff; drift auto-corrected per §4.6 of `01` (channel-run promos excluded from drift).
4. **Floor guard:** pushes below `price_floor(sku)` are blocked (`config` error, operator alert) — protects against fat-fingered bulk edits propagating to nine channels in a minute.
5. Currency per channel account; conversion only via tenant-configured price lists, never implicit FX.

---

## 6. Listing Publish Workflow

```
draft ─► validated ─► queued ─► publishing ─► live
            │                       │            │
            ▼                       ▼            ▼
        rejected(local)     rejected(channel)  update loop (revalidate → patch)
```

1. **Local validation first:** `listings.validate()` runs channel rules (title length, image count/size, required category attributes — e.g. Amazon product-type schema, eBay aspects, TikTok qualifications) *before* any API call. Issues are shown in the listing editor with channel-specific messages.
2. **Publish** is queued per channel account (rate-governed); async channels (Amazon, Walmart feeds) track via async handles; per-item channel rejections map to `permanent`/`config` taxonomy and appear as actionable listing errors, never silent.
3. **Identity mapping:** on success the channel listing id (`inventory_item_id`, ASIN, offer id...) is stored in `channel_listings`; that mapping is the join key for all subsequent inventory/price pushes.
4. **Updates** re-run validation, then patch only changed fields where the API allows (Etsy's whole-document inventory update is serialized per listing to avoid clobbering).
5. **End/unpublish** keeps mapping rows (tombstoned) so history and re-publish remain possible.

---

## 7. Error Taxonomy (normative)

| Class | Definition | Examples | Retry | Operator action |
|---|---|---|---|---|
| `transient` | Would likely succeed if retried unchanged | 5xx, timeout, connection reset, channel maintenance window | Exponential backoff + jitter, max 8 attempts → DLQ | Only if DLQ'd |
| `rate_limited` | Explicit throttle | 429, `QuotaExceeded`, Shopify `THROTTLED` | Reschedule at `retryAfterMs`; no attempt burn; adaptive rate cut | None (dashboard signal if chronic) |
| `permanent` | Same input will always fail | validation rejection, entity deleted on channel, duplicate detected, unsupported category | None → DLQ immediately | Inspect / fix payload / replay or discard |
| `config` | Account/setup problem affecting a whole capability | expired/revoked token, missing scope, unmapped location/warehouse, price floor violation, feed schema version sunset | None; **capability paused** for the account | Required — health goes `degraded`, actionable message with fix link |

Classification is the **connector's** job (`ChannelError.class`); the engine's behavior is uniform. Misclassification bugs (retrying permanents, DLQ-ing transients) are treated as connector defects and covered by the conformance suite.

---

## 8. Sync Health Dashboard (operator-facing requirements)

Per tenant, per channel account:

1. **Status tile:** health state (`healthy / degraded / failing / paused`), current capability toggles, token expiry horizon, pinned API version + sunset date.
2. **Freshness:** last successful order poll, last order webhook received, last inventory push acked, last reconciliation run + duration — each with expected-cadence coloring ("no order webhook in 6 h on a store averaging 8/h" flags even though nothing errored).
3. **Queues:** depth + oldest-job age per queue (inventory, price, orders, listings), DLQ depth with one-click drill-down to payload + error chain + replay/edit/discard.
4. **Drift panel:** last reconciliation's counts — SKUs corrected, orders found by recon (should be 0), listing field diffs pending review; trend sparkline; >0.5% drift alert state.
5. **Oversell panel:** open `oversell_risk` orders with age and resolution state (§9.2).
6. **Error stream:** taxonomy-classified, grouped by code, with per-code counts and first/last seen — not a raw log dump.
7. **Actions:** pause/resume capability, force reconciliation, force full inventory push, reconnect auth, replay DLQ selection, switch SKU allocation mode. Every action audited (who/when/why).
8. **Alert routing:** `config` errors and DLQ-depth breaches page per tenant tier; drift and freshness anomalies notify via digest.

---

## 9. Sequence Descriptions

### 9.1 Marketplace order import (happy path, webhook-accelerated)

1. Channel fires order webhook → webhook gateway persists raw payload to `webhook_inbox` (dedupe on delivery id), enqueues parse job, returns 200 fast.
2. Connector host runs `verifyAndParseWebhook()` → HMAC verified → normalized `ChannelOrder`.
3. Importer dedupes on `(tenant, account, channel_order_id)` — new → `received → validated → mapped` (SKU aliases resolve; customer matched).
4. Paid order → `confirmed` reservations created per line inside one Postgres transaction with the ERP sales order (`imported`) and an outbox row (`order.created`).
5. Reservation change triggers inventory recompute → debounced ATS pushes fan out to all *other* channel accounts (zero-fast lane if any SKU hit 0).
6. Where required, `orders.acknowledge` is queued (Walmart ack, Daraz RTS is later at fulfillment) → `synced_back`.
7. Next scheduled poll re-sees the order; idempotent importer no-ops; poll cursor advances. (If the webhook had been lost, this poll is where the order enters — same path from step 3.)

### 9.2 Oversell near-miss

1. On-hand for SKU `X` is 1; Shopify and Daraz both show ATS 1 (buffers exhausted at low stock; SKU is below `allocation_switch_threshold` but operator pinned shared mode).
2. Shopify order for `X` imports; reservation confirmed; on-hand−reservations = 0. Zero-fast lane pushes ATS 0 to all channels immediately (skips debounce, priority queue).
3. Before Daraz processes the update (propagation gap ~seconds–minutes), a Daraz order for `X` arrives via poll.
4. Importer attempts reservation → insufficient stock. Policy: **import anyway** (channel owns its order lifecycle; silently dropping a marketplace order is worse) with flag `oversell_risk`; no confirmed reservation is created against phantom stock.
5. Engine reacts: (a) re-pushes 0 to every channel for `X` (idempotent), (b) checks inbound purchase orders / transfer stock at other locations for coverage, (c) opens an operator task with resolution options: fulfill from another location, backorder (if channel tolerates), or cancel on-channel via `orders.cancel` with reason (recorded against channel metrics awareness — cancelling on Amazon/Walmart has account-health cost, so the task shows the metric impact warning).
6. Resolution recorded; if fulfilled, a normal reservation/consumption posts; if cancelled, the channel confirms and the order closes `cancelled`. Post-mortem counter `oversell_near_miss{channel,sku}` feeds buffer auto-tuning (persistent near-misses on a channel raise its `buffer_pct` suggestion).

### 9.3 Full reconciliation

1. Scheduler fires nightly per channel account (staggered per tenant, ≤25% token budget) or operator forces a run.
2. Engine streams `snapshot('inventory', page)` — connector uses the channel's bulk path (Shopify Bulk Operations JSONL, Amazon inventory report, Etsy paged listings...).
3. For each row: compare channel qty vs expected `ATS(channel)` computed from ERP at snapshot watermark (versions stamped, so pushes in flight during the run don't count as drift — rows whose `erpVersion` changed mid-run are skipped and picked up next cycle).
4. Mismatches → corrective absolute pushes (normal pipeline, idempotent), `drift_corrected{sku}` metrics. Drift ratio >0.5% of SKUs → alert instead of silent healing, since systemic drift means a broken mapping or a paused webhook, not noise.
5. `snapshot('orders')` over the last 72 h → any channel order missing in ERP is imported through the standard state machine and increments `orders_found_by_recon` (target 0; alert if >0 two nights running).
6. `snapshot('listings')`/`('prices')` → field-level diffs; auto-overwrite or review-queue per tenant policy; channel-run promos excluded.
7. Run summary (duration, pages, corrections, gaps, errors) written to the dashboard drift panel; reconciliation job itself obeys the same retry/DLQ machinery — a failed run resumes from its last completed page cursor.
