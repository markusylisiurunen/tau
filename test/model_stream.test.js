import { describe, expect, test } from "vitest";
import {
  resolveOpenAIReasoningEffort,
  resolveOpenAIServiceTier,
  resolveSimpleStreamOptions,
} from "../dist/core/utils/model_stream.js";

describe("model stream reasoning normalization", () => {
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

  test("preserves explicit none for codex reasoning disable", () => {
    expect(
      resolveOpenAIReasoningEffort(
        {
          api: "openai-codex-responses",
          provider: "openai-codex",
          id: "gpt-5.4",
        },
        "none",
      ),
    ).toBe("none");
  });

  test("drops explicit none for openai responses reasoning disable", () => {
    expect(
      resolveOpenAIReasoningEffort(
        {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
        },
        "none",
      ),
    ).toBeUndefined();
  });

  test("clamps unsupported openai xhigh reasoning to high", () => {
    expect(
      resolveOpenAIReasoningEffort(
        {
          api: "openai-codex-responses",
          provider: "openai-codex",
          id: "gpt-5-mini",
        },
        "xhigh",
      ),
    ).toBe("high");
  });

  test("preserves service tiers in simple stream options", () => {
    expect(resolveSimpleStreamOptions({ serviceTier: "priority" })).toEqual({
      serviceTier: "priority",
    });
  });

  test("passes through supported openai service tiers", () => {
    expect(resolveOpenAIServiceTier("priority")).toBe("priority");
    expect(resolveOpenAIServiceTier("flex")).toBe("flex");
  });
});
