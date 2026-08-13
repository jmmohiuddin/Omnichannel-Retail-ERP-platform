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

  it("flush takes a 4xx sale off the retry queue, retains it, and reports it", async () => {
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
    // It leaves the retry queue but NOT the device: retrying identical bytes
    // cannot help, while deleting it would lose a sale already paid for.
    expect(queue.rejected().map((r) => r.payload.id)).toEqual(["s-bad"]);
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
    queue.subscribe((c) => counts.push(c.pending));

    await queue.submit(salePayload("s-1"));
    fetchMock.mockResolvedValueOnce(okResponse());
    await queue.flush();

    expect(counts).toEqual([0, 1, 0]);
  });
});

/**
 * A refused sale must never disappear.
 *
 * The queue used to delete a 4xx sale and report it only through an optional
 * `onRejected` callback — which the app never supplied. By the time an offline
 * sale replays, the cashier has taken the money and the customer has walked out
 * with the goods, so a silent delete is an unrecorded loss. These pin the
 * retention that replaces it.
 */
describe("SaleQueue — rejected sales are retained, never dropped", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeQueue(storage = memoryStorage()) {
    const api = createApiClient(() => "token");
    const queue = new SaleQueue({ storage, post: (p) => api.submitSale(p) });
    return { queue, storage };
  }

  async function queueThenReject(status: number) {
    const { queue, storage } = makeQueue();
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await queue.submit(salePayload("s-rej"));
    fetchMock.mockResolvedValueOnce(errorResponse(status));
    const report = await queue.flush();
    return { queue, storage, report };
  }

  it("moves a 4xx sale to the rejected list instead of deleting it", async () => {
    const { queue, report } = await queueThenReject(422);

    expect(report.rejected).toBe(1);
    expect(queue.pendingCount()).toBe(0);
    // The regression: this used to be 0 and the sale was gone.
    expect(queue.rejectedCount()).toBe(1);
    expect(queue.rejected()[0]!.payload.id).toBe("s-rej");
    expect(queue.rejected()[0]!.status).toBe(422);
  });

  it("keeps the rejected sale in storage, so it survives a reload", async () => {
    const { storage } = await queueThenReject(409);

    // A fresh queue over the same storage still sees it.
    const api = createApiClient(() => "token");
    const reopened = new SaleQueue({ storage, post: (p) => api.submitSale(p) });
    expect(reopened.rejectedCount()).toBe(1);
    expect(reopened.rejected()[0]!.payload.id).toBe("s-rej");
  });

  it("retains it even when no onRejected callback is supplied", async () => {
    // Exactly the app's configuration — the callback was never wired.
    const { queue } = await queueThenReject(400);
    expect(queue.rejectedCount()).toBe(1);
  });

  it("reports rejected count to subscribers", async () => {
    const { queue } = makeQueue();
    const seen: { pending: number; rejected: number }[] = [];
    queue.subscribe((c) => seen.push({ ...c }));

    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await queue.submit(salePayload("s-rej"));
    fetchMock.mockResolvedValueOnce(errorResponse(422));
    await queue.flush();

    expect(seen.at(-1)).toEqual({ pending: 0, rejected: 1 });
  });

  it("clears one only when explicitly resolved", async () => {
    const { queue } = await queueThenReject(422);

    expect(queue.resolveRejected("nope")).toBe(false);
    expect(queue.rejectedCount()).toBe(1);

    expect(queue.resolveRejected("s-rej")).toBe(true);
    expect(queue.rejectedCount()).toBe(0);
  });

  it("does not duplicate a rejected sale if it is seen twice", async () => {
    const { queue, storage } = await queueThenReject(422);
    // Re-queue the same id and have it refused again.
    queue.enqueue(salePayload("s-rej"));
    fetchMock.mockResolvedValueOnce(errorResponse(422));
    await queue.flush();
    expect(queue.rejectedCount()).toBe(1);
    expect(storage.dump().size).toBeGreaterThan(0);
  });

  it("survives storage refusing a write instead of failing the tender", async () => {
    // A full quota threw straight out of the tender path and took the till down.
    const full: QueueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      removeItem: () => {},
    };
    const spilled: unknown[] = [];
    const api = createApiClient(() => "token");
    const queue = new SaleQueue({
      storage: full,
      post: (p) => api.submitSale(p),
      onStorageFull: (e) => spilled.push(e),
    });

    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await expect(queue.submit(salePayload("s-full"))).resolves.toMatchObject({ status: "queued" });
    expect(spilled).toHaveLength(1);
  });
});
