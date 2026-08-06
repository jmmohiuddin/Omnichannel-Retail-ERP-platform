import { describe, expect, it } from "vitest";
import { InventoryLedger, LedgerError } from "@omniretail/domain";
import {
  CommandLog,
  LocalInventoryMirror,
  commandToMovements,
  type PosCommand,
  type SaleLine,
} from "./commandLog.js";
import {
  SyncEngine,
  type PullPage,
  type PushResult,
  type SyncTransport,
} from "./syncEngine.js";
import {
  InMemoryCommandStore,
  InMemoryConflictSink,
  InMemoryCursorStore,
} from "./stores/memory.js";

const STORE_LOC = "loc-store";
const VARIANT = "variant-charger";
const CASHIER = "user-cashier";
const DEVICE = "pos-1";
const AT = new Date("2026-08-06T10:00:00Z");

let uuidCounter = 0;
const uuid = () => `cmd-${++uuidCounter}`;
let refCounter = 0;

/**
 * Fake server: the authoritative InventoryLedger plus command-id dedupe —
 * the same semantics the API exposes over POST/GET /v1/inventory/movements.
 */
class FakeServer implements SyncTransport {
  readonly ledger = new InventoryLedger();
  private readonly commandResults = new Map<string, PushResult>();
  readonly pullCalls: number[] = [];

  seedReceipt(qty: number, variantId = VARIANT): void {
    this.ledger.post({
      id: `srv-receipt-${++refCounter}`,
      movementType: "receipt",
      variantId,
      quantity: qty,
      to: { locationId: STORE_LOC, state: "on_hand" },
      actorUserId: "user-warehouse",
      reference: { type: "grn", id: `grn-${refCounter}` },
      occurredAt: AT,
    });
  }

  /** Another register selling directly against the server (the conflict). */
  sellDirect(qty: number, variantId = VARIANT): void {
    this.ledger.post({
      id: `srv-sale-${++refCounter}`,
      movementType: "sale",
      variantId,
      quantity: qty,
      from: { locationId: STORE_LOC, state: "on_hand" },
      actorUserId: "user-other-cashier",
      deviceId: "pos-2",
      reference: { type: "pos_command", id: `other-${refCounter}` },
      occurredAt: AT,
    });
  }

  async pushCommands(commands: readonly PosCommand[]): Promise<PushResult[]> {
    return commands.map((command) => {
      const prior = this.commandResults.get(command.id);
      if (prior) {
        // Server dedupes on command id: an already-applied command is a
        // duplicate (success); an already-rejected one stays rejected.
        return prior.status === "applied"
          ? { commandId: command.id, status: "duplicate" as const }
          : prior;
      }
      let result: PushResult;
      try {
        for (const movement of commandToMovements(command)) this.ledger.post(movement);
        result = { commandId: command.id, status: "applied" };
      } catch (err) {
        const reason =
          err instanceof LedgerError ? `${err.code}: ${err.message}` : String(err);
        result = { commandId: command.id, status: "rejected", reason };
      }
      this.commandResults.set(command.id, result);
      return result;
    });
  }

  async pullMovements(afterSeq: number, limit: number): Promise<PullPage> {
    this.pullCalls.push(afterSeq);
    const items = this.ledger.history.filter((m) => m.seq > afterSeq).slice(0, limit);
    return { items: [...items], nextCursor: items.at(-1)?.seq ?? afterSeq };
  }
}

function makePos(server: FakeServer, opts: { pullLimit?: number } = {}) {
  const mirror = new LocalInventoryMirror();
  const commands = new InMemoryCommandStore();
  const cursor = new InMemoryCursorStore();
  const conflicts = new InMemoryConflictSink();
  const log = new CommandLog(commands, mirror);
  const engine = new SyncEngine(
    { commands, mirror, transport: server, cursor, conflicts },
    { pullLimit: opts.pullLimit ?? 100, now: () => AT },
  );
  return { mirror, commands, cursor, conflicts, log, engine };
}

function saleInput(lines: SaleLine[], id = uuid()) {
  return {
    type: "sale" as const,
    id,
    deviceId: DEVICE,
    createdAt: AT,
    locationId: STORE_LOC,
    cashierUserId: CASHIER,
    lines,
    paymentMethod: "cash" as const,
    currencyCode: "BDT",
  };
}

describe("SyncEngine", () => {
  it("hydrates the local mirror from the server feed and advances the cursor", async () => {
    const server = new FakeServer();
    server.seedReceipt(7);
    const pos = makePos(server);

    const report = await pos.engine.sync();

    expect(report).toMatchObject({ pushed: 0, pulled: 1, cursor: 1 });
    expect(await pos.cursor.get()).toBe(1);
    expect(pos.mirror.availability(VARIANT, STORE_LOC).available).toBe(7);
  });

  it("pushes an offline sale, marks it synced, and converges with the server", async () => {
    const server = new FakeServer();
    server.seedReceipt(5);
    const pos = makePos(server);
    await pos.engine.sync();

    await pos.log.append(saleInput([{ variantId: VARIANT, qty: 2, unitPriceMinor: 100 }]));
    expect(pos.mirror.availability(VARIANT, STORE_LOC).available).toBe(3);

    const report = await pos.engine.sync();

    expect(report).toMatchObject({ pushed: 1, applied: 1, duplicates: 0, rejected: 0 });
    expect(await pos.commands.listPending()).toEqual([]);
    expect(server.ledger.availability(VARIANT, STORE_LOC).available).toBe(3);
    // Mirror now derives the sale from authoritative history, not the overlay.
    expect(pos.mirror.availability(VARIANT, STORE_LOC).available).toBe(3);
  });

  it("replay is idempotent: pushing the same command twice never double-applies", async () => {
    const server = new FakeServer();
    server.seedReceipt(5);
    const pos = makePos(server);
    await pos.engine.sync();

    await pos.log.append(saleInput([{ variantId: VARIANT, qty: 2, unitPriceMinor: 100 }]));

    // First push lands on the server but the ack is "lost" before the POS
    // can mark the command synced (crash / dropped connection).
    await server.pushCommands(await pos.commands.listPending());
    expect(server.ledger.availability(VARIANT, STORE_LOC).available).toBe(3);

    // Next sync replays the still-pending command: duplicate == success.
    const report = await pos.engine.sync();
    expect(report).toMatchObject({ pushed: 1, applied: 0, duplicates: 1, rejected: 0 });
    expect(await pos.commands.listPending()).toEqual([]);
    expect(server.ledger.availability(VARIANT, STORE_LOC).available).toBe(3);
    expect(server.ledger.history.filter((m) => m.movementType === "sale")).toHaveLength(1);
    expect(pos.mirror.availability(VARIANT, STORE_LOC).available).toBe(3);

    // And a third sync is a no-op.
    const again = await pos.engine.sync();
    expect(again).toMatchObject({ pushed: 0, pulled: 0 });
    expect(server.ledger.availability(VARIANT, STORE_LOC).available).toBe(3);
  });

  it("routes a server rejection to the ConflictSink and corrects the mirror on pull", async () => {
    const server = new FakeServer();
    server.seedReceipt(1); // one unit left, two registers
    const pos = makePos(server);
    await pos.engine.sync();

    // This register goes offline and sells the last unit...
    const command = await pos.log.append(
      saleInput([{ variantId: VARIANT, qty: 1, unitPriceMinor: 100 }]),
    );
    expect(pos.mirror.availability(VARIANT, STORE_LOC).available).toBe(0);

    // ...but another register already sold it online. First replay wins.
    server.sellDirect(1);

    const report = await pos.engine.sync();

    expect(report).toMatchObject({ pushed: 1, rejected: 1, applied: 0 });
    // Never dropped silently: recorded for manager resolution.
    expect(pos.conflicts.conflicts).toHaveLength(1);
    expect(pos.conflicts.conflicts[0]?.command.id).toBe(command.id);
    expect(pos.conflicts.conflicts[0]?.reason).toContain("INSUFFICIENT_STOCK");
    // Marked rejected locally, not pending forever.
    expect(await pos.commands.listPending()).toEqual([]);
    expect(pos.commands.snapshot().find((e) => e.command.id === command.id)).toMatchObject({
      status: "rejected",
    });
    // The pull delivered the other register's sale; the mirror re-derived
    // its levels from server truth (0, not -1 and not 1).
    expect(pos.mirror.availability(VARIANT, STORE_LOC).available).toBe(0);
    expect(server.ledger.availability(VARIANT, STORE_LOC).available).toBe(0);
  });

  it("second sync pulls only movements after the persisted cursor", async () => {
    const server = new FakeServer();
    server.seedReceipt(2);
    const pos = makePos(server);

    const first = await pos.engine.sync();
    expect(first.pulled).toBe(1);
    const cursorAfterFirst = await pos.cursor.get();

    server.seedReceipt(3);
    const second = await pos.engine.sync();

    expect(second.pulled).toBe(1); // only the new receipt, not the old one
    expect(server.pullCalls.at(-1)).toBe(cursorAfterFirst);
    expect(await pos.cursor.get()).toBe(cursorAfterFirst + 1);
    expect(pos.mirror.availability(VARIANT, STORE_LOC).available).toBe(5);
  });

  it("pages through the feed when the backlog exceeds pullLimit", async () => {
    const server = new FakeServer();
    for (let i = 0; i < 5; i++) server.seedReceipt(1);
    const pos = makePos(server, { pullLimit: 2 });

    const report = await pos.engine.sync();

    expect(report.pulled).toBe(5);
    expect(server.pullCalls).toEqual([0, 2, 4]);
    expect(pos.mirror.availability(VARIANT, STORE_LOC).available).toBe(5);
  });

  it("pulling the same movements again never double-applies them to the mirror", async () => {
    const server = new FakeServer();
    server.seedReceipt(4);
    const pos = makePos(server);
    await pos.engine.sync();

    // Simulate a cursor rollback (e.g. restored from an old backup).
    await pos.cursor.set(0);
    const report = await pos.engine.sync();

    expect(report.pulled).toBe(1); // re-sent by the server...
    expect(pos.mirror.availability(VARIANT, STORE_LOC).available).toBe(4); // ...applied once
  });

  it("a partially-failing batch leaves unacked commands pending for the next sync", async () => {
    const server = new FakeServer();
    server.seedReceipt(10);
    const pos = makePos(server);
    await pos.engine.sync();

    const a = await pos.log.append(saleInput([{ variantId: VARIANT, qty: 1, unitPriceMinor: 100 }]));
    const b = await pos.log.append(saleInput([{ variantId: VARIANT, qty: 2, unitPriceMinor: 100 }]));

    // Transport that only acks the first command of the batch (cut connection).
    const flaky: SyncTransport = {
      pushCommands: async (commands) => {
        const first = commands[0];
        return first ? server.pushCommands([first]) : [];
      },
      pullMovements: (afterSeq, limit) => server.pullMovements(afterSeq, limit),
    };
    const engine = new SyncEngine(
      {
        commands: pos.commands,
        mirror: pos.mirror,
        transport: flaky,
        cursor: pos.cursor,
        conflicts: pos.conflicts,
      },
      { now: () => AT },
    );

    await engine.sync();
    expect((await pos.commands.listPending()).map((c) => c.id)).toEqual([b.id]);
    expect(pos.mirror.availability(VARIANT, STORE_LOC).available).toBe(7);

    // Full connectivity restored: the leftover command replays cleanly.
    await pos.engine.sync();
    expect(await pos.commands.listPending()).toEqual([]);
    expect(server.ledger.availability(VARIANT, STORE_LOC).available).toBe(7);
    expect(pos.mirror.availability(VARIANT, STORE_LOC).available).toBe(7);
    expect(a.id).not.toBe(b.id);
  });
});
