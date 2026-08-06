import { describe, expect, it } from "vitest";
import { ApiError, createApiClient, isNetworkError, type FetchLike } from "./api";

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(status: number, body: unknown | string) {
  const calls: RecordedCall[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(payload, {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchFn };
}

function client(fetchFn: FetchLike, token: string | null = "tok-123", onUnauthorized?: () => void) {
  return createApiClient({
    getToken: () => token,
    fetchFn,
    baseUrl: () => "http://api.test:3001",
    onUnauthorized,
  });
}

function headersOf(call: RecordedCall): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>;
}

describe("api client", () => {
  it("login posts credentials to /v1/auth/login without an Authorization header", async () => {
    const { calls, fetchFn } = fakeFetch(200, {
      accessToken: "a",
      refreshToken: "r",
      userId: "u",
      tenantId: "t",
    });
    const res = await client(fetchFn).login({
      slug: "acme",
      email: "o@acme.ae",
      password: "pw",
    });

    expect(res.accessToken).toBe("a");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://api.test:3001/v1/auth/login");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      slug: "acme",
      email: "o@acme.ae",
      password: "pw",
    });
    expect(headersOf(calls[0]!)).not.toHaveProperty("authorization");
  });

  it("authenticated GETs carry the bearer token", async () => {
    const { calls, fetchFn } = fakeFetch(200, {
      today: { orders: 0, revenueMinor: 0, vatMinor: 0 },
      last7Days: { orders: 0, revenueMinor: 0 },
      topSellers30Days: [],
      stockValueMinor: 0,
      onHandUnits: 0,
    });
    await client(fetchFn).getAnalyticsSummary();

    expect(calls[0]!.url).toBe("http://api.test:3001/v1/analytics/summary");
    expect(headersOf(calls[0]!).authorization).toBe("Bearer tok-123");
    // GET without a body must not claim a JSON content type.
    expect(headersOf(calls[0]!)).not.toHaveProperty("content-type");
  });

  it("searchProducts URL-encodes the query and unwraps items", async () => {
    const { calls, fetchFn } = fakeFetch(200, { items: [{ id: "p1", variants: [] }] });
    const items = await client(fetchFn).searchProducts("iphone 15 pro");

    expect(calls[0]!.url).toBe("http://api.test:3001/v1/products?query=iphone%2015%20pro");
    expect(items).toHaveLength(1);
  });

  it("listOrders builds ?status=&limit= and omits status when not filtering", async () => {
    const { calls, fetchFn } = fakeFetch(200, { items: [] });
    const api = client(fetchFn);
    await api.listOrders("pending", 50);
    await api.listOrders();

    expect(calls[0]!.url).toBe("http://api.test:3001/v1/orders?status=pending&limit=50");
    expect(calls[1]!.url).toBe("http://api.test:3001/v1/orders?limit=100");
  });

  it("decideApproval posts {approve} to the decision endpoint", async () => {
    const { calls, fetchFn } = fakeFetch(200, { ok: true });
    await client(fetchFn).decideApproval("appr-1", false);

    expect(calls[0]!.url).toBe("http://api.test:3001/v1/approvals/appr-1/decision");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ approve: false });
    expect(headersOf(calls[0]!)["content-type"]).toBe("application/json");
  });

  it("getAvailability escapes both path params", async () => {
    const { calls, fetchFn } = fakeFetch(200, {
      onHand: 3,
      reserved: 0,
      available: 3,
      inTransit: 0,
      damaged: 0,
      returnedPending: 0,
    });
    const res = await client(fetchFn).getAvailability("v/1", "l 2");

    expect(calls[0]!.url).toBe(
      "http://api.test:3001/v1/inventory/availability/v%2F1/l%202",
    );
    expect(res.available).toBe(3);
  });

  it("maps a JSON error body to ApiError {status, code, message}", async () => {
    const { fetchFn } = fakeFetch(403, { error: "SELF_APPROVAL", message: "cannot approve own request" });
    const err = await client(fetchFn)
      .decideApproval("appr-1", true)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).code).toBe("SELF_APPROVAL");
    expect((err as ApiError).message).toBe("cannot approve own request");
  });

  it("maps a non-JSON error body to REQUEST_FAILED and keeps the HTTP status", async () => {
    const { fetchFn } = fakeFetch(502, "<html>bad gateway</html>");
    const err = await client(fetchFn)
      .getDailyDigest()
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).code).toBe("REQUEST_FAILED");
  });

  it("a 401 fires onUnauthorized and throws UNAUTHENTICATED", async () => {
    const { fetchFn } = fakeFetch(401, { error: "UNAUTHENTICATED" });
    let dropped = 0;
    const err = await client(fetchFn, "stale", () => {
      dropped += 1;
    })
      .listApprovals()
      .catch((e: unknown) => e);

    expect(dropped).toBe(1);
    expect((err as ApiError).code).toBe("UNAUTHENTICATED");
  });

  it("isNetworkError distinguishes fetch rejections from HTTP errors", () => {
    expect(isNetworkError(new TypeError("Network request failed"))).toBe(true);
    expect(isNetworkError(new ApiError(500, "REQUEST_FAILED"))).toBe(false);
  });
});
