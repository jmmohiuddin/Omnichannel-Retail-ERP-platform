import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, startPayment } from "./api.js";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startPayment", () => {
  it("posts to the public pay endpoint and returns the intent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        intentId: "i1",
        gatewayRef: "mock_abc",
        redirectUrl: "https://pay.mock.invalid/checkout/mock_abc",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const intent = await startPayment("deira-mobile", "order-1");
    expect(intent.redirectUrl).toContain("mock_abc");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/public/deira-mobile/orders/order-1/pay");
    expect(init.method).toBe("POST");
  });

  it("surfaces INTENT_EXISTS as a typed ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(409, { error: "INTENT_EXISTS" })),
    );
    await expect(startPayment("s", "o")).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      code: "INTENT_EXISTS",
    });
  });

  it("URL-encodes slug and order id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { intentId: "i", gatewayRef: "g" }));
    vi.stubGlobal("fetch", fetchMock);
    await startPayment("a b", "x/y");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/v1/public/a%20b/orders/x%2Fy/pay");
  });

  it("wraps non-JSON failures generically", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
    );
    const err: unknown = await startPayment("s", "o").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });
});
