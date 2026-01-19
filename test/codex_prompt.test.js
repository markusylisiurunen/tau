import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual("@mariozechner/pi-ai");
  return {
    ...actual,
    stream: vi.fn(),
    streamSimple: vi.fn(() => ({})),
  };
});

const { streamSimple } = await import("@mariozechner/pi-ai");

const STATIC_PREFIX =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

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
    expect(passedContext.systemPrompt.startsWith(STATIC_PREFIX)).toBe(true);
  });
});
