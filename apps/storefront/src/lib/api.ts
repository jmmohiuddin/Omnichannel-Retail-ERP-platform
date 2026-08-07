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

/**
 * Fetch a tenant's public catalog. Passing `lang` opts in to the per-tenant
 * translation overlay — the API returns `name`/`description` in the requested
 * language when the tenant has authored them and falls back to English
 * otherwise, so the caller never has to merge on the client.
 * Throws ApiError (404 for unknown slug).
 */
export async function fetchCatalog(slug: string, lang?: string): Promise<Catalog> {
  const qs = lang ? `?lang=${encodeURIComponent(lang)}` : "";
  const res = await fetch(`${API_BASE}/v1/public/${encodeURIComponent(slug)}/catalog${qs}`);
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

export interface PaymentIntentResult {
  intentId: string;
  gatewayRef: string;
  /** Hosted checkout page on the gateway — card data never touches this app. */
  redirectUrl?: string;
}

/**
 * Start payment for a pending order. Throws ApiError with code
 * "INTENT_EXISTS" (409) when payment was already started, or
 * "BAD_STATE" (409) when the order is no longer payable.
 */
export async function startPayment(slug: string, orderId: string): Promise<PaymentIntentResult> {
  const res = await fetch(
    `${API_BASE}/v1/public/${encodeURIComponent(slug)}/orders/${encodeURIComponent(orderId)}/pay`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as PaymentIntentResult;
}

// ---- Customer accounts (passwordless magic link) ------------------------

export interface RequestLinkResult {
  /** DEV ONLY — the server echoes the raw magic-link token because there is
   *  no email provider configured yet. Production will return `{ok:true}`
   *  instead (see the SEND_EMAIL toggle on the API). */
  devToken?: string;
  ok?: boolean;
}

export interface CustomerAccount {
  id: string;
  fullName: string;
  email: string;
}

export interface VerifyLinkResult {
  sessionToken: string;
  customer: CustomerAccount;
}

export interface CustomerOrderSummary {
  id: string;
  orderNo: string;
  status: string;
  totalMinor: number;
  currency: string;
  placedAt: string;
}

export interface CustomerUnitSummary {
  id: string;
  imei1: string | null;
  imei2: string | null;
  serialNo: string | null;
  sku: string;
  productName: string;
  warrantyUntil: string | null;
  orderNo: string;
  placedAt: string;
}

/** Request a magic link. Dev mode returns `devToken` in the response. */
export async function requestCustomerLink(
  slug: string,
  email: string,
): Promise<RequestLinkResult> {
  const res = await fetch(
    `${API_BASE}/v1/public/${encodeURIComponent(slug)}/customer/request-link`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    },
  );
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as RequestLinkResult;
}

/** Consume a magic link. Throws ApiError (401 with a specific code) on failure. */
export async function verifyCustomerLink(
  slug: string,
  email: string,
  token: string,
): Promise<VerifyLinkResult> {
  const res = await fetch(
    `${API_BASE}/v1/public/${encodeURIComponent(slug)}/customer/verify-link`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, token }),
    },
  );
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as VerifyLinkResult;
}

/**
 * Build the CustomerSession header. Kept separate so tests can assert its
 * exact shape (the scheme differs from the employee `Bearer` header on
 * purpose — see the customer scope in pgApp.ts).
 */
export function customerAuthHeaders(sessionToken: string): Record<string, string> {
  return { Authorization: `CustomerSession ${sessionToken}` };
}

export async function fetchCustomerOrders(
  slug: string,
  sessionToken: string,
): Promise<CustomerOrderSummary[]> {
  const res = await fetch(
    `${API_BASE}/v1/public/${encodeURIComponent(slug)}/customer/orders`,
    { headers: customerAuthHeaders(sessionToken) },
  );
  if (!res.ok) throw await errorFrom(res);
  return ((await res.json()) as { items: CustomerOrderSummary[] }).items;
}

export async function fetchCustomerUnits(
  slug: string,
  sessionToken: string,
): Promise<CustomerUnitSummary[]> {
  const res = await fetch(
    `${API_BASE}/v1/public/${encodeURIComponent(slug)}/customer/units`,
    { headers: customerAuthHeaders(sessionToken) },
  );
  if (!res.ok) throw await errorFrom(res);
  return ((await res.json()) as { items: CustomerUnitSummary[] }).items;
}
