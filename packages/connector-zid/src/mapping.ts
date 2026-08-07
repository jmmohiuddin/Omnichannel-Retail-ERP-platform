/**
 * Pure mapping functions between assumed Zid Merchant API payload shapes and
 * the SDK's normalized types. No I/O — fully unit-testable.
 *
 * The Zid shapes below are realistic ASSUMPTIONS.
 * // UNVERIFIED: confirm against Zid Merchant API docs (https://docs.zid.sa)
 */
import type {
  ChannelOrder,
  ChannelOrderLine,
  ChannelOrderStatus,
  InventoryPush,
} from "@omniretail/connector-sdk";

// ---------------------------------------------------------------------------
// Assumed Zid shapes
// ---------------------------------------------------------------------------

/**
 * One product line as (assumedly) returned by Zid. Zid serializes money as
 * DECIMAL STRINGS (e.g. "250.50" SAR), so prices are typed as strings here.
 */
// UNVERIFIED: confirm against Zid Merchant API docs
export interface ZidOrderProduct {
  id?: string | number;
  sku?: string;
  /** Some payloads nest the merchant SKU under the product. */
  product_sku?: string;
  name?: string;
  quantity?: number | string;
  /** Decimal major-unit string, e.g. "149.50". */
  price?: string | number;
}

/**
 * Zid represents order status as a small object with a machine `code` and a
 * localized `name`; a bare string is tolerated too.
 */
// UNVERIFIED: confirm against Zid Merchant API docs
export interface ZidOrderStatus {
  code?: string;
  name?: string;
}

/** An order as (assumedly) returned by Zid's order listing. */
// UNVERIFIED: confirm against Zid Merchant API docs
export interface ZidOrder {
  id: string | number;
  /** Human-facing order code/reference. */
  code?: string;
  reference_id?: string;
  order_status?: ZidOrderStatus | string;
  status?: string;
  currency_code?: string;
  currency?: string;
  products?: ZidOrderProduct[];
  customer?: { name?: string; email?: string; mobile?: string; phone?: string };
  /** Decimal major-unit strings. */
  order_subtotal?: string | number;
  order_total?: string | number;
  shipping_cost?: string | number;
  delivery_cost?: string | number;
  tax?: string | number;
  tax_amount?: string | number;
  discount_amount?: string | number;
  /** ISO 8601, typically Gulf time (+03:00 KSA / +04:00 UAE). */
  created_at?: string;
  updated_at?: string;
}

/** Assumed single-product stock-update entry (batched by the connector). */
// UNVERIFIED: confirm against Zid Merchant API docs
export interface ZidStockUpdate {
  sku: string;
  available_quantity: number;
  version: number;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Coerce a number to its plain decimal string without float rounding surprises. */
function numberToDecimalString(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}

/**
 * Decimal major units -> integer minor units (halalas/fils) using STRING and
 * INTEGER math only — never `value * 100` on a float. Zid sends money as
 * decimal strings like "250.50"; this parses digit-by-digit and rounds the
 * third fractional digit half-up. Missing/blank/garbage -> 0.
 */
export function toMinorUnits(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const raw = (typeof value === "number" ? numberToDecimalString(value) : value).trim();
  if (raw === "") return 0;

  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  // Defensively drop thousands separators / stray spaces before parsing.
  const cleaned = unsigned.replace(/[,_ ]/g, "");
  const [intPartRaw = "", fracPartRaw = ""] = cleaned.split(".");
  const intDigits = intPartRaw.replace(/\D/g, "");
  const fracDigits = fracPartRaw.replace(/\D/g, "");
  if (intDigits === "" && fracDigits === "") return 0;

  const intMinor = (intDigits === "" ? 0 : Number(intDigits)) * 100;
  const twoFrac = (fracDigits + "00").slice(0, 2);
  let minor = intMinor + Number(twoFrac);
  // Half-up rounding on the third fractional digit, integer-only.
  const thirdChar = fracDigits.charAt(2);
  if (thirdChar !== "" && thirdChar.charCodeAt(0) - 48 >= 5) minor += 1;

  return negative ? -minor : minor;
}

/** Coerce an assumed-numeric quantity field to a number, defaulting to 0. */
function toQuantity(value: number | string | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Pull the machine status string out of Zid's object-or-string status field. */
function statusString(order: ZidOrder): string {
  const s = order.order_status;
  if (typeof s === "string") return s;
  if (s !== undefined) return s.code ?? s.name ?? "";
  return order.status ?? "";
}

/**
 * Assumed Zid status vocabulary mapped onto the normalized lifecycle.
 * // UNVERIFIED: confirm against Zid Merchant API docs
 */
export function mapZidStatus(status: string): ChannelOrderStatus {
  switch (status.toLowerCase()) {
    case "new":
    case "pending":
    case "pending_payment":
    case "awaiting_payment":
    case "on_hold":
      return "pending";
    case "preparing":
    case "ready":
    case "confirmed":
    case "accepted":
    case "paid":
    case "processing":
    case "in_progress":
      return "paid";
    case "shipped":
    case "in_delivery":
    case "delivering":
    case "out_for_delivery":
    case "delivered":
    case "completed":
      return "shipped";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "refunded":
    case "reversed":
    case "returned":
      return "refunded";
    default:
      return "unknown";
  }
}

function mapLine(product: ZidOrderProduct, currency: string): ChannelOrderLine {
  const sku = product.sku ?? product.product_sku ?? "";
  const lineId =
    product.id !== undefined && product.id !== null ? String(product.id) : undefined;
  return {
    sku,
    ...(lineId !== undefined ? { channelLineId: lineId } : {}),
    quantity: toQuantity(product.quantity),
    unitPriceMinor: toMinorUnits(product.price),
    currency,
  };
}

/** Normalize a Zid order. `placedAt` is converted to UTC; `raw` is preserved. */
export function zidOrderToChannelOrder(order: ZidOrder): ChannelOrder {
  const currency = order.currency_code ?? order.currency ?? "SAR";
  const products = order.products ?? [];
  const lines = products.map((p) => mapLine(p, currency));

  const subtotalMinor =
    order.order_subtotal !== undefined
      ? toMinorUnits(order.order_subtotal)
      : lines.reduce((sum, l) => sum + l.unitPriceMinor * l.quantity, 0);
  const shippingMinor = toMinorUnits(order.shipping_cost ?? order.delivery_cost);
  const taxMinor = toMinorUnits(order.tax_amount ?? order.tax);
  const discountMinor = toMinorUnits(order.discount_amount);
  const grandMinor =
    order.order_total !== undefined
      ? toMinorUnits(order.order_total)
      : subtotalMinor + shippingMinor + taxMinor - discountMinor;

  const buyer = order.customer
    ? {
        ...(order.customer.name !== undefined ? { name: order.customer.name } : {}),
        ...(order.customer.email !== undefined ? { email: order.customer.email } : {}),
        ...(order.customer.mobile !== undefined
          ? { phone: order.customer.mobile }
          : order.customer.phone !== undefined
            ? { phone: order.customer.phone }
            : {}),
      }
    : undefined;

  const placedRaw = order.created_at ?? order.updated_at;
  const placedAt =
    placedRaw !== undefined ? new Date(placedRaw).toISOString() : new Date(0).toISOString();

  return {
    externalId: String(order.id),
    orderNumber: order.code ?? order.reference_id ?? String(order.id),
    placedAt,
    status: mapZidStatus(statusString(order)),
    currency,
    lines,
    ...(buyer !== undefined ? { buyer } : {}),
    totals: { subtotalMinor, shippingMinor, taxMinor, discountMinor, grandMinor },
    raw: order,
  };
}

/** Build the assumed Zid stock-update entry from one SDK inventory push. */
export function inventoryPushToZid(item: InventoryPush): ZidStockUpdate {
  return {
    sku: item.sku,
    available_quantity: item.availableQty,
    version: item.version,
  };
}
