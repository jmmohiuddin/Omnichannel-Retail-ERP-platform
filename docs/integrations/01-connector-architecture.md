# Connector Architecture & SDK Contract

**Audience:** platform engineers building/maintaining connectors; core team maintaining the sync engine.
**Status:** Living design doc. The SDK contract below is the stable surface; internals may evolve.

---

## 1. Design Principles

1. **Core never changes for a new channel.** Connectors are independent npm packages (`@omniretail/connector-shopify`, `@omniretail/connector-amazon-sp`, ...) that implement the SDK contract and are loaded by the connector host at runtime. Adding a marketplace is a deploy of a package + a registry row, not a core release.
2. **ERP is the source of truth for stock and catalog.** Channels are the source of truth for their own order lifecycle. All conflict-resolution rules derive from this (see §4.6).
3. **Everything is idempotent and replayable.** Every outbound push and inbound import carries an idempotency key; every job can be retried or re-run from a reconciliation snapshot without corrupting state.
4. **Rate limits are a first-class concern.** No connector talks to a remote API except through the token-bucket-governed transport the host injects (§4.7).
5. **Fail loudly, degrade gracefully.** A dead connector must never block POS sales or other channels. Per-connector isolation: separate BullMQ queues, separate circuit breakers, separate DLQs.

---

## 2. Topology

```
┌────────────────────────────── Core Monolith (TypeScript) ──────────────────────────────┐
│  Domain modules: Inventory, Orders, Catalog, Pricing, Returns                          │
│  PostgreSQL  ──►  transactional outbox (outbox_events table)                           │
└───────────────┬────────────────────────────────────────────────────────────────────────┘
                │ outbox relay (poll + LISTEN/NOTIFY)
                ▼
        BullMQ / Redis event bus
   topics: inventory.level.changed, price.changed, order.created,
           listing.updated, return.approved, ...
                │
                ▼
┌──────────────────────────── Connector Host (worker process pool) ──────────────────────┐
│  Sync Engine: routing, fan-out, idempotency store, rate governor, retry/DLQ,           │
│               reconciliation scheduler, drift detector                                 │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐               │
│  │ shopify vX    │ │ amazon-sp vX  │ │ woo vX        │ │ tiktok vX     │  ...          │
│  │ (SDK impl)    │ │ (SDK impl)    │ │ (SDK impl)    │ │ (SDK impl)    │               │
│  └───────┬───────┘ └───────┬───────┘ └───────┬───────┘ └───────┬───────┘               │
└──────────┼─────────────────┼─────────────────┼─────────────────┼───────────────────────┘
           ▼                 ▼                 ▼                 ▼
       Shopify API       SP-API           Woo REST          TikTok Shop API
```

Inbound path: a thin, always-up **webhook gateway** (separate HTTP service) accepts channel webhooks, verifies nothing beyond size/shape, persists the raw payload to `webhook_inbox`, and enqueues a job. Signature verification and parsing happen in the connector host via `verifyAndParseWebhook()` — the gateway stays dumb so a connector bug can't take down ingestion.

---

## 3. Connector SDK Contract

A connector is a package whose default export satisfies `ConnectorDefinition`. The host instantiates one `ConnectorInstance` per **(tenant, channel account)** pair.

```ts
// @omniretail/connector-sdk

/** Capabilities a connector may declare. The sync engine only schedules work
 *  for declared capabilities; everything else is skipped for that channel. */
export type ConnectorCapability =
  | 'listings'        // create/update product listings on the channel
  | 'inventorySync'   // push stock levels
  | 'orderImport'     // pull/receive orders
  | 'priceSync'       // push prices
  | 'statusSync'      // push fulfillment/tracking status
  | 'returns';        // receive/acknowledge returns & refunds

export interface ConnectorDefinition {
  /** Stable machine id, e.g. 'shopify', 'amazon-sp'. Never reused. */
  id: string;
  displayName: string;
  /** Semver of the connector package. Host enforces compat range (§6.4). */
  version: string;
  /** Minimum SDK version this connector was built against. */
  sdkVersion: string;
  capabilities: ConnectorCapability[];
  auth: AuthDescriptor;
  /** Default rate policy; can be overridden per tenant in the registry. */
  rateLimits: RatePolicy;
  /** JSON schema for per-account settings shown in the admin UI
   *  (e.g. "location mapping", "price list", "safety stock %"). */
  settingsSchema: object;

  create(ctx: ConnectorContext): ConnectorInstance;
}

export interface ConnectorContext {
  tenantId: string;
  channelAccountId: string;          // one merchant may connect 2 Shopify stores
  credentials: CredentialAccessor;   // decrypt-on-read, never raw in config (§6.2)
  settings: Record<string, unknown>; // validated against settingsSchema
  http: RateLimitedHttpClient;       // ALL remote calls go through this (§4.7)
  logger: Logger;                    // structured, pre-tagged with tenant/channel
  clock: Clock;                      // injectable for tests
  /** Durable per-account KV for cursors, sync tokens, feed ids, etc. */
  state: ConnectorStateStore;
  /** Report health signals; feeds the ops dashboard + circuit breaker. */
  health: HealthReporter;
}

export interface ConnectorInstance {
  // ---- lifecycle -------------------------------------------------------
  /** Validate credentials & required scopes. Called on registration and
   *  periodically by the health monitor. Must be side-effect free. */
  testConnection(): Promise<ConnectionTestResult>;
  /** Optional: register webhooks, create fulfillment service, etc. Idempotent. */
  install?(): Promise<void>;
  uninstall?(): Promise<void>;

  // ---- outbound (ERP -> channel) --------------------------------------
  inventory?: {
    /** Push absolute quantities. Batch-oriented: connector decides how to
     *  chunk for the remote API (e.g. Shopify inventorySetQuantities vs
     *  Amazon JSON_LISTINGS_FEED). MUST be idempotent per (sku, version). */
    setLevels(updates: InventoryLevelUpdate[]): Promise<PushResult<InventoryLevelUpdate>>;
  };
  pricing?: {
    setPrices(updates: PriceUpdate[]): Promise<PushResult<PriceUpdate>>;
  };
  listings?: {
    publish(listing: ListingPayload): Promise<ListingResult>;
    update(listing: ListingPayload): Promise<ListingResult>;
    end(channelListingId: string): Promise<void>;
    /** Channel-specific validation BEFORE we attempt publish (category
     *  attributes, image rules, title length...). Cheap, no side effects. */
    validate(listing: ListingPayload): Promise<ValidationIssue[]>;
  };
  fulfillment?: {
    pushStatus(update: FulfillmentUpdate): Promise<void>; // tracking no, carrier, items
  };

  // ---- inbound (channel -> ERP) ----------------------------------------
  orders?: {
    /** Cursor-based incremental pull. Returns normalized orders + next cursor.
     *  Used by the poller AND by backfill. Must tolerate overlap (idempotent). */
    pull(cursor: string | null, window?: TimeWindow): Promise<PullPage<ChannelOrder>>;
    /** Ack/decline hooks where the channel requires it (e.g. Walmart acknowledge). */
    acknowledge?(channelOrderId: string): Promise<void>;
    cancel?(channelOrderId: string, reason: string): Promise<void>;
  };
  returns?: {
    pull(cursor: string | null): Promise<PullPage<ChannelReturn>>;
    approve?(channelReturnId: string): Promise<void>;
    refund?(req: RefundRequest): Promise<RefundResult>;
  };

  // ---- webhooks --------------------------------------------------------
  /** Verify signature and translate the raw payload into zero or more
   *  normalized events. Throwing WebhookVerificationError drops + alerts. */
  verifyAndParseWebhook?(req: RawWebhookRequest): Promise<NormalizedChannelEvent[]>;
  /** Topics to subscribe to during install(). */
  webhookTopics?(): string[];

  // ---- reconciliation --------------------------------------------------
  /** Stream the channel's CURRENT view of state for drift detection.
   *  Paged; may take minutes. Used by full-resync jobs (§4.8). */
  snapshot(kind: 'inventory' | 'listings' | 'orders' | 'prices',
           page: string | null): Promise<PullPage<ChannelSnapshotRow>>;
}
```

### 3.1 Key shared types

```ts
export interface InventoryLevelUpdate {
  idempotencyKey: string;        // `${tenant}:${channelAccount}:inv:${sku}:${version}`
  sku: string;
  channelListingRef?: string;    // cached remote id (inventory_item_id, ASIN+SKU...)
  quantity: number;              // absolute available-to-sell AFTER buffer applied
  erpVersion: number;            // monotonically increasing per-sku version (§4.4)
  locationRef?: string;          // channel location/warehouse mapping
}

export interface ChannelOrder {
  channelOrderId: string;        // remote id — dedupe key with channelAccountId
  channelOrderNumber?: string;   // human-facing
  placedAt: string;              // ISO 8601, channel timezone normalized to UTC
  status: 'pending' | 'paid' | 'partially_shipped' | 'shipped'
        | 'cancelled' | 'refunded' | 'unknown';
  currency: string;
  lines: ChannelOrderLine[];     // sku mapping resolved by connector when possible
  shipping: Address & { method?: string; cost?: Money };
  buyer: { name?: string; email?: string; phone?: string; maskedByChannel: boolean };
  totals: { subtotal: Money; shipping: Money; tax: Money; discount: Money; grand: Money };
  raw: unknown;                  // original payload, stored for audit/replay
}

export interface PushResult<T> {
  succeeded: T[];
  failed: Array<{ item: T; error: ChannelError }>;
  /** For async APIs (Amazon feeds): a handle the engine polls via checkAsync. */
  asyncHandle?: string;
}

export type ChannelErrorClass = 'transient' | 'permanent' | 'config' | 'rate_limited';

export interface ChannelError {
  class: ChannelErrorClass;      // drives retry vs DLQ vs operator alert (§4.9)
  code: string;                  // connector-namespaced, e.g. 'SHOPIFY_THROTTLED'
  message: string;
  retryAfterMs?: number;         // honor channel Retry-After
  raw?: unknown;
}
```

**Contract rules (enforced by SDK conformance tests):**

- Every method must be safe to call twice with the same input (idempotent) — the engine *will* retry.
- Connectors never sleep/poll internally for rate limits; they throw `ChannelError{class:'rate_limited', retryAfterMs}` and let the governor reschedule.
- Connectors never touch Postgres, Redis, or the outbox directly. Only `ctx.*`.
- `raw` payloads are always preserved for audit; PII in `raw` is encrypted at rest (§6.2).

---

## 4. Sync Engine Design

### 4.1 Outbound: event-driven push (inventory & price)

1. Domain code commits a stock change and an `inventory.level.changed` row to the **transactional outbox** in the same Postgres transaction (so no event is lost or phantom).
2. The outbox relay publishes to BullMQ topic `inventory.level.changed`.
3. The **fan-out router** looks up all channel accounts for the tenant with capability `inventorySync` and enqueues one job per channel account into that connector's dedicated queue: `sync:{connectorId}:{channelAccountId}:inventory`.
4. Jobs are **debounced/coalesced per SKU**: if 5 changes for SKU `TSHIRT-M-RED` are queued before dispatch, only the latest `erpVersion` is sent (BullMQ job id = `inv:{sku}` with replace-on-add). This collapses flash-sale storms into one API call.
5. The connector's `inventory.setLevels()` is invoked with a batch (batch size from `RatePolicy.maxBatch`).

Price sync uses the identical pipeline on `price.changed`, plus a scheduled daily "price audit" push (see `03-sync-policies.md` §5).

### 4.2 Inbound: webhooks + polling (orders), belt and suspenders

- **Webhooks are an optimization, polling is the guarantee.** Every connector with `orderImport` gets a poll schedule (default: every 2 min for the last 15 min window, sliding, overlap-tolerant). Webhook receipt *advances* the poll cursor opportunistically but never replaces polling — channels drop webhooks (Shopify explicitly documents at-least-once-but-may-miss; Woo webhooks die silently when the store's cron is wedged).
- Webhook flow: gateway persists raw → job → `verifyAndParseWebhook()` → normalized events → order import pipeline.
- Poll flow: scheduler → `orders.pull(cursor)` → same import pipeline. **Both paths converge on the same idempotent importer**, deduped on `(tenantId, channelAccountId, channelOrderId)` with a unique index.

### 4.3 Idempotency

Three layers:

| Layer | Key | Store |
|---|---|---|
| Outbound push | `idempotencyKey` on every update (`tenant:acct:kind:entity:version`) | `sync_idempotency` table, unique index; TTL 30 days |
| Inbound import | `(tenant_id, channel_account_id, channel_order_id)` | unique index on `channel_orders` |
| Webhook receipt | channel delivery id (e.g. `X-Shopify-Webhook-Id`) or SHA-256 of body | `webhook_inbox` unique index |

The engine records the idempotency key **before** calling the connector and marks it complete after; a crash between the two re-runs the call, which is why connector methods must themselves be idempotent (absolute quantities, not deltas — see next).

### 4.4 Absolute values + versioning, never deltas

Inventory pushes always send **absolute available-to-sell quantities** stamped with a per-SKU monotonically increasing `erpVersion` (Postgres sequence bumped inside the stock transaction). The engine refuses to dispatch an update whose `erpVersion` is lower than the last acknowledged version for that `(channelAccount, sku)` — this makes out-of-order delivery harmless and retries trivially safe. Deltas are banned from the wire.

### 4.5 Per-channel buffers & oversell prevention

Available-to-sell for channel *c* is computed as:

```
ATS(c) = on_hand − hard_reservations − safety_stock_global − buffer(c)
buffer(c) = max(channel_fixed_buffer, ceil(on_hand × channel_buffer_pct))
```

- **Buffers** absorb the propagation window (webhook→push latency) during which two channels can sell the same last unit. Defaults: fast channels (Shopify) buffer 0–1 unit; slow-propagation channels (Amazon feeds can take minutes) buffer 2 units or 5%, whichever is greater. Configurable per channel account in `settingsSchema`.
- **Low-stock clamp:** when `ATS(c)` for any channel falls to ≤ the channel's `lowStockThreshold` (default 3), the engine switches that SKU to **priority push** (skips debounce window, jumps queue with BullMQ priority) and optionally to per-channel *allocation mode* (hard split of the pool — policy in `03-sync-policies.md` §1).
- **Zero-fast rule:** transitions to 0 are always pushed immediately to *all* channels before any non-zero updates in the queue (a dedicated high-priority lane), because the cost asymmetry is severe: showing 0 when you have 1 loses a sale; showing 1 when you have 0 creates an oversell, a cancellation, and (on Amazon/Walmart) a metric strike.
- **Oversell backstop:** if an imported order would drive on-hand negative, the importer still accepts the order (channel owns its lifecycle), flags it `oversell_risk`, triggers an immediate zero-push to all channels, and opens an operator task (sequence in `03-sync-policies.md` §9.2).

### 4.6 Conflict resolution rules

| Domain | Source of truth | Rule |
|---|---|---|
| Stock levels | **ERP** | Channel-side stock is never imported into ERP stock. Drift detected by reconciliation is corrected by pushing ERP values out. Exception: channel-managed fulfillment (FBA) — FBA stock is tracked as a *separate ERP location* fed from SP-API reports; ERP is then truth for the aggregate, Amazon for the FBA location's counts. |
| Catalog / listings | **ERP** | Channel-side edits (a merchant editing a title in Shopify admin) are detected as drift; policy per tenant: `overwrite` (default) or `flag_for_review`. |
| Prices | **ERP** | Same as listings. Channel promotions applied *by the channel* (e.g. TikTok subsidy) do not count as drift — connectors must distinguish list price from promo price. |
| Order lifecycle | **Channel** | ERP never invents channel order states. Cancellations/refunds initiated on the channel flow in and are applied. ERP-initiated cancellation goes *through* the connector (`orders.cancel`) and is only recorded once the channel confirms. |
| Fulfillment status | **ERP** (it ships the goods) | Pushed to channel via `fulfillment.pushStatus`; channel is truth only for channel-fulfilled models (FBA, Walmart WFS). |

### 4.7 Rate-limit-aware queueing

- Each channel account gets a **token bucket** in Redis (`rate:{connectorId}:{channelAccountId}[:endpointGroup]`), refilled per `RatePolicy`:

```ts
export interface RatePolicy {
  buckets: Array<{
    /** e.g. 'default', 'graphql-cost', 'feeds', 'orders' — connectors can
     *  declare separate buckets for APIs with per-endpoint-group limits. */
    group: string;
    capacity: number;        // burst
    refillPerSecond: number; // sustained
    /** cost model: 1 per call, or dynamic (Shopify GraphQL returns actual
     *  query cost — connector reports it back via ctx.http hooks). */
    costing: 'perCall' | 'reported';
  }>;
  maxBatch: number;
  maxConcurrent: number;     // parallel in-flight requests per account
}
```

- The injected `RateLimitedHttpClient` acquires tokens before dispatch; on `429`/`RATE_LIMITED` it **reports observed limits back**, and the governor adaptively shrinks refill (AIMD: cut rate 50% on throttle, +5% per clean minute, capped at policy). Honors `Retry-After` exactly.
- BullMQ workers use `groupKey = channelAccountId` limiting so one tenant's Amazon storm can't starve another tenant sharing the worker pool.

### 4.8 Retry, DLQ, backfill, reconciliation

- **Retry:** transient errors → exponential backoff with full jitter: `delay = rand(0, min(cap, base × 2^attempt))`, base 2 s, cap 15 min, max 8 attempts. `rate_limited` errors don't consume attempts (they reschedule at `retryAfterMs`). `permanent`/`config` errors skip retries entirely.
- **DLQ:** exhausted/permanent jobs land in `dlq:{connectorId}:{channelAccountId}` with the full payload, error chain, and idempotency key. Operator UI supports inspect / edit-payload / replay / discard. DLQ depth > 0 for 15 min pages the on-call for that tenant tier.
- **Backfill:** on first connect (or gap recovery) the engine runs `orders.pull` over a bounded historical window (default 30 days, operator-configurable) in paged jobs, throttled to ≤ 25% of the account's token budget so live sync is not starved.
- **Reconciliation ("full resync"):** scheduled (default nightly per account, staggered) and on-demand. The engine streams `snapshot(kind, page)` and diffs against ERP truth:
  - **Inventory drift:** `channel_qty ≠ expected_qty` → auto-corrective push + drift metric. Drift rate > 0.5% of SKUs triggers an alert (something systemic — bad location mapping, a paused webhook — is wrong; auto-correcting silently would mask it).
  - **Order gaps:** channel orders absent from ERP → import immediately + increment `orders_found_by_recon` (should be ~0; nonzero means webhooks/polling have a hole).
  - **Listing drift:** field-level diff, applied per tenant policy (§4.6).
  - Full sequence narrative in `03-sync-policies.md` §9.3.

### 4.9 Error taxonomy (summary — full table in `03-sync-policies.md` §7)

| Class | Examples | Engine behavior |
|---|---|---|
| `transient` | 5xx, timeouts, connection reset | retry w/ backoff → DLQ |
| `rate_limited` | 429, throttle codes | reschedule, no attempt burn, adaptive rate |
| `permanent` | validation rejected, entity gone, duplicate | DLQ immediately, no retry |
| `config` | expired token, revoked scope, bad location map | **pause capability**, alert operator, health = degraded |

---

## 5. Async-API handling (feeds pattern)

Some channels (Amazon feeds, Walmart bulk items) are submit-then-poll. The SDK models this with `PushResult.asyncHandle`; the engine schedules a poll job (`connector.checkAsync(handle)` — optional method, required if any method returns handles) with its own backoff (30 s → 5 min). Results are mapped back to the original idempotency keys so per-item failures route to the taxonomy above. Connectors must persist handle→items mapping in `ctx.state`, not memory.

---

## 6. Connector Lifecycle

### 6.1 Registration

1. Package published to the private registry; CI runs the **SDK conformance suite** (idempotency double-call tests, error-class mapping tests, webhook verification tests against recorded fixtures).
2. A row in `connector_registry` (id, version, capabilities, settingsSchema hash, compat range) makes it available to tenants.
3. Tenant admin connects an account: OAuth dance or key entry (per `AuthDescriptor`) → credentials stored (§6.2) → `testConnection()` → `install()` (webhook registration etc.) → optional initial backfill + first reconciliation snapshot → account goes `active`.

### 6.2 Credential storage

- Per-tenant envelope encryption: credentials encrypted with a per-tenant data key (AES-256-GCM); data keys wrapped by the platform KMS master key (AWS KMS / Vault transit). Rotation of the master key never requires re-encrypting rows; rotation of tenant keys is a background job.
- Connectors receive a `CredentialAccessor` (`get(): Promise<Creds>`, `update(c): Promise<void>` for refresh-token rotation) — decrypted values live only in worker memory, are never logged (logger redaction on known field names + entropy heuristic), never serialized into job payloads.
- OAuth refresh is engine-owned where possible: `AuthDescriptor` declares `{ type: 'oauth2', refreshable: true, refreshSkewSeconds }` and the engine refreshes proactively; connectors just consume a valid token.

### 6.3 Health monitoring

Per channel account the engine computes a health state from: `testConnection` probes (every 15 min), rolling error rates per class, queue lag, webhook silence detectors (expected-traffic heuristic: "this store usually gets ≥1 order webhook per hour"), reconciliation drift, and token expiry horizon. States: `healthy → degraded → failing → paused`. `config` errors jump straight to `degraded` with an actionable operator message ("Shopify token revoked — reconnect required"). Dashboard requirements in `03-sync-policies.md` §8.

### 6.4 Versioning

- Connector packages are semver'd; the SDK is semver'd; each connector declares `sdkVersion` compat and the host refuses to load out-of-range packages.
- **Two versions may run side by side** per connector id (blue/green): new accounts and opted-in tenants get vNext; a registry flag flips the default; rollback is a flag flip. Job payloads carry the connector version that enqueued them so in-flight jobs complete on the version they were built for.
- Remote API version pinning (Shopify's quarterly API versions, SP-API, etc.) is the connector's concern; the registry stores the pinned remote version so the ops dashboard can show "connector pinned to 2025-07, sunset 2026-07".

---

## 7. What a minimal connector looks like

```ts
// packages/connector-example/src/index.ts
import { ConnectorDefinition } from '@omniretail/connector-sdk';

const def: ConnectorDefinition = {
  id: 'example',
  displayName: 'Example Marketplace',
  version: '1.2.0',
  sdkVersion: '^3.0.0',
  capabilities: ['inventorySync', 'orderImport'],
  auth: { type: 'apiKey', fields: ['apiKey', 'apiSecret'] },
  rateLimits: { buckets: [{ group: 'default', capacity: 40, refillPerSecond: 2, costing: 'perCall' }],
                maxBatch: 100, maxConcurrent: 4 },
  settingsSchema: { type: 'object', properties: { warehouseCode: { type: 'string' } } },
  create: (ctx) => ({
    async testConnection() { /* GET /me via ctx.http */ return { ok: true }; },
    inventory: {
      async setLevels(updates) { /* POST /inventory/batch */ return { succeeded: updates, failed: [] }; },
    },
    orders: {
      async pull(cursor) { /* GET /orders?since=cursor */ return { items: [], nextCursor: cursor, hasMore: false }; },
    },
    async snapshot(kind, page) { /* paged dump */ return { items: [], nextCursor: null, hasMore: false }; },
  }),
};
export default def;
```

Everything else — retries, rate limiting, idempotency bookkeeping, scheduling, credentials, health — is the engine's job. That asymmetry is the point: connector authors write channel-API glue, not distributed-systems code.
