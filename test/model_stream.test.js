import { describe, expect, test } from "vitest";
import {
  resolveOpenAICodexCachedWebSocketFallbackOptions,
  resolveOpenAIResponsesOptions,
  resolveSimpleStreamOptions,
} from "../dist/core/utils/model_stream.js";

function createAssistantError() {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.4",
    stopReason: "error",
    timestamp: Date.now(),
  };
}

describe("model stream option resolution", () => {
  test("drops disabled reasoning for simple stream options", () => {
    expect(
      resolveSimpleStreamOptions({
        reasoning: "none",
        maxTokens: 123,
        interleavedThinking: true,
      }),
    ).toEqual({
      maxTokens: 123,
      interleavedThinking: true,
    });
  });

  test("builds openai responses options with disabled reasoning and service tier", () => {
    expect(
      resolveOpenAIResponsesOptions(
        {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
        },
        {
          reasoning: "none",
          serviceTier: "priority",
          maxTokens: 123,
        },
      ),
    ).toEqual({
      reasoningEffort: "none",
      serviceTier: "priority",
      maxTokens: 123,
    });
  });

  test("builds openai codex options with disabled reasoning and service tier", () => {
    expect(
      resolveOpenAIResponsesOptions(
        {
          api: "openai-codex-responses",
          provider: "openai-codex",
          id: "gpt-5.4",
        },
        {
          reasoning: "none",
          serviceTier: "flex",
          maxTokens: 456,
        },
      ),
    ).toEqual({
      transport: "websocket-cached",
      reasoningEffort: "none",
      serviceTier: "flex",
      maxTokens: 456,
    });
  });

  test("preserves explicit openai codex transport", () => {
    expect(
      resolveOpenAIResponsesOptions(
        {
          api: "openai-codex-responses",
          provider: "openai-codex",
          id: "gpt-5.4",
        },
        {
          transport: "sse",
        },
      ),
    ).toEqual({
      transport: "sse",
    });
  });

  test("clamps unsupported openai xhigh reasoning in response options", () => {
    expect(
      resolveOpenAIResponsesOptions(
        {
          api: "openai-codex-responses",
          provider: "openai-codex",
          id: "gpt-5-mini",
        },
        {
          reasoning: "xhigh",
          serviceTier: "priority",
        },
      ),
    ).toEqual({
      transport: "websocket-cached",
      reasoningEffort: "high",
      serviceTier: "priority",
    });
  });

  test("falls back from cached codex websocket to sse before provider events", () => {
    expect(
      resolveOpenAICodexCachedWebSocketFallbackOptions({
        model: {
          api: "openai-codex-responses",
          provider: "openai-codex",
          id: "gpt-5.4",
        },
        options: {
          transport: "websocket-cached",
          reasoning: "medium",
          serviceTier: "priority",
        },
        result: createAssistantError(),
        receivedProviderEvent: false,
      }),
    ).toEqual({
      transport: "sse",
      reasoning: "medium",
      serviceTier: "priority",
    });
  });

  test("does not fall back after cached codex websocket provider events", () => {
    expect(
      resolveOpenAICodexCachedWebSocketFallbackOptions({
        model: {
          api: "openai-codex-responses",
          provider: "openai-codex",
          id: "gpt-5.4",
        },
        options: { transport: "websocket-cached" },
        result: createAssistantError(),
        receivedProviderEvent: true,
      }),
    ).toBeUndefined();
  });
});
