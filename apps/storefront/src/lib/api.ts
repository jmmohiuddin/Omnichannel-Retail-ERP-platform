import { API_BASE } from "./config.js";

/** A sellable variant as exposed by the public catalog endpoint. */
export interface CatalogVariant {
  id: string;
  sku: string;
  priceMinor: number;
  currency: string;
  /** Sellable stock right now (already net of reservations). */
  available: number;
}

export interface CatalogItem {
  productId: string;
  name: string;
  slug: string;
  description: string | null;
  tracking: string;
  variants: CatalogVariant[];
}

export interface Catalog {
  tenant: { name: string; slug: string; currency: string };
  items: CatalogItem[];
}

export interface OrderTotals {
  subtotalMinor: number;
  taxMinor: number;
  netMinor: number;
  totalMinor: number;
  currency: string;
}

export interface OrderResult {
  orderId: string;
  orderNo: string;
  totals: OrderTotals;
  status: string;
}

export interface OrderPayload {
  customer: { name: string; email?: string; phone?: string };
  lines: Array<{ variantId: string; quantity: number }>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  let code: string | null = null;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") code = body.error;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, code, code ?? `Request failed (${res.status})`);
}

/** Fetch a tenant's public catalog. Throws ApiError (404 for unknown slug). */
export async function fetchCatalog(slug: string): Promise<Catalog> {
  const res = await fetch(`${API_BASE}/v1/public/${encodeURIComponent(slug)}/catalog`);
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as Catalog;
}

/**
 * Place a public order. Throws ApiError with code "INSUFFICIENT_STOCK" (422)
 * when a line cannot be fulfilled, or status 404 for an unknown store.
 */
export async function placeOrder(slug: string, payload: OrderPayload): Promise<OrderResult> {
  const res = await fetch(`${API_BASE}/v1/public/${encodeURIComponent(slug)}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as OrderResult;
}
