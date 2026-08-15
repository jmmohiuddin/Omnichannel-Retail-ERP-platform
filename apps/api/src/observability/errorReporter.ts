/**
 * Error reporting (R12.10, R14.6).
 *
 * The audit's finding was that `SENTRY_DSN` sat in the env schema and nothing
 * read it, so a production 500 reached nobody. This is the port that closes it.
 *
 * Deliberately dependency-free: the Sentry envelope protocol is three JSON
 * lines over HTTPS, and adding an SDK to a workspace that has none buys error
 * reporting at the cost of a transitive dependency tree on the money path.
 * The port is what matters — swapping in @sentry/node later changes one file.
 *
 * Two invariants hold for every implementation:
 *   1. Reporting NEVER throws. An observability failure must not become an
 *      application failure — that would turn a degraded monitor into an outage.
 *   2. Reporting NEVER blocks the response. Capture returns immediately; the
 *      transport runs detached with its own timeout.
 */

export interface ErrorContext {
  /** Route or job that failed, e.g. "POST /v1/pos/sales" or "job:reconcile". */
  readonly transaction?: string;
  /** Tenant the request ran under, when known. Sent as a tag, never as PII. */
  readonly tenantId?: string;
  /** Acting user id, when known. An id only — never name, email or phone. */
  readonly userId?: string;
  /** HTTP status the client was sent, when this came from a request. */
  readonly statusCode?: number;
  /** Anything else useful for triage. Keep it free of customer PII. */
  readonly extra?: Record<string, unknown>;
}

export interface ErrorReporter {
  /** Record an exception. Resolves once the event is queued, not delivered. */
  captureException(error: unknown, context?: ErrorContext): void;
  /** Flush in-flight deliveries. Called on shutdown; best effort. */
  flush(timeoutMs?: number): Promise<void>;
}

/** The default when no DSN is configured: reporting is off, nothing breaks. */
export class NoopErrorReporter implements ErrorReporter {
  captureException(): void {
    /* intentionally empty */
  }
  async flush(): Promise<void> {
    /* intentionally empty */
  }
}

/**
 * Records to memory instead of the network. Used by tests to assert that a
 * failure was reported at all — the property the audit found missing.
 */
export class MemoryErrorReporter implements ErrorReporter {
  readonly events: Array<{ error: unknown; context?: ErrorContext }> = [];
  captureException(error: unknown, context?: ErrorContext): void {
    this.events.push(context ? { error, context } : { error });
  }
  async flush(): Promise<void> {
    /* intentionally empty */
  }
}

export interface ParsedDsn {
  readonly publicKey: string;
  readonly projectId: string;
  readonly envelopeUrl: string;
}

/**
 * Parse a Sentry DSN: `https://{publicKey}@{host}/{path}/{projectId}`.
 * Returns undefined rather than throwing — a malformed DSN in the environment
 * must degrade to "reporting off", not stop the process from booting.
 */
export function parseDsn(dsn: string): ParsedDsn | undefined {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return undefined;
  }
  const publicKey = url.username;
  // The project id is the last path segment; anything before it is a path
  // prefix (self-hosted Sentry behind a subdirectory).
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();
  if (!publicKey || !projectId) return undefined;
  const prefix = segments.length ? `/${segments.join("/")}` : "";
  return {
    publicKey,
    projectId,
    envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
  };
}

function errorParts(error: unknown): { type: string; value: string; stack?: string } {
  if (error instanceof Error) {
    return {
      type: error.name || "Error",
      value: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { type: "NonError", value: typeof error === "string" ? error : JSON.stringify(error) };
}

/**
 * Parse a V8 stack string into Sentry frames, innermost last (Sentry renders
 * the last frame as the crash site). Frames we cannot parse are dropped rather
 * than guessed at — a wrong line number costs more triage time than no frame.
 */
export function stackFrames(stack: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  for (const line of stack.split("\n").slice(1)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    frames.push({
      function: m[1] ?? "<anonymous>",
      filename: m[2],
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !m[2]!.includes("node_modules") && !m[2]!.startsWith("node:"),
    });
  }
  return frames.reverse();
}

export interface SentryOptions {
  readonly dsn: string;
  /** "production", "staging", … Tagged on every event. */
  readonly environment?: string;
  /** Build identifier, so a spike can be pinned to a deploy. */
  readonly release?: string;
  /** Per-delivery timeout. A slow monitor must not pile up sockets. */
  readonly timeoutMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests; must return a stable-format ISO timestamp. */
  readonly now?: () => Date;
}

/**
 * Sentry transport over the envelope endpoint. One event per envelope: this
 * volume is a single shop's error rate, not a fleet's, so batching would add
 * a buffer to lose events in for no measurable gain.
 */
export class SentryErrorReporter implements ErrorReporter {
  private readonly dsn: ParsedDsn | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly options: SentryOptions) {
    this.dsn = parseDsn(options.dsn);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  /** True when the DSN parsed and events will actually be transmitted. */
  get enabled(): boolean {
    return this.dsn !== undefined;
  }

  /** The envelope body for one error. Exported shape is asserted in tests. */
  buildEnvelope(error: unknown, context: ErrorContext = {}): string {
    const eventId = randomEventId();
    const sentAt = this.now().toISOString();
    const { type, value, stack } = errorParts(error);

    const event: Record<string, unknown> = {
      event_id: eventId,
      timestamp: sentAt,
      platform: "node",
      level: "error",
      logger: "voltix.api",
      ...(this.options.environment ? { environment: this.options.environment } : {}),
      ...(this.options.release ? { release: this.options.release } : {}),
      ...(context.transaction ? { transaction: context.transaction } : {}),
      exception: {
        values: [
          {
            type,
            value,
            ...(stack ? { stacktrace: { frames: stackFrames(stack) } } : {}),
          },
        ],
      },
      tags: {
        ...(context.tenantId ? { tenant_id: context.tenantId } : {}),
        ...(context.statusCode ? { status_code: String(context.statusCode) } : {}),
      },
      ...(context.userId ? { user: { id: context.userId } } : {}),
      ...(context.extra ? { extra: context.extra } : {}),
    };

    return [
      JSON.stringify({ event_id: eventId, sent_at: sentAt }),
      JSON.stringify({ type: "event" }),
      JSON.stringify(event),
    ].join("\n");
  }

  captureException(error: unknown, context: ErrorContext = {}): void {
    if (!this.dsn) return;
    const body = this.buildEnvelope(error, context);
    const delivery = this.send(body).finally(() => {
      this.inFlight.delete(delivery);
    });
    this.inFlight.add(delivery);
  }

  private async send(body: string): Promise<void> {
    const dsn = this.dsn!;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 3_000);
    try {
      await this.fetchImpl(dsn.envelopeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-sentry-envelope",
          "X-Sentry-Auth": [
            "Sentry sentry_version=7",
            `sentry_client=voltix-api/1.0`,
            `sentry_key=${dsn.publicKey}`,
          ].join(", "),
        },
        body,
        signal: controller.signal,
      });
    } catch {
      // Swallowed on purpose (invariant 1). A monitor that cannot be reached
      // must not surface as an application error; the gap shows as silence in
      // Sentry, which the uptime check on /healthz covers independently.
    } finally {
      clearTimeout(timer);
    }
  }

  async flush(timeoutMs = 2_000): Promise<void> {
    if (this.inFlight.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}

/** 32 lowercase hex characters, the event_id format Sentry requires. */
function randomEventId(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

/**
 * Build the reporter the process should use from the environment. Absent or
 * unparseable `SENTRY_DSN` yields the no-op — reporting is optional, booting
 * is not.
 */
export function reporterFromEnv(
  env: Record<string, string | undefined> = process.env,
): ErrorReporter {
  const dsn = env.SENTRY_DSN;
  if (!dsn) return new NoopErrorReporter();
  const reporter = new SentryErrorReporter({
    dsn,
    ...(env.SENTRY_ENVIRONMENT ? { environment: env.SENTRY_ENVIRONMENT } : {}),
    ...(env.SENTRY_RELEASE ? { release: env.SENTRY_RELEASE } : {}),
  });
  return reporter.enabled ? reporter : new NoopErrorReporter();
}
