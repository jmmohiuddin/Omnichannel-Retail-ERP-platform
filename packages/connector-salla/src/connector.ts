/**
 * Salla connector — SKELETON.
 *
 * The mapping logic (mapping.ts) is real and tested; the HTTP layer targets
 * ASSUMED endpoints/shapes centralized in endpoints.ts. Every remote detail is
 * tagged UNVERIFIED there — slot in the real Salla Merchant API values (see
 * https://docs.salla.dev) before production use.
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
import { sallaAuthHeaders, sallaEndpoints } from "./endpoints.js";
import {
  sallaOrderToChannelOrder,
  toSallaInventoryPayload,
  type SallaOrder,
} from "./mapping.js";

/** ctx.state key holding the opaque order-pull cursor. */
export const LAST_ORDER_CURSOR_KEY = "lastOrderCursor";

/** Max SKUs per bulk inventory request. */
// UNVERIFIED: confirm the real batch limit against Salla Merchant API docs
export const SALLA_INVENTORY_BATCH_SIZE = 50;

/** Assumed shape of the order-listing response (Salla wraps data + pagination). */
// UNVERIFIED: confirm against Salla Merchant API docs (https://docs.salla.dev)
interface SallaOrdersResponse {
  data?: SallaOrder[];
  pagination?: { cursor?: string | null; next_cursor?: string | null };
}

/** Assumed per-item result in the bulk stock-update response. */
// UNVERIFIED: confirm against Salla Merchant API docs (https://docs.salla.dev)
interface SallaInventoryResult {
  sku: string;
  status: "ok" | "error";
  message?: string;
}

/** OAuth2 access token extracted from injected credentials. */
function accessToken(credentials: Record<string, string>): string {
  return credentials["accessToken"] ?? credentials["access_token"] ?? "";
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

export const sallaConnector: Connector = {
  key: "salla",
  capabilities: {
    inventorySync: true,
    orderImport: true,
    // Skeleton scope: price sync, listing publish, and status sync are not
    // implemented yet, so they are honestly declared off — the engine will not
    // schedule that work for Salla accounts.
    priceSync: false,
    listingPublish: false,
    statusSync: false,
  },

  async verifyCredentials(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const credentials = await ctx.credentials();
    const res = await ctx.http.get(
      sallaEndpoints.authCheck(),
      sallaAuthHeaders(accessToken(credentials)),
    );
    if (res.status === 200) {
      return { ok: true, status: "healthy" };
    }
    const message =
      res.status === 401 || res.status === 403
        ? `Salla rejected the credentials (HTTP ${res.status}) — reconnect required`
        : `Salla auth check failed with HTTP ${res.status}`;
    ctx.log("warn", "salla.verifyCredentials failed", { status: res.status });
    return { ok: false, status: "failing", message };
  },

  async pushInventory(
    ctx: ConnectorContext,
    items: InventoryPush[],
  ): Promise<PushOutcome[]> {
    const credentials = await ctx.credentials();
    const headers = sallaAuthHeaders(accessToken(credentials));
    const outcomes = new Map<string, PushOutcome>();

    for (const batch of chunk(items, SALLA_INVENTORY_BATCH_SIZE)) {
      const res = await ctx.http.post(
        sallaEndpoints.pushInventory(),
        toSallaInventoryPayload(batch),
        headers,
      );

      if (res.status < 200 || res.status >= 300) {
        // Whole batch failed — classify once, report per item.
        const errorClass = classifyStatus(res.status);
        ctx.log("warn", "salla.pushInventory batch failed", {
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

      // UNVERIFIED: confirm the response shape against Salla Merchant API docs
      const results =
        (res.body as { data?: SallaInventoryResult[] }).data ?? [];
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
            message: result.message ?? "rejected by Salla",
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
      sallaEndpoints.orders(cursor),
      sallaAuthHeaders(accessToken(credentials)),
    );
    if (res.status !== 200) {
      // Throw with the status so the engine's retry taxonomy classifies it; the
      // cursor is NOT advanced, so the next poll re-covers this window.
      throw new HttpError(
        res.status,
        `salla order pull failed: HTTP ${res.status}`,
      );
    }

    // UNVERIFIED: confirm the response shape against Salla Merchant API docs
    const body = res.body as SallaOrdersResponse;
    const orders = (body.data ?? []).map(sallaOrderToChannelOrder);

    const nextCursor =
      body.pagination?.next_cursor ?? body.pagination?.cursor;
    if (nextCursor !== undefined && nextCursor !== null && nextCursor !== "") {
      await ctx.state.set(LAST_ORDER_CURSOR_KEY, nextCursor);
    }
    ctx.log("info", "salla.pullOrders", {
      count: orders.length,
      cursorAdvanced: nextCursor != null && nextCursor !== "",
    });
    return orders;
  },

  async ackOrder(ctx: ConnectorContext, externalId: string): Promise<void> {
    const credentials = await ctx.credentials();
    const res = await ctx.http.post(
      sallaEndpoints.orderStatus(externalId),
      // UNVERIFIED: confirm the acknowledge status slug against Salla docs.
      { status: "in_progress" },
      sallaAuthHeaders(accessToken(credentials)),
    );
    if (res.status < 200 || res.status >= 300) {
      throw new HttpError(res.status, `salla ack failed for ${externalId}`);
    }
  },
};
