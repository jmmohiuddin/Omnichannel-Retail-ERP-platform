import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, type SalePayload, type SaleResult } from "./api.js";
import { SaleQueue, type QueueStorage } from "./saleQueue.js";

function memoryStorage(): QueueStorage & { dump(): Map<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => map,
  };
}

function salePayload(id: string): SalePayload {
  return {
    id,
    deviceId: "dev-1",
    locationId: "loc-1",
    lines: [{ variantId: "v-1", quantity: 1, unitPriceMinor: 10500 }],
    payments: [{ method: "cash", amountMinor: 10500 }],
  };
}

const saleResult: SaleResult = {
  orderId: "o-1",
  orderNo: "POS-0001",
  totals: { subtotalMinor: 10000, taxMinor: 500, totalMinor: 10500, currency: "AED" },
};

function okResponse(): Response {
  return new Response(JSON.stringify(saleResult), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: "rejected" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("SaleQueue", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeQueue(overrides: Partial<ConstructorParameters<typeof SaleQueue>[0]> = {}) {
    const storage = memoryStorage();
    const api = createApiClient(() => "test-token");
    const queue = new SaleQueue({
      storage,
      post: (payload) => api.submitSale(payload),
      ...overrides,
    });
    return { queue, storage };
  }

  it("submit posts straight through when online and queues nothing", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const { queue } = makeQueue();

    const outcome = await queue.submit(salePayload("s-1"));

    expect(outcome).toEqual({ status: "submitted", result: saleResult });
    expect(queue.pendingCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/pos/sales");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
  });

  it("submit queues the payload on a network error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const { queue, storage } = makeQueue();

    const outcome = await queue.submit(salePayload("s-1"));

    expect(outcome).toEqual({ status: "queued", pendingCount: 1 });
    expect(queue.pending()[0]!.payload.id).toBe("s-1");
    // Durably persisted, not just in memory.
    expect([...storage.dump().values()].join("")).toContain("s-1");
  });

  it("submit re-throws HTTP rejections instead of queueing them", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(422));
    const { queue } = makeQueue();

    await expect(queue.submit(salePayload("s-1"))).rejects.toBeInstanceOf(ApiError);
    expect(queue.pendingCount()).toBe(0);
  });

  it("enqueue is idempotent on the client-generated sale id", () => {
    const { queue } = makeQueue();
    queue.enqueue(salePayload("s-1"));
    queue.enqueue(salePayload("s-1"));
    expect(queue.pendingCount()).toBe(1);
  });

  it("flush replays queued sales FIFO and empties the queue on success", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    const { queue, storage } = makeQueue();
    await queue.submit(salePayload("s-1"));
    await queue.submit(salePayload("s-2"));
    expect(queue.pendingCount()).toBe(2);

    fetchMock.mockImplementation(() => Promise.resolve(okResponse())); // fresh Response per call
    const report = await queue.flush();

    expect(report).toEqual({ submitted: 2, rejected: 0, remaining: 0 });
    const replayedIds = fetchMock.mock.calls
      .slice(2)
      .map(([, init]) => (JSON.parse(String(init?.body)) as SalePayload).id);
    expect(replayedIds).toEqual(["s-1", "s-2"]);
    expect(storage.dump().size).toBe(0);
  });

  it("flush stops at the first network error and keeps the rest queued", async () => {
    const { queue } = makeQueue();
    queue.enqueue(salePayload("s-1"));
    queue.enqueue(salePayload("s-2"));

    fetchMock.mockRejectedValue(new TypeError("still offline"));
    const report = await queue.flush();

    expect(report).toEqual({ submitted: 0, rejected: 0, remaining: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no point trying s-2 offline
    expect(queue.pending()[0]!.attempts).toBe(1);
  });

  it("flush drops 4xx-rejected sales and reports them via onRejected", async () => {
    const onRejected = vi.fn();
    const { queue } = makeQueue({ onRejected });
    queue.enqueue(salePayload("s-bad"));
    queue.enqueue(salePayload("s-good"));

    fetchMock.mockResolvedValueOnce(errorResponse(409));
    fetchMock.mockResolvedValueOnce(okResponse());
    const report = await queue.flush();

    expect(report).toEqual({ submitted: 1, rejected: 1, remaining: 0 });
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onRejected.mock.calls[0]![0].payload.id).toBe("s-bad");
    expect(onRejected.mock.calls[0]![1]).toBeInstanceOf(ApiError);
  });

  it("flush keeps sales queued on 5xx for a later retry", async () => {
    const { queue } = makeQueue();
    queue.enqueue(salePayload("s-1"));

    fetchMock.mockResolvedValueOnce(errorResponse(503));
    const report = await queue.flush();

    expect(report).toEqual({ submitted: 0, rejected: 0, remaining: 1 });
    expect(queue.pending()[0]!.attempts).toBe(1);
  });

  it("notifies subscribers as the pending count changes", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    const { queue } = makeQueue();
    const counts: number[] = [];
    queue.subscribe((n) => counts.push(n));

    await queue.submit(salePayload("s-1"));
    fetchMock.mockResolvedValueOnce(okResponse());
    await queue.flush();

    expect(counts).toEqual([0, 1, 0]);
  });
});
