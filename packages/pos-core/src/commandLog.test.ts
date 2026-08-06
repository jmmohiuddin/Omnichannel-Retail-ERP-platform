import { describe, expect, it } from "vitest";
import { LedgerError, type PostedMovement } from "@omniretail/domain";
import {
  CommandLog,
  LocalInventoryMirror,
  commandToMovements,
  type PosCommandInput,
  type SaleLine,
} from "./commandLog.js";
import { InMemoryCommandStore } from "./stores/memory.js";

const STORE_LOC = "loc-store";
const VARIANT = "variant-charger";
const PHONE_VARIANT = "variant-phone";
const CASHIER = "user-cashier";
const DEVICE = "pos-1";
const IMEI = "490154203237518"; // valid Luhn
const AT = new Date("2026-08-06T10:00:00Z");

let uuidCounter = 0;
const uuid = () => `cmd-${++uuidCounter}`;

let seqCounter = 0;
function receipt(qty: number, variantId = VARIANT, stockUnitId?: string): PostedMovement {
  const seq = ++seqCounter;
  const m: PostedMovement = {
    id: `srv-receipt-${seq}`,
    movementType: "receipt",
    variantId,
    quantity: qty,
    to: { locationId: STORE_LOC, state: "on_hand" },
    actorUserId: "user-warehouse",
    reference: { type: "grn", id: `grn-${seq}` },
    occurredAt: AT,
    seq,
  };
  if (stockUnitId !== undefined) m.stockUnitId = stockUnitId;
  return m;
}

function hydratedMirror(...movements: PostedMovement[]): LocalInventoryMirror {
  const mirror = new LocalInventoryMirror();
  mirror.applyServerMovements(movements);
  mirror.rebuild();
  return mirror;
}

function sale(lines: SaleLine[], id = uuid()): PosCommandInput {
  return {
    type: "sale",
    id,
    deviceId: DEVICE,
    createdAt: AT,
    locationId: STORE_LOC,
    cashierUserId: CASHIER,
    lines,
    paymentMethod: "cash",
    currencyCode: "BDT",
  };
}

describe("CommandLog offline sales", () => {
  it("queues a valid sale and decrements the local mirror", async () => {
    const mirror = hydratedMirror(receipt(5));
    const store = new InMemoryCommandStore();
    const log = new CommandLog(store, mirror);

    const command = await log.append(sale([{ variantId: VARIANT, qty: 2, unitPriceMinor: 1500_00 }]));

    expect(command.seq).toBe(1);
    expect(await store.listPending()).toEqual([command]);
    expect(mirror.availability(VARIANT, STORE_LOC).available).toBe(3);
  });

  it("rejects an offline oversell locally, before queueing", async () => {
    const mirror = hydratedMirror(receipt(2));
    const store = new InMemoryCommandStore();
    const log = new CommandLog(store, mirror);

    await expect(
      log.append(sale([{ variantId: VARIANT, qty: 3, unitPriceMinor: 1500_00 }])),
    ).rejects.toMatchObject({ name: "LedgerError", code: "INSUFFICIENT_STOCK" });

    expect(await store.listPending()).toEqual([]);
    expect(mirror.availability(VARIANT, STORE_LOC).available).toBe(2);
  });

  it("checks sufficiency across all lines of one sale atomically", async () => {
    const mirror = hydratedMirror(receipt(3));
    const store = new InMemoryCommandStore();
    const log = new CommandLog(store, mirror);

    await expect(
      log.append(
        sale([
          { variantId: VARIANT, qty: 2, unitPriceMinor: 1500_00 },
          { variantId: VARIANT, qty: 2, unitPriceMinor: 1500_00 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(mirror.availability(VARIANT, STORE_LOC).available).toBe(3);
    expect(await store.listPending()).toEqual([]);
  });

  it("a second offline sale sees the first one's decrement", async () => {
    const mirror = hydratedMirror(receipt(3));
    const log = new CommandLog(new InMemoryCommandStore(), mirror);

    await log.append(sale([{ variantId: VARIANT, qty: 2, unitPriceMinor: 1500_00 }]));
    await expect(
      log.append(sale([{ variantId: VARIANT, qty: 2, unitPriceMinor: 1500_00 }])),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
  });

  it("assigns monotonically increasing local seq via the store", async () => {
    const mirror = hydratedMirror(receipt(10));
    const store = new InMemoryCommandStore();
    const log = new CommandLog(store, mirror);

    const a = await log.append(sale([{ variantId: VARIANT, qty: 1, unitPriceMinor: 100 }]));
    const b = await log.append(sale([{ variantId: VARIANT, qty: 1, unitPriceMinor: 100 }]));
    expect([a.seq, b.seq]).toEqual([1, 2]);
  });

  it("rejects a duplicate command id", async () => {
    const mirror = hydratedMirror(receipt(10));
    const log = new CommandLog(new InMemoryCommandStore(), mirror);

    await log.append(sale([{ variantId: VARIANT, qty: 1, unitPriceMinor: 100 }], "cmd-dup"));
    await expect(
      log.append(sale([{ variantId: VARIANT, qty: 1, unitPriceMinor: 100 }], "cmd-dup")),
    ).rejects.toMatchObject({ code: "DUPLICATE_MOVEMENT" });
  });

  it("queues cash session commands without touching the mirror", async () => {
    const mirror = hydratedMirror(receipt(5));
    const store = new InMemoryCommandStore();
    const log = new CommandLog(store, mirror);

    await log.append({
      type: "cash_session_open",
      id: uuid(),
      deviceId: DEVICE,
      createdAt: AT,
      locationId: STORE_LOC,
      cashierUserId: CASHIER,
      openingFloatMinor: 5000_00,
      currencyCode: "BDT",
    });
    await log.append({
      type: "cash_session_close",
      id: uuid(),
      deviceId: DEVICE,
      createdAt: AT,
      locationId: STORE_LOC,
      cashierUserId: CASHIER,
      countedCashMinor: 7500_00,
      currencyCode: "BDT",
    });

    expect((await store.listPending()).map((c) => c.type)).toEqual([
      "cash_session_open",
      "cash_session_close",
    ]);
    expect(mirror.availability(VARIANT, STORE_LOC).available).toBe(5);
  });

  it("queues a return as a return_in movement into returned_pending", async () => {
    const mirror = hydratedMirror(); // returns need no prior local stock
    const store = new InMemoryCommandStore();
    const log = new CommandLog(store, mirror);

    const command = await log.append({
      type: "return",
      id: uuid(),
      deviceId: DEVICE,
      createdAt: AT,
      locationId: STORE_LOC,
      cashierUserId: CASHIER,
      lines: [{ variantId: VARIANT, qty: 1, unitPriceMinor: 1500_00 }],
      paymentMethod: "cash",
      currencyCode: "BDT",
    });

    expect(mirror.level(VARIANT, STORE_LOC, "returned_pending")).toBe(1);
    const movements = commandToMovements(command);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      movementType: "return_in",
      to: { locationId: STORE_LOC, state: "returned_pending" },
    });
  });
});

describe("CommandLog serialized sales", () => {
  function phoneMirror(): LocalInventoryMirror {
    const mirror = hydratedMirror(receipt(1, PHONE_VARIANT, "unit-1"));
    mirror.registerUnit({
      id: "unit-1",
      variantId: PHONE_VARIANT,
      imei1: IMEI,
      state: "in_stock",
      locationId: STORE_LOC,
    });
    return mirror;
  }

  it("sells a known in-stock unit and marks it sold locally", async () => {
    const mirror = phoneMirror();
    const log = new CommandLog(new InMemoryCommandStore(), mirror);

    await log.append(
      sale([{ variantId: PHONE_VARIANT, qty: 1, unitPriceMinor: 99_999_00, stockUnitId: "unit-1" }]),
    );

    expect(mirror.unit("unit-1")?.state).toBe("sold");
    expect(mirror.availability(PHONE_VARIANT, STORE_LOC).available).toBe(0);
  });

  it("resolves an IMEI-only line to its stockUnitId before queueing", async () => {
    const mirror = phoneMirror();
    const store = new InMemoryCommandStore();
    const log = new CommandLog(store, mirror);

    const command = await log.append(
      sale([{ variantId: PHONE_VARIANT, qty: 1, unitPriceMinor: 99_999_00, imei: IMEI }]),
    );

    expect(command.type).toBe("sale");
    if (command.type === "sale") {
      expect(command.lines[0]?.stockUnitId).toBe("unit-1");
    }
  });

  it("rejects an unknown stock unit / IMEI", async () => {
    const mirror = phoneMirror();
    const log = new CommandLog(new InMemoryCommandStore(), mirror);

    await expect(
      log.append(
        sale([{ variantId: PHONE_VARIANT, qty: 1, unitPriceMinor: 1, stockUnitId: "unit-ghost" }]),
      ),
    ).rejects.toMatchObject({ code: "SERIALIZED_RULE" });
    await expect(
      log.append(
        sale([{ variantId: PHONE_VARIANT, qty: 1, unitPriceMinor: 1, imei: "356938035643809" }]),
      ),
    ).rejects.toMatchObject({ code: "SERIALIZED_RULE" });
  });

  it("rejects selling a unit that is not sellable (already sold offline)", async () => {
    const mirror = phoneMirror();
    const log = new CommandLog(new InMemoryCommandStore(), mirror);

    await log.append(
      sale([{ variantId: PHONE_VARIANT, qty: 1, unitPriceMinor: 1, stockUnitId: "unit-1" }]),
    );
    await expect(
      log.append(
        sale([{ variantId: PHONE_VARIANT, qty: 1, unitPriceMinor: 1, stockUnitId: "unit-1" }]),
      ),
    ).rejects.toMatchObject({ code: "SERIALIZED_RULE" });
  });

  it("rejects serialized lines with qty other than 1", async () => {
    const mirror = phoneMirror();
    const log = new CommandLog(new InMemoryCommandStore(), mirror);

    await expect(
      log.append(
        sale([{ variantId: PHONE_VARIANT, qty: 2, unitPriceMinor: 1, stockUnitId: "unit-1" }]),
      ),
    ).rejects.toMatchObject({ code: "SERIALIZED_RULE" });
  });
});

describe("commandToMovements", () => {
  it("derives deterministic movement ids from the command id", () => {
    const command = {
      ...sale([
        { variantId: VARIANT, qty: 1, unitPriceMinor: 100 },
        { variantId: PHONE_VARIANT, qty: 1, unitPriceMinor: 200, stockUnitId: "unit-1" },
      ]),
      seq: 1,
    };
    const movements = commandToMovements(command);
    expect(movements.map((m) => m.id)).toEqual([`${command.id}:0`, `${command.id}:1`]);
    expect(movements[1]?.stockUnitId).toBe("unit-1");
    expect(movements.every((m) => m.movementType === "sale")).toBe(true);
  });

  it("produces no movements for cash session commands", () => {
    expect(
      commandToMovements({
        type: "cash_session_open",
        id: "c1",
        deviceId: DEVICE,
        createdAt: AT,
        locationId: STORE_LOC,
        cashierUserId: CASHIER,
        openingFloatMinor: 0,
        currencyCode: "BDT",
        seq: 1,
      }),
    ).toEqual([]);
  });
});

describe("LocalInventoryMirror", () => {
  it("rebuild is idempotent — replaying identical history yields identical levels", () => {
    const mirror = hydratedMirror(receipt(4));
    mirror.rebuild();
    mirror.rebuild();
    expect(mirror.availability(VARIANT, STORE_LOC).available).toBe(4);
  });

  it("registerUnit rejects a duplicate IMEI", () => {
    const mirror = new LocalInventoryMirror();
    mirror.registerUnit({ id: "u1", variantId: PHONE_VARIANT, imei1: IMEI, state: "in_stock" });
    expect(() =>
      mirror.registerUnit({ id: "u2", variantId: PHONE_VARIANT, imei1: IMEI, state: "in_stock" }),
    ).toThrow(LedgerError);
  });
});
