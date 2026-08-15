/**
 * Pure guards and funnel-spec validation — no database. The SQL behaviour
 * (RLS, append-only, funnel counts) lives in eventService.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { Db } from "../db.js";
import {
  EVENT_NAMES,
  EventError,
  EventService,
  FUNNEL_PRESETS,
  R12_1_EVENTS,
  isEventName,
  isFunnelPreset,
} from "./eventService.js";

// Every path exercised here rejects before touching the pool.
const service = new EventService({} as Db);
const tenantId = "00000000-0000-0000-0000-000000000001";

describe("event names", () => {
  it("covers the nine events R12.1 requires", () => {
    expect(R12_1_EVENTS).toEqual([
      "product_viewed", "add_to_cart", "checkout_started", "checkout_failed",
      "order_placed", "search_performed", "cod_refused", "pos_sale", "admin_action",
    ]);
    for (const name of R12_1_EVENTS) expect(EVENT_NAMES).toContain(name);
  });

  it("recognises known names and rejects typos", () => {
    expect(isEventName("add_to_cart")).toBe(true);
    expect(isEventName("add_to_carts")).toBe(false);
    expect(isEventName(42)).toBe(false);
  });
});

describe("funnel presets", () => {
  it("defines R12.2's three funnels from known event names", () => {
    expect(Object.keys(FUNNEL_PRESETS).sort()).toEqual(["browse", "post_order", "search"]);
    for (const preset of Object.values(FUNNEL_PRESETS)) {
      expect(preset.steps.length).toBeGreaterThanOrEqual(2);
      for (const step of preset.steps) expect(isEventName(step.event)).toBe(true);
    }
  });

  it("correlates the post-order funnel by order, not session", () => {
    expect(FUNNEL_PRESETS.post_order.key).toBe("order_id");
    expect(FUNNEL_PRESETS.browse.key).toBe("session_id");
  });

  it("recognises preset names", () => {
    expect(isFunnelPreset("browse")).toBe(true);
    expect(isFunnelPreset("checkout")).toBe(false);
  });
});

describe("write validation", () => {
  it("refuses an event with no correlation key", async () => {
    await expect(
      service.recordWith({} as never, tenantId, { name: "product_viewed" }),
    ).rejects.toMatchObject({ code: "NO_CORRELATION_KEY" });
  });

  it("refuses an unknown event name arriving from untyped input", async () => {
    await expect(
      service.recordWith({} as never, tenantId, {
        name: "product_view" as never,
        sessionId: "s1",
      }),
    ).rejects.toBeInstanceOf(EventError);
  });
});

describe("funnel validation", () => {
  const steps = [{ event: "add_to_cart" as const }, { event: "order_placed" as const }];

  it("requires at least two steps", async () => {
    await expect(
      service.funnel(tenantId, { steps: [{ event: "add_to_cart" }] }),
    ).rejects.toMatchObject({ code: "BAD_FUNNEL" });
  });

  it("caps the step count so the generated SQL stays bounded", async () => {
    await expect(
      service.funnel(tenantId, { steps: Array(9).fill({ event: "add_to_cart" }) }),
    ).rejects.toMatchObject({ code: "BAD_FUNNEL" });
  });

  it("rejects a correlation key that is not a whitelisted column", async () => {
    await expect(
      service.funnel(tenantId, { steps, key: "props->>'x'" as never }),
    ).rejects.toMatchObject({ code: "BAD_FUNNEL_KEY" });
  });

  it("rejects an inverted window", async () => {
    await expect(
      service.funnel(tenantId, {
        steps,
        fromIso: "2026-08-13T00:00:00.000Z",
        toIso: "2026-08-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "BAD_WINDOW" });
  });
});
