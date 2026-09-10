import { describe, expect, it } from "vitest";
import {
  anthropicMaxOutput,
  parseAnthropicChunk,
  parseOpenAIChunk,
  priceFor,
  PROVIDER_IDS,
  PROVIDERS,
} from "./registry";

describe("provider registry", () => {
  it("contains every supported direct provider", () => {
    expect(PROVIDER_IDS).toEqual([
      "local",
      "litellm",
      "openrouter",
      "openai",
      "anthropic",
      "google",
      "xai",
      "deepseek",
      "kimi",
      "minimax",
      "mistral",
      "groq",
      "cerebras",
    ]);
    expect(PROVIDER_IDS[0]).toBe("local");
    expect(PROVIDERS.kimi.chatUrl).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(PROVIDERS.kimi.keyUrl).toContain("platform.kimi.ai");
    expect(PROVIDERS.google.chatUrl).toContain("/openai/chat/completions");
    expect(PROVIDERS.anthropic.body("claude-fable-5", "", "")).toMatchObject({
      max_tokens: 128_000,
    });
    expect(PROVIDERS.anthropic.body("claude-opus-4-8", "", "")).toMatchObject({
      max_tokens: 128_000,
    });
    expect(PROVIDERS.anthropic.body("claude-sonnet-4-5", "", "")).toMatchObject({
      max_tokens: 64_000,
    });
  });

  it("describes LiteLLM as a keyed, user-supplied endpoint", () => {
    const litellm = PROVIDERS.litellm;
    expect(litellm.endpoint).toBe("with-key");
    // Both URLs are derived from the base URL the user types.
    expect(litellm.modelsUrl).toBe("");
    expect(litellm.chatUrl).toBe("");
    expect(litellm.urlLabel).toBe("Base URL");
    expect(litellm.body("gpt-5", "sys", "hi")).toMatchObject({
      model: "gpt-5",
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("authenticates to LiteLLM only when a virtual key is set", () => {
    expect(PROVIDERS.litellm.headers("sk-abc")).toMatchObject({
      Authorization: "Bearer sk-abc",
    });
    // A proxy with no master_key refuses a bare `Bearer ` header.
    expect(PROVIDERS.litellm.headers("  ")).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("prices LiteLLM models through their upstream tables", () => {
    expect(priceFor("litellm", "claude-opus-5")).toEqual({
      prompt: 5 / 1e6,
      completion: 25 / 1e6,
    });
    // A `provider/model` route resolves on the segment after the prefix.
    expect(priceFor("litellm", "azure/gpt-5-mini")).toEqual({
      prompt: 0.25 / 1e6,
      completion: 2 / 1e6,
    });
    // House aliases stay unpriced rather than guessing.
    expect(priceFor("litellm", "smart-model")).toBeNull();
  });

  it("asks MiniMax to split thinking out of the answer", () => {
    expect(PROVIDERS.minimax.body("MiniMax-M3", "sys", "hi")).toMatchObject({
      reasoning_split: true,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("picks Anthropic max_tokens from each model family", () => {
    expect(anthropicMaxOutput("claude-3-5-haiku-20241022")).toBe(8192);
    expect(anthropicMaxOutput("claude-opus-4-20250514")).toBe(32_000);
    expect(anthropicMaxOutput("claude-opus-4-1")).toBe(32_000);
    expect(anthropicMaxOutput("claude-haiku-4-5")).toBe(64_000);
    expect(anthropicMaxOutput("claude-sonnet-5")).toBe(128_000);
  });

  it("normalizes OpenAI-compatible content, reasoning and usage", () => {
    expect(
      parseOpenAIChunk({
        choices: [
          {
            delta: { content: "answer", reasoning_content: "thought" },
            finish_reason: "length",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }),
    ).toEqual({
      content: "answer",
      reasoning: "thought",
      usage: { prompt_tokens: 4, completion_tokens: 2 },
      finishReason: "length",
    });
  });

  it("normalizes Anthropic usage events", () => {
    expect(
      parseAnthropicChunk({
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
        usage: { output_tokens: 12 },
      }),
    ).toEqual({
      content: "",
      reasoning: "",
      usage: { completion_tokens: 12 },
      finishReason: "max_tokens",
    });
  });

  it("returns configured model pricing and null when unknown", () => {
    expect(priceFor("groq", "unknown-model")).toBeNull();
    expect(priceFor("deepseek", "deepseek-v4-flash")).toEqual({
      prompt: 0.14 / 1e6,
      completion: 0.28 / 1e6,
    });
    expect(priceFor("anthropic", "claude-fable-5")).toEqual({
      prompt: 10 / 1e6,
      completion: 50 / 1e6,
    });
    expect(priceFor("anthropic", "claude-opus-5")).toEqual({
      prompt: 5 / 1e6,
      completion: 25 / 1e6,
    });
    expect(priceFor("anthropic", "claude-opus-4-8")).toEqual({
      prompt: 5 / 1e6,
      completion: 25 / 1e6,
    });
    expect(priceFor("kimi", "kimi-k3")).toEqual({
      prompt: 3 / 1e6,
      completion: 15 / 1e6,
    });
    expect(priceFor("minimax", "MiniMax-M3")).toEqual({
      prompt: 0.3 / 1e6,
      completion: 1.2 / 1e6,
    });
    expect(priceFor("minimax", "MiniMax-M2.7-highspeed")).toEqual({
      prompt: 0.6 / 1e6,
      completion: 2.4 / 1e6,
    });
  });
});
