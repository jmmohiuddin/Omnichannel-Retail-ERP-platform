/**
 * Bidirectional POS sync (docs/02-architecture.md §6):
 *
 *   1. PUSH — replay all pending offline commands to the server. Replay is
 *      idempotent: the server dedupes on command id, so a `duplicate` result
 *      is success (the previous push landed but the ack was lost).
 *   2. PULL — page the authoritative ledger movement feed after the local
 *      cursor (the shape of GET /v1/inventory/movements: `afterSeq`/`limit`
 *      in, `{ items, nextCursor }` out) and fold it into the local mirror
 *      via InventoryLedger.replay semantics.
 *
 * Server rejections (e.g. another register sold the last unit first) are
 * never dropped: they are marked rejected locally AND recorded through
 * `ConflictSink` so the POS UI can surface them for manager resolution.
 *
 * Pure TypeScript, no I/O: transport, cursor persistence, and conflict
 * storage are all injected interfaces.
 */
import type { PostedMovement } from "@omniretail/domain";
import type { CommandStore, LocalInventoryMirror, PosCommand } from "./commandLog.js";

// ---------------------------------------------------------------------------
// Transport & storage abstractions
// ---------------------------------------------------------------------------

export type PushStatus = "applied" | "duplicate" | "rejected";

export interface PushResult {
  commandId: string;
  status: PushStatus;
  /** Present when status is "rejected" — e.g. an INSUFFICIENT_STOCK message. */
  reason?: string;
}

export interface PullPage {
  /** Authoritative movements in ascending `seq` order. */
  items: PostedMovement[];
  /** `seq` of the last item, or the request's `afterSeq` when empty. */
  nextCursor: number;
}

export interface SyncTransport {
  /** Replay pending commands in local seq order; one result per command. */
  pushCommands(commands: readonly PosCommand[]): Promise<PushResult[]>;
  /** Page the server ledger feed (GET /v1/inventory/movements). */
  pullMovements(afterSeq: number, limit: number): Promise<PullPage>;
}

export interface CursorStore {
  /** Last server ledger seq applied locally (0 when never synced). */
  get(): Promise<number>;
  set(cursor: number): Promise<void>;
}

export interface SyncConflict {
  command: PosCommand;
  reason: string;
  recordedAt: Date;
}

/** Where server rejections land for manager resolution — never /dev/null. */
export interface ConflictSink {
  record(conflict: SyncConflict): Promise<void>;
}

export interface SyncReport {
  pushed: number;
  applied: number;
  duplicates: number;
  rejected: number;
  pulled: number;
  cursor: number;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface SyncEngineDeps {
  commands: CommandStore;
  mirror: LocalInventoryMirror;
  transport: SyncTransport;
  cursor: CursorStore;
  conflicts: ConflictSink;
}

export interface SyncEngineOptions {
  /** Page size for the pull feed (server caps at 500). */
  pullLimit?: number;
  /** Injected clock for deterministic tests. */
  now?: () => Date;
}

export class SyncEngine {
  private readonly pullLimit: number;
  private readonly now: () => Date;

  constructor(
    private readonly deps: SyncEngineDeps,
    opts: SyncEngineOptions = {},
  ) {
    this.pullLimit = opts.pullLimit ?? 100;
    this.now = opts.now ?? (() => new Date());
  }

  async sync(): Promise<SyncReport> {
    const report: SyncReport = {
      pushed: 0,
      applied: 0,
      duplicates: 0,
      rejected: 0,
      pulled: 0,
      cursor: await this.deps.cursor.get(),
    };

    await this.push(report);
    await this.pull(report);

    // One rebuild per sync: authoritative history replayed, still-pending
    // overlay re-applied. This is what corrects the mirror after a conflict.
    this.deps.mirror.rebuild();
    return report;
  }

  private async push(report: SyncReport): Promise<void> {
    const pending = await this.deps.commands.listPending();
    if (pending.length === 0) return;

    report.pushed = pending.length;
    const results = await this.deps.transport.pushCommands(pending);
    const byId = new Map(results.map((r) => [r.commandId, r]));

    for (const command of pending) {
      const result = byId.get(command.id);
      // No result for a command: leave it pending; it replays next sync.
      if (!result) continue;
      switch (result.status) {
        case "applied":
        case "duplicate": {
          // Duplicate is success — an earlier push landed, the ack didn't.
          report[result.status === "applied" ? "applied" : "duplicates"]++;
          await this.deps.commands.markSynced(command.id);
          // The authoritative movements arrive via the pull that follows.
          this.deps.mirror.discardCommand(command.id);
          break;
        }
        case "rejected": {
          report.rejected++;
          const reason = result.reason ?? "rejected by server";
          await this.deps.commands.markRejected(command.id, reason);
          // Never silent: the POS UI shows this for manager resolution.
          await this.deps.conflicts.record({ command, reason, recordedAt: this.now() });
          // The rejected sale never happened, stock-wise; drop its overlay so
          // the rebuild below re-derives levels from server truth.
          this.deps.mirror.discardCommand(command.id);
          break;
        }
      }
    }
  }

  private async pull(report: SyncReport): Promise<void> {
    let cursor = await this.deps.cursor.get();
    for (;;) {
      const page = await this.deps.transport.pullMovements(cursor, this.pullLimit);
      if (page.items.length === 0) break;
      this.deps.mirror.applyServerMovements(page.items);
      report.pulled += page.items.length;
      cursor = page.nextCursor;
      await this.deps.cursor.set(cursor);
      if (page.items.length < this.pullLimit) break;
    }
    report.cursor = cursor;
  }
}
