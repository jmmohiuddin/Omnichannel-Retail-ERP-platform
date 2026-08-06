import { describe, expect, it } from "vitest";
import {
  HttpError,
  defaultIsRetryable,
  isRetryableStatus,
  withRetry,
} from "./retry.js";

/** Records requested delays; never actually waits. */
function fakeSleep(): { sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

describe("classification", () => {
  it("marks 429 and 5xx retryable, other 4xx permanent", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });

  it("defaultIsRetryable reads HttpError and status-bearing objects; bare errors are transient", () => {
    expect(defaultIsRetryable(new HttpError(429))).toBe(true);
    expect(defaultIsRetryable(new HttpError(422))).toBe(false);
    expect(defaultIsRetryable({ status: 502 })).toBe(true);
    expect(defaultIsRetryable({ status: 403 })).toBe(false);
    expect(defaultIsRetryable(new Error("socket hang up"))).toBe(true);
  });
});

describe("withRetry", () => {
  it("returns the first successful result without sleeping", async () => {
    const { sleeps, sleep } = fakeSleep();
    const result = await withRetry(async () => 42, {
      retries: 3,
      baseDelayMs: 100,
      sleep,
    });
    expect(result).toBe(42);
    expect(sleeps).toEqual([]);
  });

  it("retries retryable failures until success", async () => {
    const { sleeps, sleep } = fakeSleep();
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new HttpError(503);
        return "ok";
      },
      { retries: 5, baseDelayMs: 100, sleep, random: () => 0.5 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it("does not retry permanent 4xx errors", async () => {
    const { sleeps, sleep } = fakeSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new HttpError(400, "validation rejected");
        },
        { retries: 5, baseDelayMs: 100, sleep },
      ),
    ).rejects.toThrow("validation rejected");
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("exhausts retries and rethrows the last error", async () => {
    const { sleep } = fakeSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new HttpError(500, `boom ${calls}`);
        },
        { retries: 2, baseDelayMs: 100, sleep },
      ),
    ).rejects.toThrow("boom 3");
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it("backs off exponentially with full jitter (delay = random * min(cap, base * 2^attempt))", async () => {
    const { sleeps, sleep } = fakeSleep();
    await expect(
      withRetry(
        async () => {
          throw new HttpError(429);
        },
        {
          retries: 4,
          baseDelayMs: 100,
          maxDelayMs: 500,
          sleep,
          random: () => 1, // pin jitter at the ceiling
        },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    // ceilings: 100, 200, 400, then capped at 500
    expect(sleeps).toEqual([100, 200, 400, 500]);
  });

  it("jitter scales the ceiling by the injected random value", async () => {
    const { sleeps, sleep } = fakeSleep();
    await expect(
      withRetry(
        async () => {
          throw new HttpError(500);
        },
        { retries: 2, baseDelayMs: 100, sleep, random: () => 0.25 },
      ),
    ).rejects.toBeInstanceOf(HttpError);
    expect(sleeps).toEqual([25, 50]);
  });

  it("honors a custom isRetryable classifier", async () => {
    const { sleep } = fakeSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("NEVER_RETRY");
        },
        {
          retries: 5,
          baseDelayMs: 10,
          sleep,
          isRetryable: (err) => !(err as Error).message.includes("NEVER_RETRY"),
        },
      ),
    ).rejects.toThrow("NEVER_RETRY");
    expect(calls).toBe(1);
  });
});
