/** Typed client for the OmniRetail API (see apps/api/src/pgApp.ts). */
import { API_BASE } from "./config.js";
import { accessToken, signOut } from "./auth.js";

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

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = accessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    signOut(); // expired/invalid token → back to /login via the auth store
    throw new ApiError(401, "UNAUTHENTICATED");
  }
  if (!res.ok) {
    let code = "REQUEST_FAILED";
    let message: string | undefined;
    try {
      const payload = (await res.json()) as { error?: string; message?: string };
      if (payload?.error) code = payload.error;
      message = payload?.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

// ---- types (mirror the API contract) ----

export type LocationKind = "store" | "warehouse" | "virtual";

export interface LocationDto {
  id: string;
  kind: LocationKind;
  name: string;
  code: string;
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
  tracking: Tracking;
  status: string;
  variants: VariantDto[];
}

export interface LevelDto {
  variantId: string;
  sku: string;
  productName: string;
  state: string;
  quantity: number | string;
}

export interface MovementBucketDto {
  locationId: string;
  state: string;
}

export interface MovementDto {
  id: string;
  seq: number;
  occurredAt: string;
  movementType: string;
  variantId: string;
  quantity: number | string;
  from?: MovementBucketDto | null;
  to?: MovementBucketDto | null;
  actorUserId: string;
  reference?: { type: string; id: string } | string | null;
  note?: string | null;
}

export interface MovementFeedDto {
  items: MovementDto[];
  nextCursor: number | null;
}

// ---- endpoints ----

export const listLocations = () =>
  request<{ items: LocationDto[] }>("/v1/locations").then((r) => r.items);

export const createLocation = (input: { kind: LocationKind; name: string; code: string }) =>
  request<LocationDto>("/v1/locations", { method: "POST", body: input });

export const listProducts = (query = "") =>
  request<{ items: ProductDto[] }>(
    `/v1/products${query ? `?query=${encodeURIComponent(query)}` : ""}`,
  ).then((r) => r.items);

export const createProduct = (input: { name: string; slug: string; tracking: Tracking }) =>
  request<{ id: string }>("/v1/products", { method: "POST", body: input });

export const createVariant = (
  productId: string,
  input: { sku: string; priceMinor: number; currency: string; barcode?: string },
) =>
  request<{ id: string }>(`/v1/products/${productId}/variants`, {
    method: "POST",
    body: input,
  });

export const listLevels = (locationId: string) =>
  request<{ items: LevelDto[] }>(
    `/v1/inventory/levels?locationId=${encodeURIComponent(locationId)}`,
  ).then((r) => r.items);

export const listMovements = (afterSeq = 0, limit = 100) =>
  request<MovementFeedDto>(`/v1/inventory/movements?afterSeq=${afterSeq}&limit=${limit}`);

export const getAvailability = (variantId: string, locationId: string) =>
  request<Record<string, unknown>>(
    `/v1/inventory/availability/${encodeURIComponent(variantId)}/${encodeURIComponent(locationId)}`,
  );

/** Walk the movement cursor feed from the start (bounded page count). */
export async function fetchAllMovements(maxPages = 10, pageSize = 500): Promise<MovementDto[]> {
  const all: MovementDto[] = [];
  let cursor = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const feed = await listMovements(cursor, pageSize);
    all.push(...feed.items);
    if (feed.nextCursor === null || feed.nextCursor === undefined || feed.items.length === 0) break;
    cursor = feed.nextCursor;
  }
  return all;
}
