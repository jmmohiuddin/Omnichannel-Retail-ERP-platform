/**
 * Courier-agnostic shipping port (hexagonal boundary).
 *
 * ShippingService talks only to this interface; each courier is an adapter
 * behind a registry key. v1 ships with MockCourier below — real UAE couriers
 * plug in later as adapters implementing CourierPort, without touching the
 * service or schema:
 *
 *   'aramex'     — Aramex Shipping Services API (SOAP/REST)
 *   'smsa'       — SMSA Express REST API
 *   'quiqup'     — Quiqup on-demand delivery API (same-day Dubai)
 *   'careem_box' — Careem Box delivery API
 *
 * Adapters own auth, retries and payload mapping; they must return a courier
 * tracking number on creation and normalize courier state machines onto
 * ShipmentStatus when tracking.
 */

/** Mirrors the shipment.status CHECK constraint in 015_shipping.sql. */
export type ShipmentStatus =
  | "created"
  | "handed_over"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "failed"
  | "returned";

export interface CreateShipmentRequest {
  orderId: string;
  orderNo: string;
  /** Destination address snapshot (free-form; couriers map their own fields). */
  address: Record<string, unknown>;
  /** Cash to collect on delivery, minor units (fils). 0 = prepaid. */
  codAmountMinor: number;
  parcels: { weightGrams?: number; description: string }[];
}

export interface CreateShipmentResult {
  trackingNo: string;
  labelUrl?: string;
}

export interface TrackingEvent {
  status: ShipmentStatus;
  description: string;
  occurredAtIso: string;
}

export interface TrackingResult {
  /** Current courier-side status (the last event's status). */
  status: ShipmentStatus;
  /** Full history so far, oldest first. May repeat events already seen. */
  events: TrackingEvent[];
}

export interface CourierPort {
  createShipment(req: CreateShipmentRequest): Promise<CreateShipmentResult>;
  track(trackingNo: string): Promise<TrackingResult>;
  /** Optional: not every courier supports cancellation after hand-over. */
  cancel?(trackingNo: string): Promise<void>;
}

/**
 * Deterministic in-memory courier for tests and local development.
 *
 * - Tracking numbers derive from the order number (`MOCK-<orderNo>`), so tests
 *   can assert on them without capturing state.
 * - The constructor takes a scripted status sequence; each `track` call
 *   advances one step and returns the CUMULATIVE history up to the cursor —
 *   deliberately re-sending already-reported events, exactly like real courier
 *   tracking feeds, so callers must dedupe.
 * - Event timestamps are frozen per instance (one hour apart, starting one
 *   hour after construction so courier events sort after the local 'created'
 *   event), keeping the dedupe key (status, occurredAt) stable across calls.
 */
export class MockCourier implements CourierPort {
  private readonly cursor = new Map<string, number>();
  private static readonly HOUR_MS = 3_600_000;
  private readonly epochMs = Date.now() + MockCourier.HOUR_MS;

  constructor(
    private readonly script: ShipmentStatus[] = [
      "handed_over",
      "in_transit",
      "out_for_delivery",
      "delivered",
    ],
  ) {}

  async createShipment(req: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const trackingNo = `MOCK-${req.orderNo}`;
    return {
      trackingNo,
      labelUrl: `https://labels.mock-courier.test/${trackingNo}.pdf`,
    };
  }

  async track(trackingNo: string): Promise<TrackingResult> {
    const seen = Math.min((this.cursor.get(trackingNo) ?? 0) + 1, this.script.length);
    this.cursor.set(trackingNo, seen);
    const events: TrackingEvent[] = this.script.slice(0, seen).map((status, i) => ({
      status,
      description: `mock courier: ${status.replace(/_/g, " ")}`,
      occurredAtIso: new Date(this.epochMs + i * MockCourier.HOUR_MS).toISOString(),
    }));
    const last = events[events.length - 1];
    return { status: last ? last.status : "created", events };
  }

  async cancel(trackingNo: string): Promise<void> {
    this.cursor.delete(trackingNo);
  }
}
