import { describe, expect, it, vi } from "vitest";
import { AnthropicApiError, AnthropicProvider } from "./anthropicProvider.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const happyBody = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "Today revenue was AED 1,234.50." }],
  model: "claude-sonnet-5",
  stop_reason: "end_turn",
  usage: { input_tokens: 321, output_tokens: 57 },
};

describe("AnthropicProvider", () => {
  it("maps a 200 response including token usage", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, happyBody));
    const provider = new AnthropicProvider({
      apiKey: "sk-test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const result = await provider.complete({
      system: "you are an analyst",
      user: "narrate this",
      maxTokens: 512,
    });

    expect(result).toEqual({
      text: "Today revenue was AED 1,234.50.",
      inputTokens: 321,
      outputTokens: 57,
    });
  });

  it("sends the Messages API request shape with default model claude-sonnet-5", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, happyBody));
    const provider = new AnthropicProvider({
      apiKey: "sk-test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await provider.complete({ system: "sys", user: "usr", maxTokens: 512 });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "x-api-key": "sk-test",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      model: "claude-sonnet-5",
      max_tokens: 512,
      system: "sys",
      messages: [{ role: "user", content: "usr" }],
    });
  });

  it("honours a configured model override", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, happyBody));
    const provider = new AnthropicProvider({
      apiKey: "sk-test",
      model: "claude-haiku-4-5",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await provider.complete({ system: "s", user: "u", maxTokens: 64 });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe("claude-haiku-4-5");
  });

  it("concatenates only text blocks from the response content", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        ...happyBody,
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "Part one. " },
          { type: "text", text: "Part two." },
        ],
      }),
    );
    const provider = new AnthropicProvider({
      apiKey: "sk-test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const result = await provider.complete({
      system: "s",
      user: "u",
      maxTokens: 64,
    });
    expect(result.text).toBe("Part one. Part two.");
  });

  it("throws AnthropicApiError with status and error type on 429", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(429, {
        type: "error",
        error: { type: "rate_limit_error", message: "Too many requests" },
      }),
    );
    const provider = new AnthropicProvider({
      apiKey: "sk-test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const attempt = provider.complete({ system: "s", user: "u", maxTokens: 8 });
    await expect(attempt).rejects.toBeInstanceOf(AnthropicApiError);
    await expect(attempt).rejects.toMatchObject({
      status: 429,
      errorType: "rate_limit_error",
    });
  });

  it("throws AnthropicApiError with status and error type on 400", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(400, {
        type: "error",
        error: { type: "invalid_request_error", message: "max_tokens: bad" },
      }),
    );
    const provider = new AnthropicProvider({
      apiKey: "sk-test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(
      provider.complete({ system: "s", user: "u", maxTokens: 8 }),
    ).rejects.toMatchObject({
      status: 400,
      errorType: "invalid_request_error",
      message: expect.stringContaining("max_tokens: bad"),
    });
  });

  it("survives a non-JSON error body", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
    const provider = new AnthropicProvider({
      apiKey: "sk-test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(
      provider.complete({ system: "s", user: "u", maxTokens: 8 }),
    ).rejects.toMatchObject({ status: 502, errorType: "unknown_error" });
  });
});
