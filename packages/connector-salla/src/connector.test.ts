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
  SALLA_INVENTORY_BATCH_SIZE,
  sallaConnector,
} from "./connector.js";
import { sallaEndpoints } from "./endpoints.js";
import type { SallaOrder } from "./mapping.js";

function makeCtx(): {
  ctx: ConnectorContext;
  http: FakeHttp;
  state: MemoryStateStore;
} {
  const http = new FakeHttp();
  const state = new MemoryStateStore();
  const ctx: ConnectorContext = {
    http,
    state,
    credentials: async () => ({ accessToken: "test-token" }),
    log: () => {},
  };
  return { ctx, http, state };
}

const sallaOrder = (id: string): SallaOrder => ({
  id,
  reference_id: `REF-${id}`,
  status: "in_progress",
  currency: "SAR",
  date: "2026-08-01T14:30:00+03:00",
  items: [{ sku: "TSHIRT-M-RED", quantity: 1, price: "100.00" }],
  amounts: { total: "100.00" },
});

describe("sallaConnector.pullOrders", () => {
  it("maps returned orders and advances the cursor in ctx.state", async () => {
    const { ctx, http, state } = makeCtx();
    http.on("GET", sallaEndpoints.orders(null), {
      status: 200,
      body: {
        data: [sallaOrder("1001"), sallaOrder("1002")],
        pagination: { next_cursor: "c-2" },
      },
    });

    const orders = await sallaConnector.pullOrders(ctx);

    expect(orders.map((o) => o.externalId)).toEqual(["1001", "1002"]);
    expect(orders[0]?.status).toBe("paid");
    expect(orders[0]?.lines[0]?.unitPriceMinor).toBe(10000);
    expect(state.peek(LAST_ORDER_CURSOR_KEY)).toBe("c-2");
  });

  it("sends the stored cursor on subsequent pulls and keeps it when none is returned", async () => {
    const { ctx, http, state } = makeCtx();
    await state.set(LAST_ORDER_CURSOR_KEY, "c-41");
    http.on("GET", /cursor=c-41/, {
      status: 200,
      body: { data: [], pagination: { next_cursor: null } },
    });

    const orders = await sallaConnector.pullOrders(ctx);

    expect(orders).toEqual([]);
    expect(http.requests[0]?.url).toBe(sallaEndpoints.orders("c-41"));
    expect(state.peek(LAST_ORDER_CURSOR_KEY)).toBe("c-41"); // not clobbered
  });

  it("stamps the OAuth2 bearer token on the request", async () => {
    const { ctx, http } = makeCtx();
    http.on("GET", sallaEndpoints.orders(null), {
      status: 200,
      body: { data: [] },
    });

    await sallaConnector.pullOrders(ctx);
    expect(http.requests[0]?.headers?.["Authorization"]).toBe(
      "Bearer test-token",
    );
  });

  it("throws an HttpError and leaves the cursor untouched on a failed pull", async () => {
    const { ctx, http, state } = makeCtx();
    await state.set(LAST_ORDER_CURSOR_KEY, "c-9");
    http.on("GET", /\/orders/, { status: 503, body: {} });

    await expect(sallaConnector.pullOrders(ctx)).rejects.toThrow(HttpError);
    expect(state.peek(LAST_ORDER_CURSOR_KEY)).toBe("c-9");
  });
});

describe("sallaConnector.pushInventory", () => {
  const items = (n: number): InventoryPush[] =>
    Array.from({ length: n }, (_, i) => ({
      sku: `SKU-${i}`,
      availableQty: i,
      version: 1,
    }));

  it("batches at most 50 SKUs per request", async () => {
    const { ctx, http } = makeCtx();
    http.on("POST", sallaEndpoints.pushInventory(), {
      status: 200,
      body: { data: [] },
    });

    const outcomes = await sallaConnector.pushInventory(ctx, items(120));

    const posts = http.requestsTo("POST", sallaEndpoints.pushInventory());
    expect(posts).toHaveLength(3);
    const sizes = posts.map(
      (r) => (r.body as { products: unknown[] }).products.length,
    );
    expect(sizes).toEqual([50, 50, 20]);
    expect(sizes.every((s) => s <= SALLA_INVENTORY_BATCH_SIZE)).toBe(true);
    expect(outcomes).toHaveLength(120);
    expect(outcomes.every((o) => o.ok)).toBe(true);
  });

  it("reports per-item outcomes on partial failure, in input order", async () => {
    const { ctx, http } = makeCtx();
    http.on("POST", sallaEndpoints.pushInventory(), {
      status: 200,
      body: {
        data: [
          { sku: "SKU-0", status: "ok" },
          { sku: "SKU-1", status: "error", message: "unknown sku" },
        ],
      },
    });

    const outcomes = await sallaConnector.pushInventory(ctx, items(3));

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
    http.on("POST", sallaEndpoints.pushInventory(), () => {
      call++;
      return call === 1
        ? { status: 429, body: {} }
        : { status: 200, body: { data: [] } };
    });

    const outcomes = await sallaConnector.pushInventory(ctx, items(60));

    const first = outcomes.slice(0, 50);
    const second = outcomes.slice(50);
    expect(first.every((o) => !o.ok && o.errorClass === "rate_limited")).toBe(
      true,
    );
    expect(second.every((o) => o.ok)).toBe(true);
  });

  it("classifies 5xx batch failures as transient", async () => {
    const { ctx, http } = makeCtx();
    http.on("POST", sallaEndpoints.pushInventory(), { status: 502, body: {} });

    const outcomes = await sallaConnector.pushInventory(ctx, items(2));
    expect(outcomes.every((o) => o.errorClass === "transient")).toBe(true);
  });

  it("classifies 401/403 batch failures as config errors", async () => {
    const { ctx, http } = makeCtx();
    http.on("POST", sallaEndpoints.pushInventory(), { status: 403, body: {} });

    const outcomes = await sallaConnector.pushInventory(ctx, items(2));
    expect(outcomes.every((o) => !o.ok && o.errorClass === "config")).toBe(true);
  });
});

describe("sallaConnector.verifyCredentials", () => {
  it("reports healthy on a 200 auth check and sends the bearer token", async () => {
    const { ctx, http } = makeCtx();
    http.on("GET", sallaEndpoints.authCheck(), {
      status: 200,
      body: { data: { id: 1 } },
    });

    const health = await sallaConnector.verifyCredentials(ctx);

    expect(health).toEqual({ ok: true, status: "healthy" });
    expect(http.requests[0]?.headers?.["Authorization"]).toBe(
      "Bearer test-token",
    );
  });

  it("surfaces auth rejection cleanly instead of throwing", async () => {
    const { ctx, http } = makeCtx();
    http.on("GET", sallaEndpoints.authCheck(), { status: 401, body: {} });

    const health = await sallaConnector.verifyCredentials(ctx);

    expect(health.ok).toBe(false);
    expect(health.status).toBe("failing");
    expect(health.message).toMatch(/reconnect required/);
  });
});

describe("sallaConnector.ackOrder", () => {
  it("posts to the order-status endpoint and throws HttpError on failure", async () => {
    const { ctx, http } = makeCtx();
    http.on("POST", sallaEndpoints.orderStatus("1001"), {
      status: 200,
      body: { success: true },
    });

    await sallaConnector.ackOrder!(ctx, "1001");
    expect(http.requests[0]?.url).toBe(sallaEndpoints.orderStatus("1001"));

    http.on("POST", sallaEndpoints.orderStatus("1002"), {
      status: 500,
      body: {},
    });
    await expect(sallaConnector.ackOrder!(ctx, "1002")).rejects.toThrow(
      HttpError,
    );
  });
});
