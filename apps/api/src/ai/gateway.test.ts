import { describe, expect, it } from "vitest";
import {
  AiBudgetError,
  AiGateway,
  StubProvider,
  type AiCallLogEntry,
  type AiProvider,
} from "./gateway.js";

function fixedProvider(text = "narration"): AiProvider {
  return {
    async complete() {
      return { text, inputTokens: 100, outputTokens: 42 };
    },
  };
}

function collectingLogger() {
  const entries: AiCallLogEntry[] = [];
  return { entries, logger: { info: (e: AiCallLogEntry) => entries.push(e) } };
}

describe("StubProvider", () => {
  it("is deterministic for the same prompt", async () => {
    const stub = new StubProvider();
    const req = { system: "sys", user: "hello world", maxTokens: 256 };
    const a = await stub.complete(req);
    const b = await stub.complete(req);
    expect(a).toEqual(b);
    expect(a.text).toMatch(/^\[stub completion [0-9a-f]{8}\]/);
  });

  it("changes its echoed hash when the prompt length changes", async () => {
    const stub = new StubProvider();
    const a = await stub.complete({ system: "s", user: "short", maxTokens: 1 });
    const b = await stub.complete({
      system: "s",
      user: "a much longer prompt",
      maxTokens: 1,
    });
    expect(a.text).not.toEqual(b.text);
  });
});

describe("AiGateway", () => {
  it("returns the provider result", async () => {
    const gateway = new AiGateway(fixedProvider("the digest"), {
      logger: collectingLogger().logger,
    });
    const result = await gateway.narrate("t1", "daily_digest", "sys", "usr");
    expect(result).toEqual({
      text: "the digest",
      inputTokens: 100,
      outputTokens: 42,
    });
  });

  it("logs tenantId, kind and token usage for every call", async () => {
    const { entries, logger } = collectingLogger();
    const gateway = new AiGateway(fixedProvider(), { logger });
    await gateway.narrate("tenant-a", "daily_digest", "sys", "usr");
    expect(entries).toEqual([
      {
        tenantId: "tenant-a",
        kind: "daily_digest",
        tokens: { input: 100, output: 42 },
      },
    ]);
  });

  it("throws a typed AiBudgetError once the daily budget is exhausted", async () => {
    const { logger } = collectingLogger();
    const gateway = new AiGateway(fixedProvider(), {
      maxCallsPerTenantPerDay: 2,
      logger,
    });
    await gateway.narrate("t1", "k", "s", "u");
    await gateway.narrate("t1", "k", "s", "u");
    const third = gateway.narrate("t1", "k", "s", "u");
    await expect(third).rejects.toBeInstanceOf(AiBudgetError);
    await expect(third).rejects.toMatchObject({
      code: "AI_BUDGET_EXCEEDED",
      tenantId: "t1",
      maxCallsPerDay: 2,
    });
  });

  it("tracks budgets per tenant independently", async () => {
    const { logger } = collectingLogger();
    const gateway = new AiGateway(fixedProvider(), {
      maxCallsPerTenantPerDay: 1,
      logger,
    });
    await gateway.narrate("t1", "k", "s", "u");
    await expect(gateway.narrate("t1", "k", "s", "u")).rejects.toBeInstanceOf(
      AiBudgetError,
    );
    // other tenant unaffected
    await expect(gateway.narrate("t2", "k", "s", "u")).resolves.toBeDefined();
  });

  it("resets the budget on the next day (injectable clock)", async () => {
    const { logger } = collectingLogger();
    let now = new Date("2026-08-06T20:00:00Z");
    const gateway = new AiGateway(fixedProvider(), {
      maxCallsPerTenantPerDay: 1,
      clock: () => now,
      logger,
    });
    await gateway.narrate("t1", "k", "s", "u");
    await expect(gateway.narrate("t1", "k", "s", "u")).rejects.toBeInstanceOf(
      AiBudgetError,
    );
    expect(gateway.remainingBudget("t1")).toBe(0);

    now = new Date("2026-08-07T00:00:01Z"); // next UTC day
    expect(gateway.remainingBudget("t1")).toBe(1);
    await expect(gateway.narrate("t1", "k", "s", "u")).resolves.toBeDefined();
  });

  it("does not log or call the provider when the budget is exceeded", async () => {
    const { entries, logger } = collectingLogger();
    let providerCalls = 0;
    const provider: AiProvider = {
      async complete() {
        providerCalls++;
        return { text: "x", inputTokens: 1, outputTokens: 1 };
      },
    };
    const gateway = new AiGateway(provider, {
      maxCallsPerTenantPerDay: 1,
      logger,
    });
    await gateway.narrate("t1", "k", "s", "u");
    await expect(gateway.narrate("t1", "k", "s", "u")).rejects.toThrow(
      AiBudgetError,
    );
    expect(providerCalls).toBe(1);
    expect(entries).toHaveLength(1);
  });

  it("defaults to 50 calls per tenant per day", async () => {
    const { logger } = collectingLogger();
    const gateway = new AiGateway(fixedProvider(), { logger });
    expect(gateway.remainingBudget("t1")).toBe(50);
  });
});
