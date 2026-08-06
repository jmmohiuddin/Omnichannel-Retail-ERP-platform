import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, listOrders } from "./api.js";
import {
  ORDER_STATUS_FILTERS,
  buildOrdersQuery,
  canCancel,
  canFulfill,
  fulfillErrorMessage,
  orderStatusTone,
} from "./orders.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildOrdersQuery", () => {
  it("omits the status param on the All tab", () => {
    expect(buildOrdersQuery("all")).toBe("?limit=100");
  });

  it("includes status and a custom limit for a specific tab", () => {
    expect(buildOrdersQuery("pending")).toBe("?status=pending&limit=100");
    expect(buildOrdersQuery("refunded", 25)).toBe("?status=refunded&limit=25");
  });

  it("covers every filter tab without throwing", () => {
    for (const f of ORDER_STATUS_FILTERS) expect(buildOrdersQuery(f)).toContain("limit=100");
  });

  it("is used verbatim by listOrders against /v1/orders", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listOrders(buildOrdersQuery("confirmed", 50));

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://localhost:3001/v1/orders?status=confirmed&limit=50");
  });
});

describe("row-action visibility", () => {
  it("offers Fulfill and Cancel only for open orders", () => {
    for (const status of ["pending", "confirmed"]) {
      expect(canFulfill(status)).toBe(true);
      expect(canCancel(status)).toBe(true);
    }
  });

  it("hides both actions once the order is terminal", () => {
    for (const status of ["fulfilled", "cancelled", "refunded"]) {
      expect(canFulfill(status)).toBe(false);
      expect(canCancel(status)).toBe(false);
    }
  });

  it("assigns badge tones by lifecycle direction", () => {
    expect(orderStatusTone("pending")).toBe("neutral");
    expect(orderStatusTone("confirmed")).toBe("in");
    expect(orderStatusTone("fulfilled")).toBe("in");
    expect(orderStatusTone("cancelled")).toBe("out");
    expect(orderStatusTone("refunded")).toBe("out");
  });
});

describe("fulfillErrorMessage", () => {
  it("explains 409 UNIT_REQUIRED as a warehouse scanning requirement", () => {
    const out = fulfillErrorMessage(new ApiError(409, "UNIT_REQUIRED"));
    expect(out).toContain("Serialized units");
    expect(out).toContain("scanned at the warehouse");
  });

  it("passes other errors through unchanged", () => {
    expect(fulfillErrorMessage(new ApiError(409, "ORDER_NOT_OPEN", "Order is not open"))).toBe(
      "Order is not open",
    );
    expect(fulfillErrorMessage("weird")).toBe("Fulfilment failed");
  });
});
