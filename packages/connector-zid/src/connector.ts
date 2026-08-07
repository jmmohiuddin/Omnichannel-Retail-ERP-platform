/**
 * Zid Merchant API connector — SKELETON.
 *
 * The mapping logic (mapping.ts) is real and tested; the HTTP layer targets
 * ASSUMED endpoints/shapes centralized in endpoints.ts. Every remote detail is
 * tagged UNVERIFIED there — slot in the real Zid Merchant API values before
 * production use.
 */
import {
  HttpError,
  type ChannelOrder,
  type Connector,
  type ConnectorContext,
  type ConnectorHealth,
  type InventoryPush,
  type PushErrorClass,
  type PushOutcome,
} from "@omniretail/connector-sdk";
import { zidAuthHeaders, zidEndpoints } from "./endpoints.js";
import {
  inventoryPushToZid,
  zidOrderToChannelOrder,
  type ZidOrder,
} from "./mapping.js";

/** ctx.state key holding the incremental order-pull watermark (updated-after). */
export const LAST_ORDER_CURSOR_KEY = "lastOrderCursor";

/** Max SKUs per stock-update batch request. */
// UNVERIFIED: confirm the real batch limit against Zid Merchant API docs
export const ZID_STOCK_BATCH_SIZE = 50;

/** Assumed shape of the order-listing response. */
// UNVERIFIED: confirm against Zid Merchant API docs (envelope key, pagination)
interface ZidOrdersResponse {
  orders?: ZidOrder[];
  data?: ZidOrder[];
}

/** Assumed per-item result in the batch stock-update response. */
// UNVERIFIED: confirm against Zid Merchant API docs
interface ZidStockResult {
  sku: string;
  status: "ok" | "error";
  message?: string;
}

function classifyStatus(status: number): PushErrorClass {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "config";
  if (status >= 500) return "transient";
  return "permanent";
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Newest `updated_at`/`created_at` across a page of raw orders, as an ISO-8601
 * UTC string — the watermark advanced into ctx.state. Returns null when no
 * order carries a usable timestamp.
 */
function latestWatermark(orders: ZidOrder[]): string | null {
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const o of orders) {
    const stamp = o.updated_at ?? o.created_at;
    if (stamp === undefined) continue;
    const ms = new Date(stamp).getTime();
    if (Number.isFinite(ms) && ms > bestMs) bestMs = ms;
  }
  return bestMs === Number.NEGATIVE_INFINITY ? null : new Date(bestMs).toISOString();
}

export const zidConnector: Connector = {
  key: "zid",
  capabilities: {
    inventorySync: true,
    orderImport: true,
    // Skeleton scope: price sync, listing publish, and status sync are not
    // implemented yet, so they are honestly declared off — the engine will not
    // schedule that work for Zid accounts.
    priceSync: false,
    listingPublish: false,
    statusSync: false,
  },

  async verifyCredentials(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const credentials = await ctx.credentials();
    const res = await ctx.http.get(
      zidEndpoints.authCheck(),
      zidAuthHeaders(credentials),
    );
    if (res.status === 200) {
      return { ok: true, status: "healthy" };
    }
    const message =
      res.status === 401 || res.status === 403
        ? `Zid rejected the credentials (HTTP ${res.status}) — reconnect required`
        : `Zid auth check failed with HTTP ${res.status}`;
    ctx.log("warn", "zid.verifyCredentials failed", { status: res.status });
    return { ok: false, status: "failing", message };
  },

  async pushInventory(
    ctx: ConnectorContext,
    items: InventoryPush[],
  ): Promise<PushOutcome[]> {
    const credentials = await ctx.credentials();
    const headers = zidAuthHeaders(credentials);
    const outcomes = new Map<string, PushOutcome>();

    for (const batch of chunk(items, ZID_STOCK_BATCH_SIZE)) {
      // UNVERIFIED: Zid may require per-product PUTs instead of this batch body.
      const res = await ctx.http.post(
        zidEndpoints.stockUpdate(),
        { products: batch.map(inventoryPushToZid) },
        headers,
      );

      if (res.status < 200 || res.status >= 300) {
        // Whole batch failed — classify once, report per item.
        const errorClass = classifyStatus(res.status);
        ctx.log("warn", "zid.pushInventory batch failed", {
          status: res.status,
          size: batch.length,
        });
        for (const item of batch) {
          outcomes.set(item.sku, {
            sku: item.sku,
            ok: false,
            errorClass,
            message: `HTTP ${res.status}`,
          });
        }
        continue;
      }

      // UNVERIFIED: confirm the response shape against Zid Merchant API docs
      const results =
        (res.body as { results?: ZidStockResult[] }).results ?? [];
      const bySku = new Map(results.map((r) => [r.sku, r]));
      for (const item of batch) {
        const result = bySku.get(item.sku);
        if (result === undefined || result.status === "ok") {
          // Items missing from the response are assumed accepted.
          outcomes.set(item.sku, { sku: item.sku, ok: true });
        } else {
          outcomes.set(item.sku, {
            sku: item.sku,
            ok: false,
            errorClass: "permanent",
            message: result.message ?? "rejected by Zid",
          });
        }
      }
    }

    // Return outcomes in input order.
    return items.map((i) => outcomes.get(i.sku) ?? { sku: i.sku, ok: true });
  },

  async pullOrders(ctx: ConnectorContext): Promise<ChannelOrder[]> {
    const credentials = await ctx.credentials();
    const cursor = await ctx.state.get(LAST_ORDER_CURSOR_KEY);
    const res = await ctx.http.get(
      zidEndpoints.listOrders(cursor),
      zidAuthHeaders(credentials),
    );
    if (res.status !== 200) {
      // Throw with the status so the engine's retry taxonomy classifies it; the
      // watermark is NOT advanced, so the next poll re-covers this window.
      throw new HttpError(res.status, `zid order pull failed: HTTP ${res.status}`);
    }

    // UNVERIFIED: confirm the response envelope against Zid Merchant API docs
    const body = res.body as ZidOrdersResponse;
    const rawOrders = body.orders ?? body.data ?? [];
    const orders = rawOrders.map(zidOrderToChannelOrder);

    // Advance the incremental watermark to the newest order timestamp seen.
    // Only move it forward; never regress on an empty or older page.
    const watermark = latestWatermark(rawOrders);
    if (watermark !== null && (cursor === null || watermark > cursor)) {
      await ctx.state.set(LAST_ORDER_CURSOR_KEY, watermark);
    }
    ctx.log("info", "zid.pullOrders", {
      count: orders.length,
      cursorAdvanced: watermark !== null && (cursor === null || watermark > cursor),
    });
    return orders;
  },

  async ackOrder(ctx: ConnectorContext, externalId: string): Promise<void> {
    const credentials = await ctx.credentials();
    const res = await ctx.http.post(
      zidEndpoints.orderAck(externalId),
      {},
      zidAuthHeaders(credentials),
    );
    if (res.status < 200 || res.status >= 300) {
      throw new HttpError(res.status, `zid ack failed for ${externalId}`);
    }
  },
};
