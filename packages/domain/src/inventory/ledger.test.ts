import { describe, expect, it } from "vitest";
import { InventoryLedger } from "./ledger.js";
import { LedgerError, type MovementInput } from "./types.js";

const VARIANT = "variant-1";
const STORE = "loc-store";
const WAREHOUSE = "loc-warehouse";
const ACTOR = "user-1";

let counter = 0;
function movement(partial: Partial<MovementInput> & Pick<MovementInput, "movementType">): MovementInput {
  return {
    id: `mv-${++counter}`,
    variantId: VARIANT,
    quantity: 1,
    actorUserId: ACTOR,
    reference: { type: "test", id: "ref-1" },
    occurredAt: new Date("2026-08-06T10:00:00Z"),
    ...partial,
  };
}

function receipt(qty: number, locationId = STORE): MovementInput {
  return movement({
    movementType: "receipt",
    quantity: qty,
    to: { locationId, state: "on_hand" },
  });
}

describe("InventoryLedger posting", () => {
  it("receipt increases on-hand", () => {
    const ledger = new InventoryLedger();
    ledger.post(receipt(10));
    expect(ledger.availability(VARIANT, STORE)).toMatchObject({
      onHand: 10,
      available: 10,
      reserved: 0,
    });
  });

  it("sale decreases on-hand and is rejected when stock is insufficient", () => {
    const ledger = new InventoryLedger();
    ledger.post(receipt(2));
    ledger.post(
      movement({
        movementType: "sale",
        quantity: 2,
        from: { locationId: STORE, state: "on_hand" },
      }),
    );
    expect(ledger.level(VARIANT, STORE, "on_hand")).toBe(0);

    expect(() =>
      ledger.post(
        movement({
          movementType: "sale",
          from: { locationId: STORE, state: "on_hand" },
        }),
      ),
    ).toThrowError(/insufficient/i);
  });

  it("never mutates state when a movement is rejected", () => {
    const ledger = new InventoryLedger();
    ledger.post(receipt(5));
    const before = ledger.availability(VARIANT, STORE);
    expect(() =>
      ledger.post(
        movement({
          movementType: "sale",
          quantity: 6,
          from: { locationId: STORE, state: "on_hand" },
        }),
      ),
    ).toThrow(LedgerError);
    expect(ledger.availability(VARIANT, STORE)).toEqual(before);
    expect(ledger.history).toHaveLength(1);
  });

  it("reservation moves stock out of available; release returns it", () => {
    const ledger = new InventoryLedger();
    ledger.post(receipt(10));
    ledger.post(
      movement({
        movementType: "reservation",
        quantity: 3,
        from: { locationId: STORE, state: "on_hand" },
        to: { locationId: STORE, state: "reserved" },
      }),
    );
    expect(ledger.availability(VARIANT, STORE)).toMatchObject({
      onHand: 7,
      reserved: 3,
      available: 7,
    });

    ledger.post(
      movement({
        movementType: "release",
        quantity: 3,
        from: { locationId: STORE, state: "reserved" },
        to: { locationId: STORE, state: "on_hand" },
      }),
    );
    expect(ledger.availability(VARIANT, STORE)).toMatchObject({ onHand: 10, reserved: 0 });
  });

  it("transfer moves stock through in_transit at the destination", () => {
    const ledger = new InventoryLedger();
    ledger.post(receipt(4, WAREHOUSE));
    ledger.post(
      movement({
        movementType: "transfer_out",
        quantity: 4,
        from: { locationId: WAREHOUSE, state: "on_hand" },
        to: { locationId: STORE, state: "in_transit" },
      }),
    );
    expect(ledger.level(VARIANT, WAREHOUSE, "on_hand")).toBe(0);
    expect(ledger.level(VARIANT, STORE, "in_transit")).toBe(4);

    ledger.post(
      movement({
        movementType: "transfer_in",
        quantity: 4,
        from: { locationId: STORE, state: "in_transit" },
        to: { locationId: STORE, state: "on_hand" },
      }),
    );
    expect(ledger.level(VARIANT, STORE, "on_hand")).toBe(4);
    expect(ledger.level(VARIANT, STORE, "in_transit")).toBe(0);
  });

  it("rejects a transfer_out within a single location", () => {
    const ledger = new InventoryLedger();
    ledger.post(receipt(1));
    expect(() =>
      ledger.post(
        movement({
          movementType: "transfer_out",
          from: { locationId: STORE, state: "on_hand" },
          to: { locationId: STORE, state: "in_transit" },
        }),
      ),
    ).toThrowError(/different locations/);
  });
});

describe("approval-gated movements (fraud controls)", () => {
  it("rejects adjustments and write-offs without a manager approval", () => {
    const ledger = new InventoryLedger();
    ledger.post(receipt(5));
    for (const movementType of ["adjustment", "write_off"] as const) {
      expect(() =>
        ledger.post(
          movement({
            movementType,
            from: { locationId: STORE, state: "on_hand" },
          }),
        ),
      ).toThrowError(/approval/i);
    }
  });

  it("accepts an approved adjustment", () => {
    const ledger = new InventoryLedger();
    ledger.post(receipt(5));
    ledger.post(
      movement({
        movementType: "adjustment",
        quantity: 2,
        from: { locationId: STORE, state: "on_hand" },
        approvalId: "approval-9",
      }),
    );
    expect(ledger.level(VARIANT, STORE, "on_hand")).toBe(3);
  });
});

describe("idempotency and replay", () => {
  it("rejects duplicate movement ids (offline replay safety)", () => {
    const ledger = new InventoryLedger();
    const r = receipt(1);
    ledger.post(r);
    expect(() => ledger.post(r)).toThrowError(/already posted/);
    expect(ledger.level(VARIANT, STORE, "on_hand")).toBe(1);
  });

  it("replaying history reproduces identical levels (drift check)", () => {
    const ledger = new InventoryLedger();
    ledger.post(receipt(10));
    ledger.post(
      movement({
        movementType: "reservation",
        quantity: 2,
        from: { locationId: STORE, state: "on_hand" },
        to: { locationId: STORE, state: "reserved" },
      }),
    );
    ledger.post(
      movement({
        movementType: "sale",
        quantity: 2,
        from: { locationId: STORE, state: "reserved" },
      }),
    );

    const replayed = InventoryLedger.replay(ledger.history);
    for (const state of ["on_hand", "reserved", "in_transit"] as const) {
      expect(replayed.level(VARIANT, STORE, state)).toBe(ledger.level(VARIANT, STORE, state));
    }
  });

  it("handles fractional quantities without float drift", () => {
    const ledger = new InventoryLedger();
    ledger.post(receipt(1));
    for (let i = 0; i < 10; i++) {
      ledger.post(
        movement({
          movementType: "sale",
          quantity: 0.1,
          from: { locationId: STORE, state: "on_hand" },
        }),
      );
    }
    expect(ledger.level(VARIANT, STORE, "on_hand")).toBe(0);
  });
});
