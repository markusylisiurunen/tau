import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual("@mariozechner/pi-ai");
  return {
    ...actual,
    stream: vi.fn(),
    streamSimple: vi.fn(() => ({})),
  };
});

const { PI_STATIC_INSTRUCTIONS, streamSimple } = await import("@mariozechner/pi-ai");

import { streamModel } from "../dist/core/utils/model_stream.js";

describe("codex system prompt", () => {
  it("prepends the static codex prefix for openai-codex models", () => {
    const context = {
      systemPrompt: "You are tau.",
      messages: [],
      tools: [],
    };

    const model = {
      api: "openai-codex-responses",
      provider: "openai-codex",
      id: "gpt-5.2-codex",
      maxTokens: 128,
      input: [],
    };

    streamModel(model, context, {});
    expect(streamSimple).toHaveBeenCalled();

    const passedContext = streamSimple.mock.calls[0][1];
    expect(passedContext.systemPrompt.startsWith(PI_STATIC_INSTRUCTIONS.trim())).toBe(true);
  });
});
