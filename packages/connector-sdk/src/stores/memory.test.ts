import { describe, expect, it } from "vitest";
import { FakeHttp, MemoryStateStore } from "./memory.js";

describe("MemoryStateStore", () => {
  it("returns null for missing keys and round-trips values", async () => {
    const store = new MemoryStateStore();
    expect(await store.get("cursor")).toBeNull();
    await store.set("cursor", "2026-08-01T00:00:00Z");
    expect(await store.get("cursor")).toBe("2026-08-01T00:00:00Z");
    await store.set("cursor", "2026-08-02T00:00:00Z"); // overwrite
    expect(store.peek("cursor")).toBe("2026-08-02T00:00:00Z");
  });
});

describe("FakeHttp", () => {
  it("serves static routes by prefix and records every request", async () => {
    const http = new FakeHttp();
    http.on("GET", "https://api.test/orders", { status: 200, body: { orders: [] } });
    const res = await http.get("https://api.test/orders?cursor=abc", {
      Authorization: "Bearer x",
    });
    expect(res).toEqual({ status: 200, body: { orders: [] } });
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]).toMatchObject({
      method: "GET",
      url: "https://api.test/orders?cursor=abc",
      headers: { Authorization: "Bearer x" },
    });
  });

  it("supports function handlers that see the request body, and last-registered wins", async () => {
    const http = new FakeHttp();
    http.on("POST", "https://api.test/inventory", { status: 500, body: {} });
    http.on("POST", "https://api.test/inventory", (req) => ({
      status: 200,
      body: { echoed: req.body },
    }));
    const res = await http.post("https://api.test/inventory", { sku: "A" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ echoed: { sku: "A" } });
    expect(http.requestsTo("POST", "https://api.test/inventory")).toHaveLength(1);
  });

  it("returns 404 for unmatched requests and matches RegExp routes", async () => {
    const http = new FakeHttp();
    http.on("PUT", /\/orders\/[0-9]+\/ack$/, { status: 204, body: null });
    expect((await http.put("https://api.test/orders/123/ack", {})).status).toBe(204);
    expect((await http.get("https://api.test/unknown")).status).toBe(404);
  });
});
