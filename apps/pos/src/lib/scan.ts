/**
 * Scan-input routing. A scanner types a token and sends Enter; the token is
 * either an IMEI (serialized unit lookup) or a barcode/SKU (product lookup).
 * IMEI validation lives in the domain core — never re-implemented here.
 */
import { isValidImei } from "@omniretail/domain";

/** True for a 15-digit Luhn-valid IMEI or a 16-digit IMEISV. */
export function isImeiToken(token: string): boolean {
  return /^\d{15,16}$/.test(token) && isValidImei(token);
}

export type ScanRoute = "stock-unit" | "product";

/**
 * Where a scanned token is looked up first. IMEI-shaped tokens go to the
 * stock-unit endpoint (a 404 there falls back to the product route at the call
 * site); everything else — including 14-digit codes and 15-digit strings that
 * fail the Luhn check — is a plain barcode/SKU lookup.
 */
export function classifyScanToken(token: string): ScanRoute {
  return isImeiToken(token) ? "stock-unit" : "product";
}
