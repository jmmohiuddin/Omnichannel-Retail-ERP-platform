/**
 * Connector SDK contract — a simplified realization of the design in
 * docs/integrations/01-connector-architecture.md §3. Pure types: no I/O.
 *
 * A connector is channel-API glue. Retries, rate limiting, idempotency
 * bookkeeping, scheduling, credentials, and health monitoring are the sync
 * engine's job; connectors only consume the injected `ConnectorContext`.
 */

/**
 * Capabilities a connector declares. The sync engine only schedules work for
 * capabilities set to `true`; everything else is skipped for that channel.
 */
export interface ConnectorCapabilities {
  inventorySync: boolean;
  orderImport: boolean;
  priceSync: boolean;
  listingPublish: boolean;
  statusSync: boolean;
}

/** One line of a normalized channel order. Money is BIGINT-style minor units. */
export interface ChannelOrderLine {
  /** ERP SKU when the connector could resolve it; otherwise the channel SKU. */
  sku: string;
  /** Channel-side line identifier where the API provides one. */
  channelLineId?: string;
  quantity: number;
  /** Unit price in minor units (fils for AED). Never floats for money. */
  unitPriceMinor: number;
  currency: string;
}

export type ChannelOrderStatus =
  | "pending"
  | "paid"
  | "shipped"
  | "cancelled"
  | "refunded"
  | "unknown";

/**
 * Normalized order pulled from a channel. `externalId` is the dedupe key
 * together with the channel account (see 03-sync-policies.md §3).
 */
export interface ChannelOrder {
  /** Remote order id — stable dedupe key on the channel. */
  externalId: string;
  /** Human-facing order number where distinct from the id. */
  orderNumber?: string;
  /** ISO 8601, normalized to UTC. */
  placedAt: string;
  status: ChannelOrderStatus;
  currency: string;
  lines: ChannelOrderLine[];
  buyer?: { name?: string; email?: string; phone?: string };
  totals: {
    subtotalMinor: number;
    shippingMinor: number;
    taxMinor: number;
    discountMinor: number;
    grandMinor: number;
  };
  /** Original channel payload, preserved for audit/replay. */
  raw: unknown;
}

/**
 * Absolute available-to-sell quantity for one SKU, stamped with a
 * monotonically increasing per-SKU version (never deltas — see
 * 01-connector-architecture.md §4.4).
 */
export interface InventoryPush {
  sku: string;
  availableQty: number;
  version: number;
}

/** Absolute price push for one SKU, minor units + currency. */
export interface PricePush {
  sku: string;
  priceMinor: number;
  currency: string;
  version: number;
}

/**
 * Error classification driving engine behavior (retry vs DLQ vs operator
 * alert). Classification is the connector's job.
 */
export type PushErrorClass = "transient" | "permanent" | "config" | "rate_limited";

/** Per-item result of a push. `sku` echoes the input item. */
export interface PushOutcome {
  sku: string;
  ok: boolean;
  errorClass?: PushErrorClass;
  message?: string;
  /** Honor channel Retry-After when the error is rate_limited. */
  retryAfterMs?: number;
}

/**
 * Engine-side summary of one order-import cycle (what the importer did with
 * the orders a connector returned from `pullOrders`).
 */
export interface OrderImportResult {
  received: number;
  imported: number;
  duplicates: number;
  failed: number;
}

/** Health signal from `verifyCredentials` / periodic probes. */
export interface ConnectorHealth {
  ok: boolean;
  status: "healthy" | "degraded" | "failing";
  message?: string;
  /** ISO 8601 timestamp of the check, when the caller stamps one. */
  checkedAt?: string;
}

/** Minimal typed HTTP response. `body` is already decoded (JSON). */
export interface HttpResponse {
  status: number;
  body: unknown;
}

/**
 * Minimal fetch-like transport injected by the host. In production it is
 * rate-limit-governed; in tests it is a programmable fake (stores/memory.ts).
 * Connectors must never talk to a remote API except through this.
 */
export interface ConnectorHttp {
  get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
  post(
    url: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpResponse>;
  put(
    url: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpResponse>;
}

/** Durable per-account string KV for cursors, sync tokens, feed ids, etc. */
export interface ConnectorStateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Everything a connector needs, injected by the host. One context per
 * (tenant, channel account) pair. Connectors never touch Postgres, Redis, or
 * the outbox directly — only `ctx.*`.
 */
export interface ConnectorContext {
  http: ConnectorHttp;
  /** Decrypt-on-read credential accessor; values must never be logged. */
  credentials: () => Promise<Record<string, string>>;
  state: ConnectorStateStore;
  log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void;
}

/**
 * The connector contract. Every method must be safe to call twice with the
 * same input (idempotent) — the engine WILL retry.
 */
export interface Connector {
  /** Stable machine key, e.g. "noon", "amazon-ae". Never reused. */
  key: string;
  capabilities: ConnectorCapabilities;

  /** Validate credentials & scopes. Side-effect free; called periodically. */
  verifyCredentials(ctx: ConnectorContext): Promise<ConnectorHealth>;

  /**
   * Push absolute quantities. The connector decides how to chunk for the
   * remote API and returns one outcome per input item (same order).
   */
  pushInventory(
    ctx: ConnectorContext,
    items: InventoryPush[],
  ): Promise<PushOutcome[]>;

  /**
   * Cursor-based incremental pull. The connector reads/advances its cursor in
   * `ctx.state`; overlap must be tolerated (the importer dedupes).
   */
  pullOrders(ctx: ConnectorContext): Promise<ChannelOrder[]>;

  /** Optional: push absolute prices (required when `capabilities.priceSync`). */
  pushPrices?(
    ctx: ConnectorContext,
    items: PricePush[],
  ): Promise<PushOutcome[]>;

  /** Optional: acknowledge an order where the channel requires it. */
  ackOrder?(ctx: ConnectorContext, externalId: string): Promise<void>;
}
