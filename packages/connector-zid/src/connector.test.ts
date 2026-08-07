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
  ZID_STOCK_BATCH_SIZE,
  zidConnector,
} from "./connector.js";
import { zidEndpoints } from "./endpoints.js";
import type { ZidOrder } from "./mapping.js";

function makeCtx(): { ctx: ConnectorContext; http: FakeHttp; state: MemoryStateStore } {
  const http = new FakeHttp();
  const state = new MemoryStateStore();
  const ctx: ConnectorContext = {
    http,
    state,
    credentials: async () => ({
      accessToken: "test-access",
      managerToken: "test-manager",
      storeId: "store-42",
    }),
    log: () => {},
  };
  return { ctx, http, state };
}

const zidOrder = (id: string, updatedAt: string): ZidOrder => ({
  id,
  code: `C-${id}`,
  order_status: "preparing",
  currency_code: "SAR",
  products: [{ id: 1, sku: "TSHIRT-M-RED", quantity: 1, price: "100.00" }],
  order_total: "100.00",
  created_at: "2026-08-01T14:30:00+04:00",
  updated_at: updatedAt,
});

describe("zidConnector metadata", () => {
  it("declares key and honestly scoped capabilities", () => {
    expect(zidConnector.key).toBe("zid");
    expect(zidConnector.capabilities).toEqual({
      inventorySync: true,
      orderImport: true,
      priceSync: false,
      listingPublish: false,
      statusSync: false,
    });
  });
});

describe("zidConnector.pullOrders", () => {
  it("maps returned orders and advances the watermark cursor in ctx.state", async () => {
    const { ctx, http, state } = makeCtx();
    http.on("GET", zidEndpoints.listOrders(null), {
      status: 200,
      body: {
        orders: [
          zidOrder("1", "2026-08-01T09:00:00Z"),
          zidOrder("2", "2026-08-01T11:00:00Z"),
        ],
      },
    });

    const orders = await zidConnector.pullOrders(ctx);

    expect(orders.map((o) => o.externalId)).toEqual(["1", "2"]);
    expect(orders[0]?.status).toBe("paid");
    expect(orders[0]?.lines[0]?.unitPriceMinor).toBe(10000);
    // Watermark advances to the NEWEST updated_at across the page.
    expect(state.peek(LAST_ORDER_CURSOR_KEY)).toBe("2026-08-01T11:00:00.000Z");
  });

  it("sends the dual-token auth headers on the request", async () => {
    const { ctx, http } = makeCtx();
    http.on("GET", zidEndpoints.listOrders(null), { status: 200, body: { orders: [] } });

    await zidConnector.pullOrders(ctx);

    const headers = http.requests[0]?.headers ?? {};
    expect(headers["Authorization"]).toBe("Bearer test-access");
    expect(headers["X-Manager-Token"]).toBe("test-manager");
    expect(headers["Store-Id"]).toBe("store-42");
  });

  it("sends the stored watermark and keeps it when nothing newer arrives", async () => {
    const { ctx, http, state } = makeCtx();
    await state.set(LAST_ORDER_CURSOR_KEY, "2026-08-01T11:00:00.000Z");
    http.on("GET", /updated-after=/, { status: 200, body: { orders: [] } });

    const orders = await zidConnector.pullOrders(ctx);

    expect(orders).toEqual([]);
    expect(http.requests[0]?.url).toBe(
      zidEndpoints.listOrders("2026-08-01T11:00:00.000Z"),
    );
    expect(state.peek(LAST_ORDER_CURSOR_KEY)).toBe("2026-08-01T11:00:00.000Z");
  });

  it("does not regress the watermark when a page carries only older orders", async () => {
    const { ctx, http, state } = makeCtx();
    await state.set(LAST_ORDER_CURSOR_KEY, "2026-08-01T12:00:00.000Z");
    http.on("GET", /updated-after=/, {
      status: 200,
      body: { orders: [zidOrder("9", "2026-08-01T08:00:00Z")] },
    });

    await zidConnector.pullOrders(ctx);

    expect(state.peek(LAST_ORDER_CURSOR_KEY)).toBe("2026-08-01T12:00:00.000Z");
  });

  it("throws an HttpError and leaves the cursor untouched on a failed pull", async () => {
    const { ctx, http, state } = makeCtx();
    await state.set(LAST_ORDER_CURSOR_KEY, "2026-08-01T05:00:00.000Z");
    http.on("GET", /\/managers\/store\/orders/, { status: 503, body: {} });

    await expect(zidConnector.pullOrders(ctx)).rejects.toThrow(HttpError);
    expect(state.peek(LAST_ORDER_CURSOR_KEY)).toBe("2026-08-01T05:00:00.000Z");
  });
});

describe("zidConnector.pushInventory", () => {
  const items = (n: number): InventoryPush[] =>
    Array.from({ length: n }, (_, i) => ({
      sku: `SKU-${i}`,
      availableQty: i,
      version: 1,
    }));

  it("batches at most 50 SKUs per request", async () => {
    const { ctx, http } = makeCtx();
    http.on("POST", zidEndpoints.stockUpdate(), { status: 200, body: { results: [] } });

    const outcomes = await zidConnector.pushInventory(ctx, items(120));

    const posts = http.requestsTo("POST", zidEndpoints.stockUpdate());
    expect(posts).toHaveLength(3);
    const sizes = posts.map(
      (r) => (r.body as { products: unknown[] }).products.length,
    );
    expect(sizes).toEqual([50, 50, 20]);
    expect(sizes.every((s) => s <= ZID_STOCK_BATCH_SIZE)).toBe(true);
    expect(outcomes).toHaveLength(120);
    expect(outcomes.every((o) => o.ok)).toBe(true);
  });

  it("reports per-item outcomes on partial failure, in input order", async () => {
    const { ctx, http } = makeCtx();
    http.on("POST", zidEndpoints.stockUpdate(), {
      status: 200,
      body: {
        results: [
          { sku: "SKU-0", status: "ok" },
          { sku: "SKU-1", status: "error", message: "unknown sku" },
        ],
      },
    });

    const outcomes = await zidConnector.pushInventory(ctx, items(3));

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

  it("marks a whole 429 batch as rate_limited but continues later batches", async () => {
    const { ctx, http } = makeCtx();
    let call = 0;
    http.on("POST", zidEndpoints.stockUpdate(), () => {
      call++;
      return call === 1
        ? { status: 429, body: {} }
        : { status: 200, body: { results: [] } };
    });

    const outcomes = await zidConnector.pushInventory(ctx, items(60));

    const first = outcomes.slice(0, 50);
    const second = outcomes.slice(50);
    expect(first.every((o) => !o.ok && o.errorClass === "rate_limited")).toBe(true);
    expect(second.every((o) => o.ok)).toBe(true);
  });

  it("classifies 5xx batch failures as transient", async () => {
    const { ctx, http } = makeCtx();
    http.on("POST", zidEndpoints.stockUpdate(), { status: 502, body: {} });

    const outcomes = await zidConnector.pushInventory(ctx, items(2));
    expect(outcomes.every((o) => o.errorClass === "transient")).toBe(true);
  });
});

describe("zidConnector.verifyCredentials", () => {
  it("reports healthy on a 200 auth check and sends the dual-token headers", async () => {
    const { ctx, http } = makeCtx();
    http.on("GET", zidEndpoints.authCheck(), { status: 200, body: { manager: "x" } });

    const health = await zidConnector.verifyCredentials(ctx);

    expect(health).toEqual({ ok: true, status: "healthy" });
    expect(http.requests[0]?.headers?.["Authorization"]).toBe("Bearer test-access");
    expect(http.requests[0]?.headers?.["X-Manager-Token"]).toBe("test-manager");
  });

  it("surfaces auth rejection cleanly instead of throwing", async () => {
    const { ctx, http } = makeCtx();
    http.on("GET", zidEndpoints.authCheck(), { status: 401, body: {} });

    const health = await zidConnector.verifyCredentials(ctx);

    expect(health.ok).toBe(false);
    expect(health.status).toBe("failing");
    expect(health.message).toMatch(/reconnect required/);
  });
});

describe("zidConnector.ackOrder", () => {
  it("posts to the ack endpoint and throws HttpError on failure", async () => {
    const { ctx, http } = makeCtx();
    http.on("POST", zidEndpoints.orderAck("Z-1"), { status: 204, body: null });

    await zidConnector.ackOrder!(ctx, "Z-1");
    expect(http.requests[0]?.url).toBe(zidEndpoints.orderAck("Z-1"));

    http.on("POST", zidEndpoints.orderAck("Z-2"), { status: 500, body: {} });
    await expect(zidConnector.ackOrder!(ctx, "Z-2")).rejects.toThrow(HttpError);
  });
});
