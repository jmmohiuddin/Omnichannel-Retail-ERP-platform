/**
 * Noon Marketplace connector — SKELETON.
 *
 * The mapping logic (mapping.ts) is real and tested; the HTTP layer targets
 * ASSUMED endpoints/shapes centralized in endpoints.ts. Every remote detail
 * is tagged UNVERIFIED there — slot in the real Noon Seller API values before
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
import { noonAuthHeaders, noonEndpoints } from "./endpoints.js";
import {
  mapNoonOrder,
  toNoonInventoryPayload,
  type NoonOrder,
} from "./mapping.js";

/** ctx.state key holding the opaque order-pull cursor. */
export const LAST_ORDER_CURSOR_KEY = "lastOrderCursor";

/** Max SKUs per inventory batch request. */
// UNVERIFIED: confirm the real batch limit against Noon Seller API docs
export const NOON_INVENTORY_BATCH_SIZE = 50;

/** Assumed shape of the order-listing response. */
// UNVERIFIED: confirm against Noon Seller API docs
interface NoonOrdersResponse {
  orders: NoonOrder[];
  next_cursor?: string | null;
}

/** Assumed per-item result in the batch stock-update response. */
// UNVERIFIED: confirm against Noon Seller API docs
interface NoonInventoryResult {
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

export const noonConnector: Connector = {
  key: "noon",
  capabilities: {
    inventorySync: true,
    orderImport: true,
    // Skeleton scope: price sync, listing publish, and status sync are not
    // implemented yet, so they are honestly declared off — the engine will
    // not schedule that work for Noon accounts.
    priceSync: false,
    listingPublish: false,
    statusSync: false,
  },

  async verifyCredentials(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const credentials = await ctx.credentials();
    const res = await ctx.http.get(
      noonEndpoints.authCheck(),
      noonAuthHeaders(credentials),
    );
    if (res.status === 200) {
      return { ok: true, status: "healthy" };
    }
    const message =
      res.status === 401 || res.status === 403
        ? `Noon rejected the credentials (HTTP ${res.status}) — reconnect required`
        : `Noon auth check failed with HTTP ${res.status}`;
    ctx.log("warn", "noon.verifyCredentials failed", { status: res.status });
    return { ok: false, status: "failing", message };
  },

  async pushInventory(
    ctx: ConnectorContext,
    items: InventoryPush[],
  ): Promise<PushOutcome[]> {
    const credentials = await ctx.credentials();
    const headers = noonAuthHeaders(credentials);
    const outcomes = new Map<string, PushOutcome>();

    for (const batch of chunk(items, NOON_INVENTORY_BATCH_SIZE)) {
      const res = await ctx.http.post(
        noonEndpoints.inventoryBatch(),
        toNoonInventoryPayload(batch),
        headers,
      );

      if (res.status < 200 || res.status >= 300) {
        // Whole batch failed — classify once, report per item.
        const errorClass = classifyStatus(res.status);
        ctx.log("warn", "noon.pushInventory batch failed", {
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

      // UNVERIFIED: confirm the response shape against Noon Seller API docs
      const results =
        (res.body as { results?: NoonInventoryResult[] }).results ?? [];
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
            message: result.message ?? "rejected by Noon",
          });
        }
      }
    }

    // Return outcomes in input order.
    return items.map(
      (i) => outcomes.get(i.sku) ?? { sku: i.sku, ok: true },
    );
  },

  async pullOrders(ctx: ConnectorContext): Promise<ChannelOrder[]> {
    const credentials = await ctx.credentials();
    const cursor = await ctx.state.get(LAST_ORDER_CURSOR_KEY);
    const res = await ctx.http.get(
      noonEndpoints.orders(cursor),
      noonAuthHeaders(credentials),
    );
    if (res.status !== 200) {
      // Throw with the status so the engine's retry taxonomy classifies it;
      // the cursor is NOT advanced, so the next poll re-covers this window.
      throw new HttpError(res.status, `noon order pull failed: HTTP ${res.status}`);
    }

    // UNVERIFIED: confirm the response shape against Noon Seller API docs
    const body = res.body as NoonOrdersResponse;
    const orders = (body.orders ?? []).map(mapNoonOrder);

    const nextCursor = body.next_cursor;
    if (nextCursor !== undefined && nextCursor !== null && nextCursor !== "") {
      await ctx.state.set(LAST_ORDER_CURSOR_KEY, nextCursor);
    }
    ctx.log("info", "noon.pullOrders", {
      count: orders.length,
      cursorAdvanced: nextCursor != null,
    });
    return orders;
  },

  async ackOrder(ctx: ConnectorContext, externalId: string): Promise<void> {
    const credentials = await ctx.credentials();
    const res = await ctx.http.post(
      noonEndpoints.orderAck(externalId),
      {},
      noonAuthHeaders(credentials),
    );
    if (res.status < 200 || res.status >= 300) {
      throw new HttpError(res.status, `noon ack failed for ${externalId}`);
    }
  },
};
