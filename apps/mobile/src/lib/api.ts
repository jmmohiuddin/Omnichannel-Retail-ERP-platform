/**
 * Typed client for the OmniRetail API (apps/api/src/pgApp.ts), mirroring the
 * conventions of apps/admin and apps/pos. Plain TypeScript, no React Native
 * imports — fully unit-testable in node. `fetch` is injectable for tests; at
 * runtime React Native's global fetch is used.
 */
import { getApiBase } from "./config";

/** Non-2xx HTTP response. Distinct from a network failure (fetch rejection). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? `${code} (HTTP ${status})`);
    this.name = "ApiError";
  }
}

/** True when the failure never reached the server (offline, DNS, refused). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && err.name === "NetworkError");
}

// ---- DTOs (mirror the API contract) ----

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

/** GET /v1/analytics/summary (apps/api AnalyticsService.summary). */
export interface AnalyticsSummary {
  today: { orders: number; revenueMinor: number; vatMinor: number };
  last7Days: { orders: number; revenueMinor: number };
  topSellers30Days: Array<{
    variantId: string;
    description: string | null;
    units: number;
    revenue: number;
  }>;
  stockValueMinor: number;
  onHandUnits: number;
}

export type ApprovalKind = "refund" | "stock_count";

export interface ApprovalDto {
  id: string;
  kind: ApprovalKind | string;
  reason: string;
  payload: Record<string, unknown>;
  requested_at: string;
  requestedBy: string;
}

export type OrderStatus = "pending" | "confirmed" | "fulfilled" | "cancelled" | "refunded";

export interface OrderDto {
  id: string;
  orderNo: string;
  status: OrderStatus;
  channelKind: string;
  customerName: string | null;
  totalMinor: number;
  currency: string;
  placedAt: string;
}

export interface VariantDto {
  id: string;
  sku: string;
  barcode?: string | null;
  priceMinor: number;
  currency: string;
}

export type Tracking = "none" | "batch" | "serialized";

export interface ProductDto {
  id: string;
  name: string;
  slug: string;
  tracking: Tracking | string;
  status?: string;
  variants: VariantDto[];
}

export interface LocationDto {
  id: string;
  kind: string;
  name: string;
  code: string;
}

/** Per-state quantities from the stock ledger (see @omniretail/domain Availability). */
export interface AvailabilityDto {
  onHand: number;
  reserved: number;
  available: number;
  inTransit: number;
  damaged: number;
  returnedPending: number;
}

export interface DailyDigestDto {
  digest: string;
  generatedBy: "claude" | "stub";
  data: Record<string, unknown>;
}

// ---- client ----

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  getToken: () => string | null;
  /** Called on any 401 so the app can drop the session and show Login. */
  onUnauthorized?: () => void;
  /** Injectable for tests; defaults to the global fetch (React Native / node). */
  fetchFn?: FetchLike;
  /** Injectable for tests; defaults to the live config module value. */
  baseUrl?: () => string;
}

export function createApiClient(options: ApiClientOptions) {
  const { getToken, onUnauthorized } = options;
  const baseUrl = options.baseUrl ?? getApiBase;
  const fetchFn: FetchLike =
    options.fetchFn ?? ((input, init) => fetch(input, init));

  async function request<T>(
    path: string,
    opts: { method?: string; body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const auth = opts.auth ?? true;
    const token = auth ? getToken() : null;
    const res = await fetchFn(`${baseUrl()}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) {
      onUnauthorized?.();
      throw new ApiError(401, "UNAUTHENTICATED");
    }
    if (!res.ok) {
      let code = "REQUEST_FAILED";
      let message: string | undefined;
      try {
        const payload = (await res.json()) as { error?: unknown; message?: unknown };
        if (typeof payload?.error === "string" && payload.error.length > 0) code = payload.error;
        if (typeof payload?.message === "string") message = payload.message;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, code, message);
    }
    return (await res.json()) as T;
  }

  return {
    login(input: LoginRequest): Promise<LoginResponse> {
      return request("/v1/auth/login", { method: "POST", body: input, auth: false });
    },

    getAnalyticsSummary(): Promise<AnalyticsSummary> {
      return request("/v1/analytics/summary");
    },

    listApprovals(): Promise<ApprovalDto[]> {
      return request<{ items: ApprovalDto[] }>("/v1/approvals").then((r) => r.items);
    },

    decideApproval(approvalId: string, approve: boolean): Promise<unknown> {
      return request(`/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
        method: "POST",
        body: { approve },
      });
    },

    /** Omit `status` to list all recent orders. */
    listOrders(status?: OrderStatus, limit = 100): Promise<OrderDto[]> {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      params.set("limit", String(limit));
      return request<{ items: OrderDto[] }>(`/v1/orders?${params.toString()}`).then(
        (r) => r.items,
      );
    },

    searchProducts(query: string): Promise<ProductDto[]> {
      const qs = query.length > 0 ? `?query=${encodeURIComponent(query)}` : "";
      return request<{ items: ProductDto[] }>(`/v1/products${qs}`).then((r) => r.items);
    },

    listLocations(): Promise<LocationDto[]> {
      return request<{ items: LocationDto[] }>("/v1/locations").then((r) => r.items);
    },

    getAvailability(variantId: string, locationId: string): Promise<AvailabilityDto> {
      return request(
        `/v1/inventory/availability/${encodeURIComponent(variantId)}/${encodeURIComponent(locationId)}`,
      );
    },

    getDailyDigest(): Promise<DailyDigestDto> {
      return request("/v1/ai/daily-digest");
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
