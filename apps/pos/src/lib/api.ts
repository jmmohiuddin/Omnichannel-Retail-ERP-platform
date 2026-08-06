/**
 * Thin typed client for the OmniRetail API (apps/api). Auth is a bearer token
 * provided by a getter so the module stays stateless and testable.
 */

export const API_URL: string =
  (import.meta.env?.VITE_API_URL as string | undefined) ?? "http://localhost:3001";

/** Non-2xx HTTP response. Distinct from a network failure (fetch rejection). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `API request failed with status ${status}`);
    this.name = "ApiError";
  }
}

/** True when the failure never reached the server (offline, DNS, refused). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && err.name === "NetworkError");
}

export interface LoginRequest {
  slug: string;
  email: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  userId: string;
  tenantId: string;
}

export interface LocationSummary {
  id: string;
  kind: string;
  name: string;
  code: string;
}

export interface VariantSummary {
  id: string;
  sku: string;
  barcode: string | null;
  priceMinor: number;
  currency: string;
}

export interface ProductSummary {
  id: string;
  name: string;
  slug: string;
  tracking: string;
  variants: VariantSummary[];
}

/** A serialized (IMEI/serial-tracked) unit as returned by /v1/stock-units. */
export interface StockUnit {
  id: string;
  variantId: string;
  imei1?: string;
  imei2?: string;
  serialNo?: string;
  state: string;
  locationId?: string;
  sku: string;
  priceMinor: number;
  currency: string;
  productName: string;
}

export interface CustomerSummary {
  id: string;
  fullName: string;
  phone?: string | null;
  email?: string | null;
  loyaltyPoints: number;
}

export interface LoyaltyBalance {
  points: number;
  /** Redeemable value of the points, in fils. */
  valueMinor: number;
  history: unknown[];
}

export interface SaleLinePayload {
  variantId: string;
  quantity: number;
  unitPriceMinor: number;
  stockUnitId?: string;
}

export type TenderMethod = "cash" | "card";

export interface SalePaymentPayload {
  method: TenderMethod | "loyalty_points";
  amountMinor: number;
}

export interface SalePayload {
  /** Client-generated UUID — the idempotency key for offline replay. */
  id: string;
  deviceId: string;
  locationId: string;
  customerId?: string;
  customerName?: string;
  lines: SaleLinePayload[];
  payments: SalePaymentPayload[];
}

export interface SaleResult {
  orderId: string;
  orderNo: string;
  totals: {
    subtotalMinor: number;
    taxMinor: number;
    totalMinor: number;
    currency: string;
  };
}

export interface ReceiptLine {
  name?: string;
  sku?: string;
  quantity?: number;
  unitPriceMinor?: number;
  totalMinor?: number;
  taxMinor?: number;
}

/** Receipt JSON — rendered defensively; fields the server omits are skipped. */
export interface Receipt {
  tenantName?: string;
  trn?: string;
  orderNo?: string;
  issuedAt?: string;
  lines?: ReceiptLine[];
  totals?: {
    subtotalMinor?: number;
    taxMinor?: number;
    totalMinor?: number;
    currency?: string;
  };
  [key: string]: unknown;
}

/**
 * Best-effort extraction of the server's error message from an ApiError body.
 * The API errors as `{ code, message }` or `{ error: { code, message } }`;
 * both shapes (and a bare `{ error: "…" }`) are handled defensively.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  const body = err.body;
  if (body === null || typeof body !== "object") return fallback;
  const record = body as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.length > 0) return record.error;
  for (const candidate of [record, record.error]) {
    if (candidate !== null && typeof candidate === "object") {
      const message = (candidate as Record<string, unknown>).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
  }
  return fallback;
}

/** The machine-readable error code (e.g. INSUFFICIENT_POINTS), if present. */
export function apiErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.body;
  if (body === null || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const candidate of [record, record.error]) {
    if (candidate !== null && typeof candidate === "object") {
      const code = (candidate as Record<string, unknown>).code;
      if (typeof code === "string" && code.length > 0) return code;
    }
  }
  return null;
}

type TokenGetter = () => string | null;

async function request<T>(
  path: string,
  init: RequestInit,
  getToken: TokenGetter | null,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (getToken) {
    const token = getToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
  }
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, body);
  }
  return (await res.json()) as T;
}

export function createApiClient(getToken: TokenGetter) {
  return {
    login(input: LoginRequest): Promise<LoginResponse> {
      return request("/v1/auth/login", { method: "POST", body: JSON.stringify(input) }, null);
    },
    listLocations(): Promise<{ items: LocationSummary[] }> {
      return request("/v1/locations", { method: "GET" }, getToken);
    },
    searchProducts(query: string): Promise<{ items: ProductSummary[] }> {
      const qs = query.length > 0 ? `?query=${encodeURIComponent(query)}` : "";
      return request(`/v1/products${qs}`, { method: "GET" }, getToken);
    },
    registerDevice(name: string): Promise<{ id: string }> {
      return request(
        "/v1/devices",
        { method: "POST", body: JSON.stringify({ kind: "pos_register", name }) },
        getToken,
      );
    },
    submitSale(payload: SalePayload): Promise<SaleResult> {
      return request("/v1/pos/sales", { method: "POST", body: JSON.stringify(payload) }, getToken);
    },
    getReceipt(orderId: string): Promise<Receipt> {
      return request(`/v1/orders/${orderId}/receipt`, { method: "GET" }, getToken);
    },
    /** Serialized unit lookup by exact IMEI — 404 when no unit carries it. */
    getStockUnitByImei(imei: string): Promise<StockUnit> {
      return request(
        `/v1/stock-units?imei=${encodeURIComponent(imei)}`,
        { method: "GET" },
        getToken,
      );
    },
    searchCustomers(query: string): Promise<{ items: CustomerSummary[] }> {
      return request(
        `/v1/customers?query=${encodeURIComponent(query)}`,
        { method: "GET" },
        getToken,
      );
    },
    createCustomer(input: { fullName: string; phone?: string }): Promise<CustomerSummary> {
      return request("/v1/customers", { method: "POST", body: JSON.stringify(input) }, getToken);
    },
    getLoyalty(customerId: string): Promise<LoyaltyBalance> {
      return request(`/v1/customers/${customerId}/loyalty`, { method: "GET" }, getToken);
    },
    getAvailability(
      variantId: string,
      locationId: string,
    ): Promise<{ onHand: number; available: number }> {
      return request(
        `/v1/inventory/availability/${variantId}/${locationId}`,
        { method: "GET" },
        getToken,
      );
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
