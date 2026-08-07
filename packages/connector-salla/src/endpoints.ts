/**
 * Salla Merchant/Admin API endpoint catalog.
 *
 * IMPORTANT: This connector is built against Salla's PUBLICLY documented API
 * design (OAuth2 bearer tokens; base `https://api.salla.dev/admin/v2`) but has
 * NOT been verified against a live merchant account. Every path, query
 * parameter, header, and payload shape is centralized HERE so the real values
 * can slot in without touching connector or mapping logic. Each entry is tagged
 * UNVERIFIED — confirm against https://docs.salla.dev before production use.
 */

// UNVERIFIED: confirm against Salla Merchant API docs (https://docs.salla.dev)
export const SALLA_API_BASE = "https://api.salla.dev/admin/v2";

export const sallaEndpoints = {
  /** Lightweight auth/profile probe used by verifyCredentials. */
  // UNVERIFIED: confirm against Salla Merchant API docs (https://docs.salla.dev) —
  // Salla also exposes `/oauth2/user/info`; `/store/info` is assumed here.
  authCheck: (): string => `${SALLA_API_BASE}/store/info`,

  /**
   * Incremental order pull. `cursor` is an opaque server-issued pagination
   * token; `updatedAfter` is an ISO 8601 lower bound so the first pull (no
   * cursor yet) can still scope to recently changed orders.
   */
  // UNVERIFIED: confirm against Salla Merchant API docs (https://docs.salla.dev) —
  // path, cursor param name, and the updated-after filter name.
  orders: (
    cursor: string | null,
    updatedAfter?: string | null,
  ): string => {
    const params = new URLSearchParams();
    if (updatedAfter) params.set("updated_after", updatedAfter);
    if (cursor) params.set("cursor", cursor);
    const qs = params.toString();
    return qs
      ? `${SALLA_API_BASE}/orders?${qs}`
      : `${SALLA_API_BASE}/orders`;
  },

  /**
   * Update an order's status — Salla's acknowledge/ready-to-process step.
   */
  // UNVERIFIED: confirm against Salla Merchant API docs (https://docs.salla.dev)
  orderStatus: (orderId: string): string =>
    `${SALLA_API_BASE}/orders/${encodeURIComponent(orderId)}/status`,

  /** Bulk stock/quantity update; body shape built in mapping.ts. */
  // UNVERIFIED: confirm against Salla Merchant API docs (https://docs.salla.dev) —
  // Salla also exposes per-product `PUT /products/{id}/quantity`; a bulk
  // endpoint and its batch limit are assumed here.
  pushInventory: (): string => `${SALLA_API_BASE}/products/quantities`,
} as const;

/**
 * Salla authenticates with an OAuth2 access token (Bearer). The token is
 * obtained/refreshed by the host's credential layer; the connector only
 * stamps it onto requests.
 * // UNVERIFIED: confirm against Salla Merchant API docs (https://docs.salla.dev)
 */
export function sallaAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token ?? ""}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

/**
 * Header Salla stamps on webhook deliveries: an HMAC signature of the raw body
 * keyed on the app's webhook secret. Exposed for the host's webhook verifier.
 * // UNVERIFIED: confirm against Salla Merchant API docs (https://docs.salla.dev)
 */
export const SALLA_WEBHOOK_SIGNATURE_HEADER = "X-Salla-Signature";
