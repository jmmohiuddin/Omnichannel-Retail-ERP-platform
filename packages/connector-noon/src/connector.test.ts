import { describe, expect, it } from "vitest";
import {
  FakeHttp,
  MemoryStateStore,
  HttpError,
  type ConnectorContext,
  type InventoryPush,
} from "@omniretail/connector-sdk";
import {
  LAST_ORDER_CURSOR_KEY,
  NOON_INVENTORY_BATCH_SIZE,
  noonConnector,
} from "./connector.js";
import { noonEndpoints } from "./endpoints.js";
import type { NoonOrder } from "./mapping.js";

function makeCtx(): { ctx: ConnectorContext; http: FakeHttp; state: MemoryStateStore } {
  const http = new FakeHttp();
  const state = new MemoryStateStore();
  const ctx: ConnectorContext = {
    http,
    state,
    credentials: async () => ({ apiKey: "test-key" }),
    log: () => {},
  };
  return { ctx, http, state };
}

const noonOrder = (nr: string): NoonOrder => ({
  order_nr: nr,
  ordered_at: "2026-08-01T14:30:00+04:00",
  status: "confirmed",
  currency: "AED",
  items: [{ sku: "TSHIRT-M-RED", qty: 1, unit_price: 100 }],
  order_total: 100,
});

describe("noonConnector.pullOrders", () => {
  it("maps returned orders and advances the cursor in ctx.state", async () => {
    const { ctx, http, state } = makeCtx();
    http.on("GET", noonEndpoints.orders(null), {
      status: 200,
      body: { orders: [noonOrder("NAE-1"), noonOrder("NAE-2")], next_cursor: "c-2" },
    });

    const orders = await noonConnector.pullOrders(ctx);

    expect(orders.map((o) => o.externalId)).toEqual(["NAE-1", "NAE-2"]);
    expect(orders[0]?.status).toBe("paid");
    expect(orders[0]?.lines[0]?.unitPriceMinor).toBe(10000);
    expect(state.peek(LAST_ORDER_CURSOR_KEY)).toBe("c-2");
  });

  it("sends the stored cursor on subsequent pulls and keeps it when none is returned", async () => {
    const { ctx, http, state } = makeCtx();
    await state.set(LAST_ORDER_CURSOR_KEY, "c-41");
    http.on("GET", /cursor=c-41/, {
      status: 200,
      body: { orders: [], next_cursor: null },
    });

    const orders = await noonConnector.pullOrders(ctx);

    expect(orders).toEqual([]);
    expect(http.requests[0]?.url).toBe(noonEndpoints.orders("c-41"));
    expect(state.peek(LAST_ORDER_CURSOR_KEY)).toBe("c-41"); // not clobbered
  });

  it("throws an HttpError and leaves the cursor untouched on a failed pull", async () => {
    const { ctx, http, state } = makeCtx();
    await state.set(LAST_ORDER_CURSOR_KEY, "c-9");
    http.on("GET", /\/v1\/orders/, { status: 503, body: {} });

    await expect(noonConnector.pullOrders(ctx)).rejects.toThrow(HttpError);
    expect(state.peek(LAST_ORDER_CURSOR_KEY)).toBe("c-9");
  });
});

describe("noonConnector.pushInventory", () => {
  const items = (n: number): InventoryPush[] =>
    Array.from({ length: n }, (_, i) => ({
      sku: `SKU-${i}`,
      availableQty: i,
      version: 1,
    }));

  it("batches at most 50 SKUs per request", async () => {
    const { ctx, http } = makeCtx();
    http.on("POST", noonEndpoints.inventoryBatch(), { status: 200, body: { results: [] } });

    const outcomes = await noonConnector.pushInventory(ctx, items(120));

    const posts = http.requestsTo("POST", noonEndpoints.inventoryBatch());
    expect(posts).toHaveLength(3);
    const sizes = posts.map(
      (r) => (r.body as { skus: unknown[] }).skus.length,
    );
    expect(sizes).toEqual([50, 50, 20]);
    expect(sizes.every((s) => s <= NOON_INVENTORY_BATCH_SIZE)).toBe(true);
    expect(outcomes).toHaveLength(120);
    expect(outcomes.every((o) => o.ok)).toBe(true);
  });

  it("reports per-item outcomes on partial failure, in input order", async () => {
    const { ctx, http } = makeCtx();
    http.on("POST", noonEndpoints.inventoryBatch(), {
      status: 200,
      body: {
        results: [
          { sku: "SKU-0", status: "ok" },
          { sku: "SKU-1", status: "error", message: "unknown sku" },
        ],
      },
    });

    const outcomes = await noonConnector.pushInventory(ctx, items(3));

    expect(outcomes.map((o) => o.sku)).toEqual(["SKU-0", "SKU-1", "SKU-2"]);
    expect(outcomes[0]).toEqual({ sku: "SKU-0", ok: true });
    expect(outcomes[1]).toMatchObject({
      sku: "SKU-1",
      ok: false,
      errorClass: "permanent",
      message: "unknown sku",
    });
    expect(outcomes[2]?.ok).toBe(true); // absent from response => assumed accepted
  });

  it("marks a whole failed batch with the classified error but continues later batches", async () => {
    const { ctx, http } = makeCtx();
    let call = 0;
    http.on("POST", noonEndpoints.inventoryBatch(), () => {
      call++;
      return call === 1
        ? { status: 429, body: {} }
        : { status: 200, body: { results: [] } };
    });

    const outcomes = await noonConnector.pushInventory(ctx, items(60));

    const first = outcomes.slice(0, 50);
    const second = outcomes.slice(50);
    expect(first.every((o) => !o.ok && o.errorClass === "rate_limited")).toBe(true);
    expect(second.every((o) => o.ok)).toBe(true);
  });

  it("classifies 5xx batch failures as transient", async () => {
    const { ctx, http } = makeCtx();
    http.on("POST", noonEndpoints.inventoryBatch(), { status: 502, body: {} });

    const outcomes = await noonConnector.pushInventory(ctx, items(2));
    expect(outcomes.every((o) => o.errorClass === "transient")).toBe(true);
  });
});

describe("noonConnector.verifyCredentials", () => {
  it("reports healthy on a 200 auth check and sends the assumed auth header", async () => {
    const { ctx, http } = makeCtx();
    http.on("GET", noonEndpoints.authCheck(), { status: 200, body: { seller: "x" } });

    const health = await noonConnector.verifyCredentials(ctx);

    expect(health).toEqual({ ok: true, status: "healthy" });
    expect(http.requests[0]?.headers?.["Authorization"]).toBe("Bearer test-key");
  });

  it("surfaces auth rejection cleanly instead of throwing", async () => {
    const { ctx, http } = makeCtx();
    http.on("GET", noonEndpoints.authCheck(), { status: 401, body: {} });

    const health = await noonConnector.verifyCredentials(ctx);

    expect(health.ok).toBe(false);
    expect(health.status).toBe("failing");
    expect(health.message).toMatch(/reconnect required/);
  });
});

describe("noonConnector.ackOrder", () => {
  it("posts to the ack endpoint and throws HttpError on failure", async () => {
    const { ctx, http } = makeCtx();
    http.on("POST", noonEndpoints.orderAck("NAE-1"), { status: 204, body: null });

    await noonConnector.ackOrder!(ctx, "NAE-1");
    expect(http.requests[0]?.url).toBe(noonEndpoints.orderAck("NAE-1"));

    http.on("POST", noonEndpoints.orderAck("NAE-2"), { status: 500, body: {} });
    await expect(noonConnector.ackOrder!(ctx, "NAE-2")).rejects.toThrow(HttpError);
  });
});
