import { describe, expect, test } from "vitest";
import {
  resolveOpenAIResponsesOptions,
  resolveSimpleStreamOptions,
} from "../dist/core/utils/model_stream.js";

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
      transport: "websocket",
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
      transport: "websocket",
      reasoningEffort: "high",
      serviceTier: "priority",
    });
  });
});
