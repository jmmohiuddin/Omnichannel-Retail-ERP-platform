import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
} from "./gateway.js";

/**
 * Claude Messages API provider (ADR-009). Plain fetch against
 * https://api.anthropic.com/v1/messages — deliberately no SDK dependency so
 * the gateway owns retries/budgets and the api package stays lean.
 */

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-5";

/** Non-200 response from the Anthropic API, with status + error type. */
export class AnthropicApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string,
    message: string,
  ) {
    super(`Anthropic API error ${status} (${errorType}): ${message}`);
    this.name = "AnthropicApiError";
  }
}

export interface AnthropicProviderOptions {
  apiKey: string;
  /** Model id; defaults to "claude-sonnet-5". */
  model?: string;
  /** Override the API origin (tests, proxies). */
  baseUrl?: string;
  /** Injectable fetch so unit tests never touch the network. */
  fetchFn?: typeof fetch;
}

interface MessagesResponseBody {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface ErrorResponseBody {
  error?: { type?: string; message?: string };
}

export class AnthropicProvider implements AiProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: AnthropicProviderOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
    const response = await this.fetchFn(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      }),
    });

    if (response.status !== 200) {
      throw await this.toApiError(response);
    }

    const body = (await response.json()) as MessagesResponseBody;
    const text = (body.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    return {
      text,
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
    };
  }

  private async toApiError(response: Response): Promise<AnthropicApiError> {
    let errorType = "unknown_error";
    let message = "no error body";
    try {
      const body = (await response.json()) as ErrorResponseBody;
      errorType = body.error?.type ?? errorType;
      message = body.error?.message ?? message;
    } catch {
      // keep defaults — body was not JSON
    }
    return new AnthropicApiError(response.status, errorType, message);
  }
}
