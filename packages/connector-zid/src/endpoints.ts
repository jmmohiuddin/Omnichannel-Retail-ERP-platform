/**
 * Zid Merchant API endpoint catalog.
 *
 * IMPORTANT: This connector was written WITHOUT live Zid credentials to test
 * against. Zid's Merchant API is documented publicly (https://docs.zid.sa /
 * api.zid.sa), but every path, query parameter, header, and payload shape here
 * is a best-effort ASSUMPTION and is centralized HERE so the real values can
 * slot in without touching connector or mapping logic. Each entry is tagged
 * UNVERIFIED.
 */

// UNVERIFIED: confirm against Zid Merchant API docs (https://docs.zid.sa / api.zid.sa)
export const ZID_API_BASE = "https://api.zid.sa/v1";

export const zidEndpoints = {
  /** Lightweight auth/profile probe used by verifyCredentials. */
  // UNVERIFIED: confirm against Zid Merchant API docs (https://docs.zid.sa / api.zid.sa)
  authCheck: (): string => `${ZID_API_BASE}/managers/account/profile`,

  /**
   * Incremental order pull. `cursor` is treated as an ISO-8601 "updated-after"
   * watermark; when null, the full first page is fetched. Zid paginates with a
   * `page` query parameter in reality — the connector advances an updated-after
   * watermark instead, which the importer's dedupe tolerates.
   */
  // UNVERIFIED: confirm against Zid Merchant API docs — real param may be `page`
  //            and/or a differently named `updated-after`/`from_date` filter.
  listOrders: (cursor: string | null): string =>
    cursor === null
      ? `${ZID_API_BASE}/managers/store/orders`
      : `${ZID_API_BASE}/managers/store/orders?updated-after=${encodeURIComponent(cursor)}`,

  /** Acknowledge / mark an order as received by the merchant. */
  // UNVERIFIED: confirm against Zid Merchant API docs (path and whether ack exists)
  orderAck: (orderId: string): string =>
    `${ZID_API_BASE}/managers/store/orders/${encodeURIComponent(orderId)}/acknowledge`,

  /**
   * Batch stock/quantity update; body shape built in mapping.ts.
   * // UNVERIFIED: Zid may instead require a per-product PUT such as
   * //            `${ZID_API_BASE}/products/{id}/stock` rather than a batch call.
   */
  // UNVERIFIED: confirm against Zid Merchant API docs (path and batch limit)
  stockUpdate: (): string => `${ZID_API_BASE}/products/inventory/stock`,
} as const;

/**
 * Assumed credential fields and auth scheme.
 *
 * Zid notably uses a DUAL-TOKEN scheme on the Merchant API: an OAuth2
 * `Authorization: Bearer <access token>` PLUS a separate manager token passed
 * in an `X-Manager-Token` header, and often a `Store-Id` header to scope the
 * request to a store. All three are represented here.
 * // UNVERIFIED: confirm exact header names (`X-Manager-Token`, `Store-Id`),
 * // whether both tokens are always required, and the OAuth2 token lifecycle
 * // against Zid Merchant API docs (https://docs.zid.sa / api.zid.sa).
 */
export function zidAuthHeaders(
  credentials: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials["accessToken"] ?? ""}`,
    // UNVERIFIED: Zid's second (manager) token header — name and requirement.
    "X-Manager-Token": credentials["managerToken"] ?? "",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  // UNVERIFIED: store-scoping header — only sent when a store id is configured.
  if (credentials["storeId"] !== undefined && credentials["storeId"] !== "") {
    headers["Store-Id"] = credentials["storeId"];
  }
  return headers;
}
