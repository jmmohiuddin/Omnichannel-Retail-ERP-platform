/**
 * Presentation mapper for stock-movement ledger rows: raw feed items → the
 * human-readable strings the audit tables render. Pure functions, no I/O.
 */
import type { MovementBucketDto, MovementDto } from "./api.js";

export type BadgeTone = "in" | "out" | "neutral";

export interface PresentedMovement {
  id: string;
  seq: number;
  time: string;
  typeLabel: string;
  tone: BadgeTone;
  sku: string;
  quantity: string;
  fromLabel: string;
  toLabel: string;
  flow: string;
  actor: string;
  reference: string;
  note: string;
}

const INBOUND = new Set(["receipt", "return_in", "transfer_in", "repair_in", "release"]);
const OUTBOUND = new Set(["sale", "transfer_out", "repair_out", "write_off", "reservation"]);

/** "on_hand" → "On hand" */
export function humanState(state: string): string {
  const words = state.replace(/_/g, " ").trim();
  return words.length === 0 ? state : words.charAt(0).toUpperCase() + words.slice(1);
}

/** "transfer_out" → "Transfer out" */
export function movementTypeLabel(movementType: string): string {
  return humanState(movementType);
}

export function movementTone(movementType: string): BadgeTone {
  if (INBOUND.has(movementType)) return "in";
  if (OUTBOUND.has(movementType)) return "out";
  return "neutral";
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * "Main Store · On hand". A missing bucket means the stock crossed the tenant
 * boundary (e.g. a receipt has no `from`) and renders as "External".
 */
export function bucketLabel(
  bucket: MovementBucketDto | null | undefined,
  locationName: (id: string) => string | undefined,
): string {
  if (!bucket) return "External";
  const name = locationName(bucket.locationId) ?? shortId(bucket.locationId);
  return `${name} · ${humanState(bucket.state)}`;
}

/** "External → Main Store · On hand" */
export function flowLabel(
  movement: Pick<MovementDto, "from" | "to">,
  locationName: (id: string) => string | undefined,
): string {
  return `${bucketLabel(movement.from, locationName)} → ${bucketLabel(movement.to, locationName)}`;
}

export function formatReference(reference: MovementDto["reference"]): string {
  if (!reference) return "—";
  if (typeof reference === "string") return reference;
  return `${reference.type}:${shortId(reference.id)}`;
}

/** Quantities arrive as NUMERIC(14,3); trim trailing zeros for display. */
export function formatQuantity(quantity: number | string): string {
  const n = typeof quantity === "number" ? quantity : Number(quantity);
  if (!Number.isFinite(n)) return String(quantity);
  return n % 1 === 0 ? String(n) : String(Number(n.toFixed(3)));
}

const dubaiTime = new Intl.DateTimeFormat("en-AE", {
  timeZone: "Asia/Dubai",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Format an ISO timestamp in the tenant's default timezone (Asia/Dubai). */
export function formatDubaiTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return dubaiTime.format(d);
}

export function presentMovement(
  movement: MovementDto,
  lookups: {
    locationName: (id: string) => string | undefined;
    sku?: (variantId: string) => string | undefined;
  },
): PresentedMovement {
  return {
    id: movement.id,
    seq: movement.seq,
    time: formatDubaiTime(movement.occurredAt),
    typeLabel: movementTypeLabel(movement.movementType),
    tone: movementTone(movement.movementType),
    sku: lookups.sku?.(movement.variantId) ?? shortId(movement.variantId),
    quantity: formatQuantity(movement.quantity),
    fromLabel: bucketLabel(movement.from, lookups.locationName),
    toLabel: bucketLabel(movement.to, lookups.locationName),
    flow: flowLabel(movement, lookups.locationName),
    actor: shortId(movement.actorUserId),
    reference: formatReference(movement.reference),
    note: movement.note ?? "",
  };
}
