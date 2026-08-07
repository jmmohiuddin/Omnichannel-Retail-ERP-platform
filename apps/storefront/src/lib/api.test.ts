import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  customerAuthHeaders,
  fetchCatalog,
  fetchCustomerOrders,
  fetchCustomerUnits,
  requestCustomerLink,
  startPayment,
  verifyCustomerLink,
} from "./api.js";

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

describe("fetchCatalog language overlay", () => {
  const catalogBody = {
    tenant: { name: "Xlate", slug: "xlate", currency: "AED" },
    items: [
      {
        productId: "p1",
        name: "شاحن",
        slug: "wireless-charger",
        description: "شاحن سريع",
        tracking: "none",
        variants: [{ id: "v1", sku: "WC-1", priceMinor: 8900, currency: "AED", available: 5 }],
      },
    ],
  };

  it("omits the lang query string when no language is passed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, catalogBody));
    vi.stubGlobal("fetch", fetchMock);
    await fetchCatalog("xlate");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://localhost:3001/v1/public/xlate/catalog");
    expect(url).not.toContain("lang=");
  });

  it("passes ?lang=ar so the server can overlay Arabic content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, catalogBody));
    vi.stubGlobal("fetch", fetchMock);
    const catalog = await fetchCatalog("xlate", "ar");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/v1/public/xlate/catalog?lang=ar");
    // The client returns the API-overlaid payload verbatim — no client merge.
    expect(catalog.items[0]!.name).toBe("شاحن");
    expect(catalog.items[0]!.description).toBe("شاحن سريع");
  });
});

describe("customer accounts client", () => {
  it("customerAuthHeaders uses the CustomerSession scheme, not Bearer", () => {
    // The scheme differs from the employee `Bearer` scheme on purpose so an
    // employee token can never be spoofed onto shopper endpoints.
    expect(customerAuthHeaders("shopper-tok-123")).toEqual({
      Authorization: "CustomerSession shopper-tok-123",
    });
  });

  it("requestCustomerLink posts email and surfaces devToken", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { devToken: "abc123token" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await requestCustomerLink("shop", "aisha@example.test");
    expect(result.devToken).toBe("abc123token");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://localhost:3001/v1/public/shop/customer/request-link",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ email: "aisha@example.test" });
  });

  it("verifyCustomerLink returns session + surfaces LINK_EXPIRED as ApiError", async () => {
    const ok = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        sessionToken: "sess-1",
        customer: { id: "c1", fullName: "Aisha", email: "a@x.test" },
      }),
    );
    vi.stubGlobal("fetch", ok);
    const result = await verifyCustomerLink("shop", "a@x.test", "tok");
    expect(result.sessionToken).toBe("sess-1");
    expect(result.customer.fullName).toBe("Aisha");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(401, { error: "LINK_EXPIRED" })),
    );
    await expect(verifyCustomerLink("shop", "a@x.test", "tok")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      code: "LINK_EXPIRED",
    });
  });

  it("fetchCustomerOrders sends the CustomerSession header and unwraps items", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        items: [{
          id: "o1", orderNo: "INV-000001", status: "completed",
          totalMinor: 21000, currency: "AED", placedAt: "2026-08-01T10:15:00Z",
        }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const orders = await fetchCustomerOrders("shop", "sess-1");
    expect(orders).toHaveLength(1);
    expect(orders[0]!.orderNo).toBe("INV-000001");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3001/v1/public/shop/customer/orders");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "CustomerSession sess-1",
    );
  });

  it("fetchCustomerUnits propagates a 401 as an ApiError so the UI can clear the session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(401, { error: "UNAUTHENTICATED" })),
    );
    const err: unknown = await fetchCustomerUnits("shop", "sess-bad").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });
});
