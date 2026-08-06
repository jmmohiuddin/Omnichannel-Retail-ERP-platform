import { describe, expect, it } from "vitest";
import type { MovementDto } from "./api.js";
import {
  bucketLabel,
  flowLabel,
  formatDubaiTime,
  formatQuantity,
  formatReference,
  humanState,
  movementTone,
  movementTypeLabel,
  presentMovement,
  shortId,
} from "./movements.js";

const LOC_STORE = "11111111-aaaa-bbbb-cccc-000000000001";
const LOC_WH = "22222222-aaaa-bbbb-cccc-000000000002";

const locationName = (id: string) =>
  id === LOC_STORE ? "Deira Store" : id === LOC_WH ? "Main Warehouse" : undefined;

function movement(overrides: Partial<MovementDto>): MovementDto {
  return {
    id: "33333333-aaaa-bbbb-cccc-000000000003",
    seq: 42,
    occurredAt: "2026-08-06T08:30:00.000Z",
    movementType: "receipt",
    variantId: "44444444-aaaa-bbbb-cccc-000000000004",
    quantity: 5,
    actorUserId: "55555555-aaaa-bbbb-cccc-000000000005",
    reference: { type: "po", id: "66666666-aaaa-bbbb-cccc-000000000006" },
    ...overrides,
  };
}

describe("bucket → human string", () => {
  it("labels a bucket with location name and humanized state", () => {
    expect(bucketLabel({ locationId: LOC_STORE, state: "on_hand" }, locationName)).toBe(
      "Deira Store · On hand",
    );
  });

  it("labels a missing bucket as External (boundary crossing)", () => {
    expect(bucketLabel(undefined, locationName)).toBe("External");
    expect(bucketLabel(null, locationName)).toBe("External");
  });

  it("falls back to a short id for unknown locations", () => {
    expect(bucketLabel({ locationId: "99999999-dead-beef-0000-000000000000", state: "damaged" }, locationName)).toBe(
      "99999999 · Damaged",
    );
  });

  it("builds a receipt flow: External → location", () => {
    const m = movement({ to: { locationId: LOC_WH, state: "on_hand" } });
    expect(flowLabel(m, locationName)).toBe("External → Main Warehouse · On hand");
  });

  it("builds a transfer flow between two buckets", () => {
    const m = movement({
      movementType: "transfer_out",
      from: { locationId: LOC_WH, state: "on_hand" },
      to: { locationId: LOC_STORE, state: "in_transit" },
    });
    expect(flowLabel(m, locationName)).toBe("Main Warehouse · On hand → Deira Store · In transit");
  });
});

describe("labels, tones, helpers", () => {
  it("humanizes snake_case states", () => {
    expect(humanState("returned_pending")).toBe("Returned pending");
    expect(humanState("on_hand")).toBe("On hand");
  });

  it("labels movement types", () => {
    expect(movementTypeLabel("count_correction")).toBe("Count correction");
  });

  it("assigns badge tones by direction", () => {
    expect(movementTone("receipt")).toBe("in");
    expect(movementTone("return_in")).toBe("in");
    expect(movementTone("sale")).toBe("out");
    expect(movementTone("write_off")).toBe("out");
    expect(movementTone("adjustment")).toBe("neutral");
    expect(movementTone("count_correction")).toBe("neutral");
  });

  it("shortens uuids and formats references", () => {
    expect(shortId("55555555-aaaa-bbbb-cccc-000000000005")).toBe("55555555");
    expect(formatReference({ type: "sale", id: "66666666-aaaa-bbbb-cccc-000000000006" })).toBe(
      "sale:66666666",
    );
    expect(formatReference(null)).toBe("—");
    expect(formatReference("PO-1042")).toBe("PO-1042");
  });

  it("formats NUMERIC quantities, trimming trailing zeros", () => {
    expect(formatQuantity("5.000")).toBe("5");
    expect(formatQuantity("2.500")).toBe("2.5");
    expect(formatQuantity(3)).toBe("3");
  });

  it("formats timestamps in Asia/Dubai (GMT+4)", () => {
    const out = formatDubaiTime("2026-08-06T08:30:00.000Z");
    expect(out).toContain("12:30"); // 08:30 UTC == 12:30 in Dubai
    expect(out).toContain("2026");
  });
});

describe("presentMovement", () => {
  it("maps a full ledger row to presentation fields", () => {
    const m = movement({
      movementType: "sale",
      quantity: "1.000",
      from: { locationId: LOC_STORE, state: "on_hand" },
      note: "walk-in",
    });
    const row = presentMovement(m, {
      locationName,
      sku: () => "IPH15-128-BLK",
    });
    expect(row.seq).toBe(42);
    expect(row.typeLabel).toBe("Sale");
    expect(row.tone).toBe("out");
    expect(row.sku).toBe("IPH15-128-BLK");
    expect(row.quantity).toBe("1");
    expect(row.flow).toBe("Deira Store · On hand → External");
    expect(row.actor).toBe("55555555");
    expect(row.reference).toBe("po:66666666");
    expect(row.note).toBe("walk-in");
    expect(row.time).toContain("12:30");
  });

  it("falls back to a short variant id when the sku is unknown", () => {
    const row = presentMovement(movement({}), { locationName });
    expect(row.sku).toBe("44444444");
    expect(row.note).toBe("");
  });
});
