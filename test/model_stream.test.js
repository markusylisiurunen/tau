import { describe, expect, test } from "vitest";
import {
  resolveCodexReasoningEffort,
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
      resolveCodexReasoningEffort(
        {
          api: "openai-codex-responses",
          provider: "openai-codex",
          id: "gpt-5.4",
        },
        "none",
      ),
    ).toBe("none");
  });

  test("clamps unsupported codex xhigh reasoning to high", () => {
    expect(
      resolveCodexReasoningEffort(
        {
          api: "openai-codex-responses",
          provider: "openai-codex",
          id: "gpt-5-mini",
        },
        "xhigh",
      ),
    ).toBe("high");
  });
});
