import type pg from "pg";
import type { Db } from "../db.js";

/**
 * Product event instrumentation (R12.1) and funnel measurement (R12.2).
 *
 * G7 — "a goal without instrumentation is a wish". Every event lands in the
 * append-only `product_event` stream (028_analytics_events.sql), immutable at
 * the database level and RLS-scoped per tenant, so a funnel number cannot be
 * edited after the fact.
 *
 * Writes come in two forms, mirroring AuditService: `recordWith` joins the
 * caller's transaction — an `order_placed` event commits with the order or not
 * at all — while `record` opens its own for fire-and-forget page events.
 */

/** The nine events R12.1 mandates. */
export const R12_1_EVENTS = [
  "product_viewed",
  "add_to_cart",
  "checkout_started",
  "checkout_failed",
  "order_placed",
  "search_performed",
  "cod_refused",
  "pos_sale",
  "admin_action",
] as const;

/**
 * Steps R12.2's funnels need that R12.1 does not name: the home/landing step of
 * home→PDP→cart→checkout→order, and the tail of order placed→confirmation
 * delivered→tracked. R12.1 lists a minimum, not a closed set.
 */
export const R12_2_FUNNEL_EVENTS = [
  "page_viewed",
  "confirmation_delivered",
  "order_tracked",
] as const;

export const EVENT_NAMES = [...R12_1_EVENTS, ...R12_2_FUNNEL_EVENTS] as const;

/** Union type: a mistyped event name is a compile error, not a lost metric. */
export type EventName = (typeof EVENT_NAMES)[number];

const EVENT_NAME_SET: ReadonlySet<string> = new Set(EVENT_NAMES);

/** Runtime guard for names arriving over HTTP (where the union cannot help). */
export const isEventName = (value: unknown): value is EventName =>
  typeof value === "string" && EVENT_NAME_SET.has(value);

export interface ProductEvent {
  /** Client-generated UUID; replaying the same id is a no-op (offline beacons). */
  id?: string;
  name: EventName;
  /** Anonymous visitor/device key — the default funnel correlation key. */
  sessionId?: string;
  /** Staff actor, for pos_sale / admin_action. */
  userId?: string;
  /** Signed-in shopper, when known. */
  customerId?: string;
  orderId?: string;
  props?: Record<string, unknown>;
  /** Only for replayed offline events; otherwise the server clock wins. */
  occurredAt?: Date | string;
}

export class EventError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EventError";
  }
}

/** Columns a funnel may correlate on. Whitelisted: interpolated into SQL. */
export const FUNNEL_KEYS = ["session_id", "customer_id", "order_id", "user_id"] as const;
export type FunnelKey = (typeof FUNNEL_KEYS)[number];

export interface FunnelStep {
  event: EventName;
  /** Reporting label; defaults to the event name. */
  label?: string;
  /** jsonb containment predicate — the event's props must contain this. */
  props?: Record<string, unknown>;
}

export interface FunnelSpec {
  steps: FunnelStep[];
  /** Defaults to `session_id`. */
  key?: FunnelKey;
  fromIso?: string;
  toIso?: string;
}

export interface FunnelStepResult {
  step: number;
  label: string;
  event: EventName;
  /** Distinct keys that reached this step in order. */
  count: number;
  /** count / previous step's count; null on the first step. */
  conversionFromPrevious: number | null;
  /** count / first step's count; null on the first step. */
  conversionFromStart: number | null;
}

export interface FunnelResult {
  key: FunnelKey;
  fromIso: string;
  toIso: string;
  steps: FunnelStepResult[];
}

export type FunnelPreset = "browse" | "search" | "post_order";

/** R12.2's three funnels, ready to run. */
export const FUNNEL_PRESETS: Record<FunnelPreset, { key: FunnelKey; steps: FunnelStep[] }> = {
  /** home → PDP → cart → checkout → order. */
  browse: {
    key: "session_id",
    steps: [
      { event: "page_viewed", label: "home", props: { page: "home" } },
      { event: "product_viewed", label: "pdp" },
      { event: "add_to_cart", label: "cart" },
      { event: "checkout_started", label: "checkout" },
      { event: "order_placed", label: "order" },
    ],
  },
  /** search → click → cart. Storefront tags the PDP view it came from. */
  search: {
    key: "session_id",
    steps: [
      { event: "search_performed", label: "search" },
      { event: "product_viewed", label: "click", props: { source: "search" } },
      { event: "add_to_cart", label: "cart" },
    ],
  },
  /** order placed → confirmation delivered → tracked. Correlated by order. */
  post_order: {
    key: "order_id",
    steps: [
      { event: "order_placed", label: "placed" },
      { event: "confirmation_delivered", label: "confirmed" },
      { event: "order_tracked", label: "tracked" },
    ],
  },
};

export const isFunnelPreset = (value: unknown): value is FunnelPreset =>
  typeof value === "string" && Object.hasOwn(FUNNEL_PRESETS, value);

const DEFAULT_WINDOW_DAYS = 30;
const MAX_STEPS = 8;

export class EventService {
  constructor(private readonly db: Db) {}

  /**
   * Append inside the caller's transaction, so the event commits atomically
   * with whatever it describes. Duplicate ids are ignored — a replayed offline
   * batch does not double-count a funnel step.
   */
  async recordWith(c: pg.PoolClient, tenantId: string, event: ProductEvent): Promise<void> {
    if (!isEventName(event.name)) {
      throw new EventError("UNKNOWN_EVENT", `unknown event name: ${String(event.name)}`);
    }
    if (!event.sessionId && !event.userId && !event.customerId && !event.orderId) {
      throw new EventError(
        "NO_CORRELATION_KEY",
        "an event needs at least one of sessionId, userId, customerId, orderId",
      );
    }
    const occurredAt =
      event.occurredAt instanceof Date ? event.occurredAt.toISOString() : event.occurredAt ?? null;
    await c.query(
      `INSERT INTO product_event
         (id, tenant_id, occurred_at, name, session_id, user_id, customer_id, order_id, props)
       VALUES (coalesce($1::uuid, gen_random_uuid()), $2, coalesce($3::timestamptz, now()),
               $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        event.id ?? null,
        tenantId,
        occurredAt,
        event.name,
        event.sessionId ?? null,
        event.userId ?? null,
        event.customerId ?? null,
        event.orderId ?? null,
        JSON.stringify(event.props ?? {}),
      ],
    );
  }

  /** Standalone write (page/beacon events with nothing to be atomic with). */
  async record(tenantId: string, event: ProductEvent): Promise<void> {
    await this.db.withTenant(tenantId, (c) => this.recordWith(c, tenantId, event));
  }

  /** One transaction for a whole beacon batch: all land or none do. */
  async recordMany(tenantId: string, events: ProductEvent[]): Promise<{ recorded: number }> {
    if (events.length === 0) return { recorded: 0 };
    await this.db.withTenant(tenantId, async (c) => {
      for (const event of events) await this.recordWith(c, tenantId, event);
    });
    return { recorded: events.length };
  }

  /** Event volumes per name over a window — the dashboard's raw counters. */
  async counts(
    tenantId: string,
    window: { fromIso?: string; toIso?: string } = {},
  ): Promise<{ fromIso: string; toIso: string; counts: Record<string, number> }> {
    const { fromIso, toIso } = this.window(window);
    const counts = await this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<{ name: string; count: string }>(
        `SELECT name, count(*) AS count
           FROM product_event
          WHERE occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz
          GROUP BY name`,
        [fromIso, toIso],
      );
      return Object.fromEntries(rows.map((r) => [r.name, Number(r.count)]));
    });
    return { fromIso, toIso, counts };
  }

  /** Run one of R12.2's three named funnels. */
  async presetFunnel(
    tenantId: string,
    preset: FunnelPreset,
    window: { fromIso?: string; toIso?: string } = {},
  ): Promise<FunnelResult> {
    const { key, steps } = FUNNEL_PRESETS[preset];
    return this.funnel(tenantId, { key, steps, ...window });
  }

  /**
   * Ordered funnel: a key counts toward step N only if it produced step N's
   * event *after* the row that satisfied step N-1. Chaining is on `seq`, not
   * time, because events written in one transaction share now() — with a
   * timestamp chain a single row could satisfy two steps at once.
   */
  async funnel(tenantId: string, spec: FunnelSpec): Promise<FunnelResult> {
    const key = spec.key ?? "session_id";
    if (!FUNNEL_KEYS.includes(key)) {
      throw new EventError("BAD_FUNNEL_KEY", `unsupported funnel key: ${String(key)}`);
    }
    if (spec.steps.length < 2 || spec.steps.length > MAX_STEPS) {
      throw new EventError("BAD_FUNNEL", `a funnel needs 2..${MAX_STEPS} steps`);
    }
    for (const step of spec.steps) {
      if (!isEventName(step.event)) {
        throw new EventError("UNKNOWN_EVENT", `unknown event name: ${String(step.event)}`);
      }
    }
    const { fromIso, toIso } = this.window(spec);

    // $1 = from, $2 = to, then (name, props) per step.
    const params: unknown[] = [fromIso, toIso];
    const ctes = spec.steps.map((step, i) => {
      const name = `$${params.length + 1}`;
      const props = `$${params.length + 2}`;
      params.push(step.event, JSON.stringify(step.props ?? {}));
      const predicate = `b.name = ${name} AND b.props @> ${props}::jsonb`;
      return i === 0
        ? `s0 AS (SELECT b.k, min(b.seq) AS s FROM base b WHERE ${predicate} GROUP BY b.k)`
        : `s${i} AS (SELECT b.k, min(b.seq) AS s FROM base b
                       JOIN s${i - 1} p ON p.k = b.k AND b.seq > p.s
                      WHERE ${predicate} GROUP BY b.k)`;
    });
    const sql =
      `WITH base AS (
         SELECT ${key} AS k, seq, name, props
           FROM product_event
          WHERE ${key} IS NOT NULL
            AND occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz
       ), ${ctes.join(", ")}
       SELECT ` +
      spec.steps.map((_, i) => `(SELECT count(*) FROM s${i}) AS c${i}`).join(", ");

    const row = await this.db.withTenant(tenantId, async (c) => {
      const { rows } = await c.query<Record<string, string>>(sql, params);
      return rows[0] ?? {};
    });
    const at = (i: number): number => Number(row[`c${i}`] ?? 0);

    const first = at(0);
    const steps: FunnelStepResult[] = spec.steps.map((step, i) => {
      const count = at(i);
      const previous = i === 0 ? null : at(i - 1);
      return {
        step: i,
        label: step.label ?? step.event,
        event: step.event,
        count,
        conversionFromPrevious: previous === null ? null : this.ratio(count, previous),
        conversionFromStart: i === 0 ? null : this.ratio(count, first),
      };
    });
    return { key, fromIso, toIso, steps };
  }

  private ratio(numerator: number, denominator: number): number {
    return denominator === 0 ? 0 : numerator / denominator;
  }

  private window(w: { fromIso?: string; toIso?: string }): { fromIso: string; toIso: string } {
    const toIso = w.toIso ?? new Date().toISOString();
    const fromIso =
      w.fromIso ??
      new Date(Date.parse(toIso) - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    if (Date.parse(fromIso) > Date.parse(toIso)) {
      throw new EventError("BAD_WINDOW", "from must not be after to");
    }
    return { fromIso, toIso };
  }
}
