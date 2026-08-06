import { describe, expect, it } from "vitest";
import { TokenBucket, type Clock } from "./rateLimiter.js";

/** Deterministic clock: sleeping advances time, so acquire() always resolves. */
class FakeClock implements Clock {
  t = 0;
  readonly sleeps: number[] = [];
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.t += ms;
  }
}

describe("TokenBucket", () => {
  it("allows an immediate burst up to capacity without sleeping", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1, clock });
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    expect(clock.sleeps).toEqual([]);
    expect(bucket.available()).toBe(0);
  });

  it("waits exactly the deficit time when the bucket is empty", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 2, clock });
    await bucket.acquire(2); // drain the burst
    await bucket.acquire(); // needs 1 token at 2/s => 500 ms
    expect(clock.sleeps).toEqual([500]);
  });

  it("refills over elapsed time and caps at capacity", () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1, clock });
    expect(bucket.tryAcquire(5)).toBe(true);
    clock.t += 2000;
    expect(bucket.available()).toBeCloseTo(2);
    clock.t += 60_000; // long idle must not exceed capacity
    expect(bucket.available()).toBe(5);
  });

  it("tryAcquire returns false without consuming when tokens are short", () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1, clock });
    expect(bucket.tryAcquire(2)).toBe(true);
    expect(bucket.tryAcquire()).toBe(false);
    clock.t += 1000;
    expect(bucket.tryAcquire()).toBe(true);
  });

  it("supports multi-token costs and sleeps proportionally to the deficit", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 5, clock });
    await bucket.acquire(10);
    await bucket.acquire(4); // deficit 4 at 5/s => 800 ms
    expect(clock.sleeps).toEqual([800]);
  });

  it("rejects invalid construction and costs beyond capacity", async () => {
    const clock = new FakeClock();
    expect(
      () => new TokenBucket({ capacity: 0, refillPerSecond: 1, clock }),
    ).toThrow(RangeError);
    expect(
      () => new TokenBucket({ capacity: 1, refillPerSecond: 0, clock }),
    ).toThrow(RangeError);
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1, clock });
    expect(() => bucket.tryAcquire(3)).toThrow(RangeError);
    await expect(bucket.acquire(0)).rejects.toThrow(RangeError);
  });
});
