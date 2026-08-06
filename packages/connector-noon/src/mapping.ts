/**
 * Pure mapping functions between assumed Noon payload shapes and the SDK's
 * normalized types. No I/O — fully unit-testable.
 *
 * The Noon shapes below are realistic ASSUMPTIONS.
 * // UNVERIFIED: confirm against Noon Seller API docs
 */
import type {
  ChannelOrder,
  ChannelOrderLine,
  ChannelOrderStatus,
  InventoryPush,
} from "@omniretail/connector-sdk";

// ---------------------------------------------------------------------------
// Assumed Noon shapes
// ---------------------------------------------------------------------------

/** One order item as (assumedly) returned by Noon. Amounts are decimal AED. */
// UNVERIFIED: confirm against Noon Seller API docs
export interface NoonOrderItem {
  /** Noon-side SKU (often the partner's own SKU echoed back). */
  sku: string;
  item_nr?: string;
  qty: number;
  /** Decimal major units, e.g. 149.5 AED. */
  unit_price: number;
}

/** An order as (assumedly) returned by Noon's order listing. */
// UNVERIFIED: confirm against Noon Seller API docs
export interface NoonOrder {
  order_nr: string;
  /** ISO 8601, typically Gulf time (+04:00). */
  ordered_at: string;
  status: string;
  currency: string;
  items: NoonOrderItem[];
  customer?: { name?: string; email?: string; phone?: string };
  subtotal?: number;
  shipping_fee?: number;
  tax_amount?: number;
  discount?: number;
  order_total?: number;
}

/** Assumed batch stock-update payload. */
// UNVERIFIED: confirm against Noon Seller API docs
export interface NoonInventoryPayload {
  skus: Array<{ sku: string; stock: number; version: number }>;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Decimal major units -> integer minor units (fils). Never floats for money. */
export function toMinorUnits(amount: number | undefined): number {
  return Math.round((amount ?? 0) * 100);
}

/**
 * Assumed Noon status vocabulary mapped onto the normalized lifecycle.
 * // UNVERIFIED: confirm against Noon Seller API docs
 */
export function mapNoonStatus(status: string): ChannelOrderStatus {
  switch (status.toLowerCase()) {
    case "pending":
    case "payment_pending":
      return "pending";
    case "confirmed":
    case "ready_to_ship":
    case "packed":
      return "paid";
    case "shipped":
    case "delivered":
      return "shipped";
    case "cancelled":
      return "cancelled";
    case "returned":
    case "refunded":
      return "refunded";
    default:
      return "unknown";
  }
}

function mapLine(item: NoonOrderItem, currency: string): ChannelOrderLine {
  return {
    sku: item.sku,
    ...(item.item_nr !== undefined ? { channelLineId: item.item_nr } : {}),
    quantity: item.qty,
    unitPriceMinor: toMinorUnits(item.unit_price),
    currency,
  };
}

/** Normalize a Noon order. `placedAt` is converted to UTC; `raw` is preserved. */
export function mapNoonOrder(order: NoonOrder): ChannelOrder {
  const subtotalMinor =
    order.subtotal !== undefined
      ? toMinorUnits(order.subtotal)
      : order.items.reduce((sum, i) => sum + toMinorUnits(i.unit_price) * i.qty, 0);
  const shippingMinor = toMinorUnits(order.shipping_fee);
  const taxMinor = toMinorUnits(order.tax_amount);
  const discountMinor = toMinorUnits(order.discount);
  const grandMinor =
    order.order_total !== undefined
      ? toMinorUnits(order.order_total)
      : subtotalMinor + shippingMinor + taxMinor - discountMinor;

  return {
    externalId: order.order_nr,
    orderNumber: order.order_nr,
    placedAt: new Date(order.ordered_at).toISOString(),
    status: mapNoonStatus(order.status),
    currency: order.currency,
    lines: order.items.map((i) => mapLine(i, order.currency)),
    ...(order.customer !== undefined ? { buyer: order.customer } : {}),
    totals: { subtotalMinor, shippingMinor, taxMinor, discountMinor, grandMinor },
    raw: order,
  };
}

/** Build the assumed Noon batch stock payload from SDK inventory pushes. */
export function toNoonInventoryPayload(
  items: InventoryPush[],
): NoonInventoryPayload {
  return {
    skus: items.map((i) => ({
      sku: i.sku,
      stock: i.availableQty,
      version: i.version,
    })),
  };
}
