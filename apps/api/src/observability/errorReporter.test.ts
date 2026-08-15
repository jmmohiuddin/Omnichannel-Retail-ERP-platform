import { describe, expect, it, vi } from "vitest";
import {
  MemoryErrorReporter,
  NoopErrorReporter,
  SentryErrorReporter,
  parseDsn,
  reporterFromEnv,
  stackFrames,
} from "./errorReporter.js";

describe("parseDsn", () => {
  it("splits a standard DSN into key, project and envelope URL", () => {
    const parsed = parseDsn("https://abc123@o42.ingest.sentry.io/1234567");
    expect(parsed).toEqual({
      publicKey: "abc123",
      projectId: "1234567",
      envelopeUrl: "https://o42.ingest.sentry.io/api/1234567/envelope/",
    });
  });

  it("keeps the path prefix of a self-hosted install", () => {
    const parsed = parseDsn("https://key@sentry.example.com/prefix/9");
    expect(parsed?.envelopeUrl).toBe("https://sentry.example.com/prefix/api/9/envelope/");
  });

  it("returns undefined rather than throwing on a malformed DSN", () => {
    // A bad value in the environment must degrade to "reporting off". If this
    // threw, one typo in a deploy variable would stop the API from booting.
    expect(parseDsn("not-a-url")).toBeUndefined();
    expect(parseDsn("https://o42.ingest.sentry.io/1234567")).toBeUndefined(); // no key
    expect(parseDsn("https://key@host")).toBeUndefined(); // no project id
  });
});

describe("stackFrames", () => {
  it("orders frames with the crash site last and marks app frames", () => {
    const stack = [
      "Error: boom",
      "    at inner (/srv/app/src/sales/salesService.ts:210:11)",
      "    at outer (/srv/app/node_modules/fastify/lib/handler.js:12:3)",
    ].join("\n");

    const frames = stackFrames(stack);

    expect(frames).toHaveLength(2);
    expect(frames.at(-1)).toMatchObject({
      function: "inner",
      filename: "/srv/app/src/sales/salesService.ts",
      lineno: 210,
      in_app: true,
    });
    expect(frames[0]).toMatchObject({ in_app: false });
  });

  it("drops unparseable lines instead of guessing", () => {
    expect(stackFrames("Error: boom\n    at <anonymous>")).toHaveLength(0);
  });
});

describe("SentryErrorReporter", () => {
  const dsn = "https://pub@o1.ingest.sentry.io/55";

  it("builds a three-line envelope carrying the exception and context tags", () => {
    const reporter = new SentryErrorReporter({
      dsn,
      environment: "production",
      release: "abc1234",
      now: () => new Date("2026-08-14T09:00:00.000Z"),
    });

    const lines = reporter
      .buildEnvelope(new TypeError("cannot read sku"), {
        transaction: "POST /v1/pos/sales",
        tenantId: "tenant-1",
        userId: "user-9",
        statusCode: 500,
      })
      .split("\n");

    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]!)).toEqual({ type: "event" });

    const event = JSON.parse(lines[2]!);
    expect(event.exception.values[0]).toMatchObject({
      type: "TypeError",
      value: "cannot read sku",
    });
    expect(event.transaction).toBe("POST /v1/pos/sales");
    expect(event.tags).toEqual({ tenant_id: "tenant-1", status_code: "500" });
    expect(event.user).toEqual({ id: "user-9" });
    expect(event.environment).toBe("production");
    expect(event.release).toBe("abc1234");

    // The envelope header's event_id must match the event's, or Sentry files
    // the item under a different id than the one we log.
    expect(JSON.parse(lines[0]!).event_id).toBe(event.event_id);
    expect(event.event_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("POSTs to the envelope endpoint with the auth header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    const reporter = new SentryErrorReporter({ dsn, fetchImpl: fetchImpl as never });

    reporter.captureException(new Error("boom"));
    await reporter.flush();

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://o1.ingest.sentry.io/api/55/envelope/");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Sentry-Auth"]).toContain("sentry_key=pub");
    expect(init.headers["Content-Type"]).toBe("application/x-sentry-envelope");
  });

  it("swallows a transport failure — the monitor must not become the outage", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("DNS is down"));
    const reporter = new SentryErrorReporter({ dsn, fetchImpl: fetchImpl as never });

    expect(() => reporter.captureException(new Error("boom"))).not.toThrow();
    await expect(reporter.flush()).resolves.toBeUndefined();
  });

  it("sends nothing when the DSN does not parse", async () => {
    const fetchImpl = vi.fn();
    const reporter = new SentryErrorReporter({ dsn: "garbage", fetchImpl: fetchImpl as never });

    expect(reporter.enabled).toBe(false);
    reporter.captureException(new Error("boom"));
    await reporter.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a non-Error throw without losing it", () => {
    const reporter = new SentryErrorReporter({ dsn });
    const event = JSON.parse(reporter.buildEnvelope("string failure").split("\n")[2]!);
    expect(event.exception.values[0]).toMatchObject({
      type: "NonError",
      value: "string failure",
    });
  });
});

describe("reporterFromEnv", () => {
  it("is a no-op when SENTRY_DSN is unset", () => {
    expect(reporterFromEnv({})).toBeInstanceOf(NoopErrorReporter);
  });

  it("is a no-op when SENTRY_DSN is set but unparseable", () => {
    expect(reporterFromEnv({ SENTRY_DSN: "nonsense" })).toBeInstanceOf(NoopErrorReporter);
  });

  it("returns a live reporter when the DSN is valid", () => {
    const reporter = reporterFromEnv({
      SENTRY_DSN: "https://k@o1.ingest.sentry.io/7",
      SENTRY_ENVIRONMENT: "staging",
    });
    expect(reporter).toBeInstanceOf(SentryErrorReporter);
  });
});

describe("MemoryErrorReporter", () => {
  it("records what it was given, for assertions in other tests", () => {
    const reporter = new MemoryErrorReporter();
    const err = new Error("boom");
    reporter.captureException(err, { transaction: "GET /x" });
    expect(reporter.events).toEqual([{ error: err, context: { transaction: "GET /x" } }]);
  });
});
