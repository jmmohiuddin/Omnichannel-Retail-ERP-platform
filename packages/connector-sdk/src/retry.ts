/**
 * Retry with exponential backoff + full jitter
 * (01-connector-architecture.md §4.8): delay = rand(0, min(cap, base × 2^attempt)).
 * Random and sleep are injectable so tests are deterministic and instant.
 */

/** Error carrying an HTTP status so the default classifier can act on it. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message = `HTTP ${status}`,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** 429 and 5xx are retryable; other statuses are not. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Default classification: HTTP 429/5xx → retryable; other HTTP statuses
 * (4xx) → permanent; errors with no status (network resets, timeouts) are
 * treated as transient and retried.
 */
export function defaultIsRetryable(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined) return isRetryableStatus(status);
  return true;
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof HttpError) return err.status;
  if (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  ) {
    return (err as { status: number }).status;
  }
  return undefined;
}

export interface RetryOptions {
  /** Additional attempts after the first call (total calls = retries + 1). */
  retries: number;
  baseDelayMs: number;
  /** Backoff cap; defaults to 30 000 ms. */
  maxDelayMs?: number;
  /** Error classifier; defaults to `defaultIsRetryable`. */
  isRetryable?: (err: unknown) => boolean;
  /** Injectable uniform [0, 1) source for jitter; defaults to Math.random. */
  random?: () => number;
  /** Injectable sleep; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    retries,
    baseDelayMs,
    maxDelayMs = 30_000,
    isRetryable = defaultIsRetryable,
    random = Math.random,
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      // Full jitter: uniform in [0, min(cap, base * 2^attempt)).
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await sleep(random() * ceiling);
    }
  }
}
