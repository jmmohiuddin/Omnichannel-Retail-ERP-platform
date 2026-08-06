/**
 * Noon Marketplace endpoint catalog.
 *
 * IMPORTANT: Noon's seller API is not publicly documented in detail. Every
 * path, query parameter, and payload shape in this connector is an assumption
 * and is centralized HERE so the real values can slot in without touching
 * connector or mapping logic. Each entry is tagged UNVERIFIED.
 */

// UNVERIFIED: confirm against Noon Seller API docs
export const NOON_API_BASE = "https://api.noon.partners";

export const noonEndpoints = {
  /** Lightweight auth/profile probe used by verifyCredentials. */
  // UNVERIFIED: confirm against Noon Seller API docs
  authCheck: (): string => `${NOON_API_BASE}/v1/seller/profile`,

  /** Incremental order pull; `cursor` is an opaque server-issued token. */
  // UNVERIFIED: confirm against Noon Seller API docs (path, cursor param name)
  orders: (cursor: string | null): string =>
    cursor === null
      ? `${NOON_API_BASE}/v1/orders`
      : `${NOON_API_BASE}/v1/orders?cursor=${encodeURIComponent(cursor)}`,

  /** Acknowledge receipt of an order (ready-to-process signal). */
  // UNVERIFIED: confirm against Noon Seller API docs
  orderAck: (orderNr: string): string =>
    `${NOON_API_BASE}/v1/orders/${encodeURIComponent(orderNr)}/ack`,

  /** Batch stock update; body shape built in mapping.ts. */
  // UNVERIFIED: confirm against Noon Seller API docs (path and batch limit)
  inventoryBatch: (): string => `${NOON_API_BASE}/v1/inventory/batch`,
} as const;

/**
 * Assumed credential fields and auth scheme.
 * // UNVERIFIED: confirm against Noon Seller API docs (Noon may use an
 * // OAuth-style token exchange or an X-Api-Key header instead).
 */
export function noonAuthHeaders(
  credentials: Record<string, string>,
): Record<string, string> {
  return {
    Authorization: `Bearer ${credentials["apiKey"] ?? ""}`,
    "Content-Type": "application/json",
  };
}
