/**
 * In-memory implementations of the pos-core storage interfaces. Used by unit
 * tests and as the reference semantics for the SQLite-backed implementations
 * the Tauri shell will provide.
 */
import type { CommandStore, PosCommand, StoredCommand } from "../commandLog.js";
import type { ConflictSink, CursorStore, SyncConflict } from "../syncEngine.js";

export class InMemoryCommandStore implements CommandStore {
  private readonly entries = new Map<string, StoredCommand>();

  async append(command: PosCommand): Promise<void> {
    if (this.entries.has(command.id)) {
      throw new Error(`command ${command.id} already stored`);
    }
    this.entries.set(command.id, { command, status: "pending" });
  }

  async listPending(): Promise<PosCommand[]> {
    return [...this.entries.values()]
      .filter((e) => e.status === "pending")
      .map((e) => e.command)
      .sort((a, b) => a.seq - b.seq);
  }

  async markSynced(commandId: string): Promise<void> {
    this.mark(commandId, "synced");
  }

  async markRejected(commandId: string, reason: string): Promise<void> {
    this.mark(commandId, "rejected", reason);
  }

  async lastSeq(): Promise<number> {
    let max = 0;
    for (const e of this.entries.values()) max = Math.max(max, e.command.seq);
    return max;
  }

  /** Test/UI helper: full log snapshot in local seq order. */
  snapshot(): StoredCommand[] {
    return [...this.entries.values()].sort((a, b) => a.command.seq - b.command.seq);
  }

  private mark(commandId: string, status: "synced" | "rejected", reason?: string): void {
    const entry = this.entries.get(commandId);
    if (!entry) throw new Error(`unknown command ${commandId}`);
    entry.status = status;
    if (reason !== undefined) entry.rejectionReason = reason;
  }
}

export class InMemoryCursorStore implements CursorStore {
  private cursor = 0;

  async get(): Promise<number> {
    return this.cursor;
  }

  async set(cursor: number): Promise<void> {
    this.cursor = cursor;
  }
}

export class InMemoryConflictSink implements ConflictSink {
  readonly conflicts: SyncConflict[] = [];

  async record(conflict: SyncConflict): Promise<void> {
    this.conflicts.push(conflict);
  }
}
