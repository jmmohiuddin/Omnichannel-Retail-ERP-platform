/**
 * Token-bucket rate limiter (01-connector-architecture.md §4.7, simplified to
 * a single in-process bucket). The clock is injectable so tests never depend
 * on wall time; the default is the system clock.
 */

/** Injectable time source. `now()` is in milliseconds. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface TokenBucketOptions {
  /** Burst size — the maximum number of tokens the bucket can hold. */
  capacity: number;
  /** Sustained refill rate. */
  refillPerSecond: number;
  /** Injectable clock; defaults to the system clock. */
  clock?: Clock;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly clock: Clock;
  private tokens: number;
  private lastRefillAt: number;

  constructor(options: TokenBucketOptions) {
    if (options.capacity <= 0) {
      throw new RangeError("capacity must be > 0");
    }
    if (options.refillPerSecond <= 0) {
      throw new RangeError("refillPerSecond must be > 0");
    }
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.clock = options.clock ?? systemClock;
    this.tokens = options.capacity;
    this.lastRefillAt = this.clock.now();
  }

  /** Tokens currently available (after refilling for elapsed time). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** Take `cost` tokens if available without waiting. */
  tryAcquire(cost = 1): boolean {
    this.assertCost(cost);
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  /** Take `cost` tokens, waiting (via the injected clock) until refilled. */
  async acquire(cost = 1): Promise<void> {
    this.assertCost(cost);
    // Loop rather than compute once: another caller may consume tokens while
    // we sleep, in which case we wait again for the remaining deficit.
    for (;;) {
      this.refill();
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }
      const deficit = cost - this.tokens;
      const waitMs = Math.ceil((deficit / this.refillPerSecond) * 1000);
      await this.clock.sleep(waitMs);
    }
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsedMs = now - this.lastRefillAt;
    if (elapsedMs <= 0) return;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (elapsedMs / 1000) * this.refillPerSecond,
    );
    this.lastRefillAt = now;
  }

  private assertCost(cost: number): void {
    if (cost <= 0 || cost > this.capacity) {
      throw new RangeError(
        `cost must be in (0, capacity=${this.capacity}], got ${cost}`,
      );
    }
  }
}
