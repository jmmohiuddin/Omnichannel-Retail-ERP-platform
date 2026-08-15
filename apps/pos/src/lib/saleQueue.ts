/**
 * Offline resilience v1 for sale submission (swappable module).
 *
 * A sale POST that fails from a NETWORK error (never reached the server) is
 * queued here and replayed on an interval and on the browser 'online' event.
 * The payload carries a client-generated UUID, so replaying to the server is
 * idempotent. 5xx stays queued for retry.
 *
 * A 4xx is different: the server saw the sale and refused it, so retrying the
 * same bytes cannot help. It must NOT be discarded either. By the time an
 * offline sale replays, the cashier has taken the money and the customer has
 * left with the goods — a rejection is a discrepancy for a human to resolve,
 * not something to delete. Rejected sales therefore move to a separate durable
 * list that survives reload and is surfaced in the UI, and leave it only when
 * someone explicitly resolves them.
 *
 * This module deliberately mirrors the pos-core CommandStore replay shape so a
 * later phase can swap in `@omniretail/pos-core`'s CommandLog + SyncEngine
 * without touching the UI: the UI only calls `submit()` and renders the counts.
 */
import { ApiError, isNetworkError, type SalePayload, type SaleResult } from "./api.js";

export interface QueuedSale {
  payload: SalePayload;
  queuedAt: string;
  attempts: number;
}

/** A sale the server refused. Retained until a human deals with it. */
export interface RejectedSale extends QueuedSale {
  rejectedAt: string;
  status: number;
  /** The server's own message — already human-readable. */
  reason: string;
}

export interface QueueCounts {
  pending: number;
  rejected: number;
}

/** Minimal storage surface — localStorage in the app, in-memory in tests. */
export type QueueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface SaleQueueOptions {
  storage: QueueStorage;
  /** Performs the actual POST /v1/pos/sales. */
  post: (payload: SalePayload) => Promise<SaleResult>;
  storageKey?: string;
  /**
   * Called when a queued sale is definitively rejected (HTTP 4xx) on flush.
   * Advisory only — the sale is retained regardless, so a caller that omits
   * this cannot lose it.
   */
  onRejected?: (sale: QueuedSale, error: ApiError) => void;
  /** Storage refused a write (quota). The tender path must not die silently. */
  onStorageFull?: (err: unknown) => void;
  retryIntervalMs?: number;
}

export type SubmitOutcome =
  | { status: "submitted"; result: SaleResult }
  | { status: "queued"; pendingCount: number };

const DEFAULT_KEY = "omniretail.pos.saleQueue";
const DEFAULT_INTERVAL_MS = 15_000;

export class SaleQueue {
  private readonly storage: QueueStorage;
  private readonly post: (payload: SalePayload) => Promise<SaleResult>;
  private readonly key: string;
  private readonly rejectedKey: string;
  private readonly onRejected: ((sale: QueuedSale, error: ApiError) => void) | undefined;
  private readonly onStorageFull: ((err: unknown) => void) | undefined;
  private readonly retryIntervalMs: number;
  private readonly listeners = new Set<(counts: QueueCounts) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private onlineHandler: (() => void) | null = null;
  private flushing = false;

  constructor(options: SaleQueueOptions) {
    this.storage = options.storage;
    this.post = options.post;
    this.key = options.storageKey ?? DEFAULT_KEY;
    this.rejectedKey = `${this.key}.rejected`;
    this.onRejected = options.onRejected;
    this.onStorageFull = options.onStorageFull;
    this.retryIntervalMs = options.retryIntervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /**
   * Try the POST now; on a network error queue the payload for later replay.
   * HTTP errors on the direct path propagate to the caller (the cashier must
   * see a real rejection immediately, not a silent queue).
   */
  async submit(payload: SalePayload): Promise<SubmitOutcome> {
    try {
      const result = await this.post(payload);
      return { status: "submitted", result };
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      this.enqueue(payload);
      return { status: "queued", pendingCount: this.pendingCount() };
    }
  }

  enqueue(payload: SalePayload): void {
    const queue = this.read();
    if (queue.some((q) => q.payload.id === payload.id)) return; // idempotent
    queue.push({ payload, queuedAt: new Date().toISOString(), attempts: 0 });
    this.write(queue);
  }

  /**
   * Replay pending sales in FIFO order. Stops at the first network error
   * (still offline — later entries would fail the same way).
   */
  async flush(): Promise<{ submitted: number; rejected: number; remaining: number }> {
    if (this.flushing) return { submitted: 0, rejected: 0, remaining: this.pendingCount() };
    this.flushing = true;
    let submitted = 0;
    let rejected = 0;
    try {
      let queue = this.read();
      while (queue.length > 0) {
        const head = queue[0]!;
        try {
          await this.post(head.payload);
          submitted++;
          queue = queue.slice(1);
          this.write(queue);
        } catch (err) {
          if (isNetworkError(err)) {
            head.attempts += 1;
            this.write(queue);
            break; // still offline
          }
          if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
            // Retained, never dropped. The goods are already with the customer;
            // this is a discrepancy a human has to settle.
            rejected++;
            queue = queue.slice(1);
            this.retain(head, err);
            this.write(queue);
            this.onRejected?.(head, err);
            continue;
          }
          // 5xx / unknown: keep queued, try again next cycle.
          head.attempts += 1;
          this.write(queue);
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
    return { submitted, rejected, remaining: this.pendingCount() };
  }

  pendingCount(): number {
    return this.read().length;
  }

  pending(): QueuedSale[] {
    return this.read();
  }

  /** Sales the server refused, awaiting a human. Survives reload. */
  rejected(): RejectedSale[] {
    return this.readRejected();
  }

  rejectedCount(): number {
    return this.readRejected().length;
  }

  /**
   * Clear one rejected sale once someone has dealt with it. The only way a
   * rejected sale leaves storage — nothing removes them automatically.
   */
  resolveRejected(saleId: string): boolean {
    const list = this.readRejected();
    const next = list.filter((r) => r.payload.id !== saleId);
    if (next.length === list.length) return false;
    this.writeRejected(next);
    return true;
  }

  counts(): QueueCounts {
    return { pending: this.pendingCount(), rejected: this.rejectedCount() };
  }

  subscribe(listener: (counts: QueueCounts) => void): () => void {
    this.listeners.add(listener);
    listener(this.counts());
    return () => this.listeners.delete(listener);
  }

  /** Attach the retry interval + 'online' listener (browser runtime only). */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.retryIntervalMs);
    if (typeof window !== "undefined") {
      this.onlineHandler = () => void this.flush();
      window.addEventListener("online", this.onlineHandler);
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.onlineHandler !== null && typeof window !== "undefined") {
      window.removeEventListener("online", this.onlineHandler);
    }
    this.onlineHandler = null;
  }

  private read(): QueuedSale[] {
    return this.readList<QueuedSale>(this.key);
  }

  private readRejected(): RejectedSale[] {
    return this.readList<RejectedSale>(this.rejectedKey);
  }

  private readList<T>(key: string): T[] {
    try {
      const raw = this.storage.getItem(key);
      if (raw === null) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }

  /** Move a refused sale into the durable rejected list. Idempotent by id. */
  private retain(sale: QueuedSale, err: ApiError): void {
    const list = this.readRejected();
    if (list.some((r) => r.payload.id === sale.payload.id)) return;
    list.push({
      ...sale,
      rejectedAt: new Date().toISOString(),
      status: err.status,
      reason: err.message,
    });
    this.writeRejected(list);
  }

  private write(queue: QueuedSale[]): void {
    this.persist(this.key, queue);
    this.notify();
  }

  private writeRejected(list: RejectedSale[]): void {
    this.persist(this.rejectedKey, list);
    this.notify();
  }

  /**
   * Storage can refuse a write — a full quota throws `QuotaExceededError`. That
   * used to propagate out of the tender path and take the till down mid-sale.
   * Report it and carry on: a surfaced warning beats an unusable register.
   */
  private persist(key: string, list: unknown[]): void {
    try {
      if (list.length === 0) this.storage.removeItem(key);
      else this.storage.setItem(key, JSON.stringify(list));
    } catch (err) {
      this.onStorageFull?.(err);
    }
  }

  private notify(): void {
    const counts = this.counts();
    for (const l of this.listeners) l(counts);
  }
}
