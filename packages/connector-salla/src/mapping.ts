/**
 * Pure mapping functions between assumed Salla payload shapes and the SDK's
 * normalized types. No I/O — fully unit-testable.
 *
 * The Salla shapes below follow Salla's public Merchant API design but are
 * ASSUMPTIONS until verified against a live account.
 * // UNVERIFIED: confirm against Salla Merchant API docs (https://docs.salla.dev)
 */
import type {
  ChannelOrder,
  ChannelOrderLine,
  ChannelOrderStatus,
  InventoryPush,
} from "@omniretail/connector-sdk";

// ---------------------------------------------------------------------------
// Assumed Salla shapes
// ---------------------------------------------------------------------------

/**
 * A money value as Salla (assumedly) returns it. Salla commonly nests amounts
 * under `{ amount, currency }`, but flat numbers/strings appear too — accept
 * all three defensively. Amounts are decimal major units (SAR/AED).
 */
// UNVERIFIED: confirm against Salla Merchant API docs (https://docs.salla.dev)
export type SallaAmount =
  | number
  | string
  | { amount?: number | string; currency?: string }
  | null;

/**
 * Salla order status. The API typically returns a `{ name, slug }` object, but
 * a bare slug string is also tolerated here.
 */
// UNVERIFIED: confirm against Salla Merchant API docs (https://docs.salla.dev)
export type SallaStatus =
  | string
  | { name?: string; slug?: string }
  | null
  | undefined;

/** One order item as (assumedly) returned by Salla. */
// UNVERIFIED: confirm against Salla Merchant API docs (https://docs.salla.dev)
export interface SallaOrderItem {
  id?: string | number;
  sku?: string;
  name?: string;
  quantity?: number;
  /** Per-unit price; Salla nests these under `amounts` in practice. */
  amounts?: { price_without_tax?: SallaAmount; total?: SallaAmount };
  /** Flat fallback when `amounts` is absent. */
  price?: SallaAmount;
}

/** An order as (assumedly) returned by Salla's order listing. */
// UNVERIFIED: confirm against Salla Merchant API docs (https://docs.salla.dev)
export interface SallaOrder {
  id: string | number;
  /** Human-facing order reference/number. */
  reference_id?: string | number;
  status?: SallaStatus;
  currency?: string;
  /** ISO 8601, typically Gulf/Riyadh time (+03:00). */
  date?: string;
  created_at?: string;
  items?: SallaOrderItem[];
  customer?: {
    first_name?: string;
    last_name?: string;
    name?: string;
    email?: string;
    mobile?: string;
    phone?: string;
  };
  amounts?: {
    sub_total?: SallaAmount;
    shipping_cost?: SallaAmount;
    tax?: SallaAmount;
    discount?: SallaAmount;
    total?: SallaAmount;
  };
}

/** Assumed per-item stock-update payload (one SKU). */
// UNVERIFIED: confirm against Salla Merchant API docs (https://docs.salla.dev)
export interface SallaInventoryItem {
  sku: string;
  quantity: number;
  version: number;
}

/** Assumed bulk stock-update payload. */
// UNVERIFIED: confirm against Salla Merchant API docs (https://docs.salla.dev)
export interface SallaInventoryPayload {
  products: SallaInventoryItem[];
}

// ---------------------------------------------------------------------------
// Money — decimal major units -> integer minor units, WITHOUT float drift
// ---------------------------------------------------------------------------

/**
 * Convert a decimal money string to integer minor units using pure string +
 * BigInt math — never `n * 100` on a float, so "199.95" is exactly 19995 and
 * "10.005" rounds to 1001 with no IEEE-754 drift. A 3rd fractional digit >= 5
 * rounds the minor amount up (half-up). Non-numeric input yields 0.
 */
function decimalStringToMinor(input: string): number {
  let s = input.trim();
  if (s === "") return 0;
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  // Only a plain decimal is supported; reject anything else (e.g. "1e3", "abc").
  if (!/^\d*(\.\d*)?$/.test(s)) return 0;

  const dot = s.indexOf(".");
  const intPart = (dot === -1 ? s : s.slice(0, dot)) || "0";
  const fracRaw = dot === -1 ? "" : s.slice(dot + 1);
  const frac = (fracRaw + "00").slice(0, 2); // pad/truncate to 2 minor digits

  let minor = BigInt(intPart) * 100n + BigInt(frac);
  // Half-up rounding based on the first dropped fractional digit.
  if (fracRaw.charAt(2) >= "5") minor += 1n;

  const result = Number(minor);
  return negative ? -result : result;
}

/**
 * Normalize any Salla amount shape to integer minor units (fils/halalas).
 * Numbers are stringified with JS's shortest round-trip representation first,
 * so the exact decimal ("149.5", not 149.4999…) drives the conversion.
 */
export function toMinorUnits(amount: SallaAmount | undefined): number {
  if (amount === null || amount === undefined) return 0;
  if (typeof amount === "object") {
    return toMinorUnits(amount.amount as SallaAmount | undefined);
  }
  if (typeof amount === "number") {
    if (!Number.isFinite(amount)) return 0;
    return decimalStringToMinor(String(amount));
  }
  // string
  return decimalStringToMinor(amount);
}

/** Read the currency code off a nested amount object when present. */
function amountCurrency(amount: SallaAmount | undefined): string | undefined {
  if (amount && typeof amount === "object") return amount.currency;
  return undefined;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Map Salla's status vocabulary onto the normalized lifecycle. Accepts either
 * a slug string or a `{ name, slug }` object.
 * // UNVERIFIED: confirm against Salla Merchant API docs (https://docs.salla.dev)
 */
export function mapSallaStatus(status: SallaStatus): ChannelOrderStatus {
  const raw =
    typeof status === "string"
      ? status
      : (status?.slug ?? status?.name ?? "");
  switch (raw.toLowerCase()) {
    case "payment_pending":
    case "waiting_payment":
    case "under_review":
    case "pending":
      return "pending";
    case "in_progress":
    case "processing":
    case "paid":
    case "completed":
      return "paid";
    case "delivering":
    case "shipped":
    case "delivered":
      return "shipped";
    case "canceled":
    case "cancelled":
      return "cancelled";
    case "refunded":
    case "restoring":
    case "restored":
    case "returned":
      return "refunded";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Order mapping
// ---------------------------------------------------------------------------

function joinName(
  customer: NonNullable<SallaOrder["customer"]>,
): string | undefined {
  if (customer.name) return customer.name;
  const parts = [customer.first_name, customer.last_name].filter(
    (p): p is string => typeof p === "string" && p !== "",
  );
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function mapBuyer(
  customer: SallaOrder["customer"],
): ChannelOrder["buyer"] | undefined {
  if (!customer) return undefined;
  const buyer: NonNullable<ChannelOrder["buyer"]> = {};
  const name = joinName(customer);
  if (name !== undefined) buyer.name = name;
  if (customer.email !== undefined) buyer.email = customer.email;
  const phone = customer.mobile ?? customer.phone;
  if (phone !== undefined) buyer.phone = phone;
  return Object.keys(buyer).length > 0 ? buyer : undefined;
}

function lineUnitAmount(item: SallaOrderItem): SallaAmount {
  return (
    item.amounts?.price_without_tax ??
    item.amounts?.total ??
    item.price ??
    0
  );
}

function mapLine(item: SallaOrderItem, currency: string): ChannelOrderLine {
  const unit = lineUnitAmount(item);
  const line: ChannelOrderLine = {
    sku: item.sku ?? "",
    quantity: item.quantity ?? 0,
    unitPriceMinor: toMinorUnits(unit),
    currency: amountCurrency(unit) ?? currency,
  };
  if (item.id !== undefined) line.channelLineId = String(item.id);
  return line;
}

/**
 * Normalize a Salla order into the SDK's `ChannelOrder`. `placedAt` is
 * converted to UTC ISO 8601; money is integer minor units; `raw` is preserved
 * for audit/replay. Missing/partial fields are handled defensively.
 */
export function sallaOrderToChannelOrder(order: SallaOrder): ChannelOrder {
  const currency = order.currency ?? "SAR";
  const items = order.items ?? [];
  const a = order.amounts;

  const subtotalMinor =
    a?.sub_total !== undefined
      ? toMinorUnits(a.sub_total)
      : items.reduce(
          (sum, i) => sum + toMinorUnits(lineUnitAmount(i)) * (i.quantity ?? 0),
          0,
        );
  const shippingMinor = toMinorUnits(a?.shipping_cost);
  const taxMinor = toMinorUnits(a?.tax);
  const discountMinor = toMinorUnits(a?.discount);
  const grandMinor =
    a?.total !== undefined
      ? toMinorUnits(a.total)
      : subtotalMinor + shippingMinor + taxMinor - discountMinor;

  const externalId = String(order.id);
  const placedRaw = order.date ?? order.created_at;
  const placedAt =
    placedRaw !== undefined && !Number.isNaN(Date.parse(placedRaw))
      ? new Date(placedRaw).toISOString()
      : new Date(0).toISOString();

  const mapped: ChannelOrder = {
    externalId,
    placedAt,
    status: mapSallaStatus(order.status),
    currency,
    lines: items.map((i) => mapLine(i, currency)),
    totals: { subtotalMinor, shippingMinor, taxMinor, discountMinor, grandMinor },
    raw: order,
  };

  const orderNumber =
    order.reference_id !== undefined ? String(order.reference_id) : externalId;
  mapped.orderNumber = orderNumber;

  const buyer = mapBuyer(order.customer);
  if (buyer !== undefined) mapped.buyer = buyer;

  return mapped;
}

// ---------------------------------------------------------------------------
// Inventory mapping
// ---------------------------------------------------------------------------

/** Build the assumed Salla per-SKU quantity-update payload for one item. */
export function inventoryPushToSalla(item: InventoryPush): SallaInventoryItem {
  return {
    sku: item.sku,
    quantity: item.availableQty,
    version: item.version,
  };
}

/** Build the assumed Salla bulk stock payload from SDK inventory pushes. */
export function toSallaInventoryPayload(
  items: InventoryPush[],
): SallaInventoryPayload {
  return { products: items.map(inventoryPushToSalla) };
}
