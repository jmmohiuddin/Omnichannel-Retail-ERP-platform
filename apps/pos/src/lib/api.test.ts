import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiErrorCode,
  apiErrorMessage,
  toMinor,
  createApiClient,
  type StockUnit,
} from "./api.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const unit: StockUnit = {
  id: "u-1",
  variantId: "v-phone",
  imei1: "490154203237518",
  state: "in_stock",
  sku: "IP15-128-BLK",
  priceMinor: 315000,
  currency: "AED",
  productName: "iPhone 15 128GB Black",
};

describe("api client — serialized units, customers, loyalty", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const api = createApiClient(() => "test-token");

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getStockUnitByImei queries /v1/stock-units?imei= with auth", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(unit));
    await expect(api.getStockUnitByImei("490154203237518")).resolves.toEqual(unit);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/stock-units?imei=490154203237518");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
  });

  it("getStockUnitByImei surfaces a 404 as ApiError(404) for scan fallback", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "NOT_FOUND" }, 404));
    const err = await api.getStockUnitByImei("490154203237518").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  it("searchCustomers URL-encodes the phone-or-name query", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));
    await api.searchCustomers("+971 50 123");
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "/v1/customers?query=%2B971%2050%20123",
    );
  });

  it("createCustomer posts fullName and optional phone", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "c-1", fullName: "Amina Khan", loyaltyPoints: 0 }, 201),
    );
    await api.createCustomer({ fullName: "Amina Khan", phone: "+971501234567" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/customers");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      fullName: "Amina Khan",
      phone: "+971501234567",
    });
  });

  it("getLoyalty reads the customer's balance", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ points: 420, valueMinor: 4200, history: [] }));
    await expect(api.getLoyalty("c-1")).resolves.toEqual({
      points: 420,
      valueMinor: 4200,
      history: [],
    });
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/v1/customers/c-1/loyalty");
  });
});

describe("apiErrorMessage / apiErrorCode — server error surfacing", () => {
  it("extracts message and code from a flat { code, message } body", () => {
    const err = new ApiError(400, {
      code: "SERIALIZED_REQUIRED",
      message: "Scan the unit IMEI for serialized items.",
    });
    expect(apiErrorMessage(err, "fallback")).toBe("Scan the unit IMEI for serialized items.");
    expect(apiErrorCode(err)).toBe("SERIALIZED_REQUIRED");
  });

  it("extracts from a nested { error: { code, message } } body", () => {
    const err = new ApiError(422, {
      error: { code: "INSUFFICIENT_POINTS", message: "Customer has only 12 points." },
    });
    expect(apiErrorMessage(err, "fallback")).toBe("Customer has only 12 points.");
    expect(apiErrorCode(err)).toBe("INSUFFICIENT_POINTS");
  });

  it("extracts from the shape the API actually sends: { error: CODE, message }", () => {
    // Regression, found by driving the real POS against the real API. Neither
    // of the two shapes above is what the server emits — its global handler
    // sends `{ error: err.code, message: err.message }`. `apiErrorMessage`
    // returned `record.error` first, so the cashier saw the machine token
    // "NO_OPEN_CASH_SESSION"; and `apiErrorCode` only looked for `.code`, so it
    // returned null for every real error.
    const err = new ApiError(409, {
      error: "NO_OPEN_CASH_SESSION",
      message: "no open cash session on this register — open the till before taking cash",
    });
    expect(apiErrorMessage(err, "fallback")).toBe(
      "no open cash session on this register — open the till before taking cash",
    );
    expect(apiErrorCode(err)).toBe("NO_OPEN_CASH_SESSION");
  });

  it("never presents a bare error code as if it were a message", () => {
    // A code with no message must fall through to the caller's localized copy,
    // not be rendered at the till as English shouting.
    const err = new ApiError(400, { error: "SERIALIZED_REQUIRED" });
    expect(apiErrorMessage(err, "fallback")).toBe("fallback");
    expect(apiErrorCode(err)).toBe("SERIALIZED_REQUIRED");
  });

  it("falls back when the body carries no usable message", () => {
    expect(apiErrorMessage(new ApiError(500, null), "fallback")).toBe("fallback");
    expect(apiErrorMessage(new TypeError("offline"), "fallback")).toBe("fallback");
    expect(apiErrorCode(new ApiError(500, "oops"))).toBeNull();
  });
});

describe("toMinor — money arriving from the wire", () => {
  it("accepts an integer unchanged", () => {
    expect(toMinor(419900)).toBe(419900);
  });

  it("coerces the string Postgres sends for BIGINT", () => {
    // Regression: `/v1/stock-units?imei=` returned price_minor uncoerced, so the
    // POS received "419900". formatMinor rightly refused it and the exception
    // unmounted the sale screen — every IMEI scan blanked the till.
    expect(toMinor("419900")).toBe(419900);
  });

  it("refuses anything that is not integer minor units", () => {
    expect(() => toMinor(4199.5)).toThrow(/integer minor units/);
    expect(() => toMinor("not-money")).toThrow(/integer minor units/);
    expect(() => toMinor(null)).toThrow(/integer minor units/);
    expect(() => toMinor(undefined)).toThrow(/integer minor units/);
  });
});
