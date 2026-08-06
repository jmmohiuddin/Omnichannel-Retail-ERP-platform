/**
 * Offline resilience v1 for sale submission (swappable module).
 *
 * A sale POST that fails from a NETWORK error (never reached the server) is
 * queued here and replayed on an interval and on the browser 'online' event.
 * The payload carries a client-generated UUID, so replaying to the server is
 * idempotent. HTTP rejections (4xx/5xx) are NOT retried blindly: 4xx means the
 * server saw and refused the sale — retrying can't fix it, so it is dropped
 * from the queue and surfaced via `onRejected`; 5xx stays queued for retry.
 *
 * This module deliberately mirrors the pos-core CommandStore replay shape so a
 * later phase can swap in `@omniretail/pos-core`'s CommandLog + SyncEngine
 * without touching the UI: the UI only calls `submit()` and renders
 * `pendingCount`.
 */
import { ApiError, isNetworkError, type SalePayload, type SaleResult } from "./api.js";

export interface QueuedSale {
  payload: SalePayload;
  queuedAt: string;
  attempts: number;
}

/** Minimal storage surface — localStorage in the app, in-memory in tests. */
export type QueueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface SaleQueueOptions {
  storage: QueueStorage;
  /** Performs the actual POST /v1/pos/sales. */
  post: (payload: SalePayload) => Promise<SaleResult>;
  storageKey?: string;
  /** Called when a queued sale is definitively rejected (HTTP 4xx) on flush. */
  onRejected?: (sale: QueuedSale, error: ApiError) => void;
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
  private readonly onRejected: ((sale: QueuedSale, error: ApiError) => void) | undefined;
  private readonly retryIntervalMs: number;
  private readonly listeners = new Set<(count: number) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private onlineHandler: (() => void) | null = null;
  private flushing = false;

  constructor(options: SaleQueueOptions) {
    this.storage = options.storage;
    this.post = options.post;
    this.key = options.storageKey ?? DEFAULT_KEY;
    this.onRejected = options.onRejected;
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
            rejected++;
            queue = queue.slice(1);
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

  subscribe(listener: (count: number) => void): () => void {
    this.listeners.add(listener);
    listener(this.pendingCount());
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
    try {
      const raw = this.storage.getItem(this.key);
      if (raw === null) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as QueuedSale[]) : [];
    } catch {
      return [];
    }
  }

  private write(queue: QueuedSale[]): void {
    if (queue.length === 0) this.storage.removeItem(this.key);
    else this.storage.setItem(this.key, JSON.stringify(queue));
    for (const l of this.listeners) l(queue.length);
  }
}
