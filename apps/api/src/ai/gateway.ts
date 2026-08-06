/**
 * AI gateway (ADR-009): the single governed entry point for LLM calls.
 * Enforces per-tenant daily call budgets, logs every call, and keeps the
 * provider behind a narrow interface so routes never talk to a vendor SDK.
 * The LLM narrates statistical outputs — it never produces figures itself.
 */

export interface AiCompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface AiCompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiProvider {
  complete(req: AiCompletionRequest): Promise<AiCompletionResult>;
}

/** Typed error thrown when a tenant exhausts its daily AI call budget. */
export class AiBudgetError extends Error {
  readonly code = "AI_BUDGET_EXCEEDED";

  constructor(
    readonly tenantId: string,
    readonly maxCallsPerDay: number,
  ) {
    super(
      `AI budget exceeded for tenant ${tenantId}: ` +
        `${maxCallsPerDay} calls/day limit reached`,
    );
    this.name = "AiBudgetError";
  }
}

export interface AiCallLogEntry {
  tenantId: string;
  kind: string;
  tokens: { input: number; output: number };
}

export interface AiLogger {
  info(entry: AiCallLogEntry): void;
}

export interface AiGatewayOptions {
  /** Daily per-tenant call cap. Default 50. */
  maxCallsPerTenantPerDay?: number;
  /** Injectable clock so tests can control the budget day. Default Date.now. */
  clock?: () => Date;
  /** Injectable logger; defaults to a console-backed logger. */
  logger?: AiLogger;
  /** max_tokens forwarded to the provider. Default 1024. */
  maxTokens?: number;
}

export class AiGateway {
  private readonly maxCallsPerTenantPerDay: number;
  private readonly clock: () => Date;
  private readonly logger: AiLogger;
  private readonly maxTokens: number;
  /** tenantId -> usage for one UTC day (in-memory; resets on day change). */
  private readonly usage = new Map<string, { day: string; calls: number }>();

  constructor(
    private readonly provider: AiProvider,
    opts: AiGatewayOptions = {},
  ) {
    this.maxCallsPerTenantPerDay = opts.maxCallsPerTenantPerDay ?? 50;
    this.clock = opts.clock ?? (() => new Date());
    this.logger =
      opts.logger ??
      ({
        info(entry: AiCallLogEntry) {
          console.info("[ai-gateway]", JSON.stringify(entry));
        },
      } satisfies AiLogger);
    this.maxTokens = opts.maxTokens ?? 1024;
  }

  /**
   * Run one governed LLM call for a tenant. Throws AiBudgetError once the
   * tenant's daily budget is exhausted; otherwise forwards to the provider
   * and logs {tenantId, kind, tokens}.
   */
  async narrate(
    tenantId: string,
    kind: string,
    system: string,
    user: string,
  ): Promise<AiCompletionResult> {
    this.consumeBudget(tenantId);
    const result = await this.provider.complete({
      system,
      user,
      maxTokens: this.maxTokens,
    });
    this.logger.info({
      tenantId,
      kind,
      tokens: { input: result.inputTokens, output: result.outputTokens },
    });
    return result;
  }

  /** Remaining calls for the tenant today (for surfacing in admin UIs). */
  remainingBudget(tenantId: string): number {
    const day = this.currentDay();
    const entry = this.usage.get(tenantId);
    const used = entry && entry.day === day ? entry.calls : 0;
    return Math.max(0, this.maxCallsPerTenantPerDay - used);
  }

  private currentDay(): string {
    return this.clock().toISOString().slice(0, 10);
  }

  private consumeBudget(tenantId: string): void {
    const day = this.currentDay();
    const entry = this.usage.get(tenantId);
    if (!entry || entry.day !== day) {
      this.usage.set(tenantId, { day, calls: 1 });
      return;
    }
    if (entry.calls >= this.maxCallsPerTenantPerDay) {
      throw new AiBudgetError(tenantId, this.maxCallsPerTenantPerDay);
    }
    entry.calls += 1;
  }
}

/**
 * Deterministic provider for tests and for running the API without an
 * Anthropic key. Echoes a stable hash of the prompt lengths so callers can
 * assert determinism without any network access.
 */
export class StubProvider implements AiProvider {
  async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
    const hash = fnv1a(`${req.system.length}:${req.user.length}`);
    return {
      text: `[stub completion ${hash}] narrated ${req.user.length} chars of input (no live AI provider configured)`,
      inputTokens: Math.ceil((req.system.length + req.user.length) / 4),
      outputTokens: 16,
    };
  }
}

/** FNV-1a 32-bit hash, hex-encoded — stable across runs and platforms. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
