import { describe, expect, it } from "vitest";
import { parseModelId } from "../dist/core/models/model_id.js";

describe("parseModelId", () => {
  it.each([
    ["openai/gpt-5.4", "openai", "gpt-5.4"],
    ["amazon-bedrock/amazon.nova-2-lite-v1:0", "amazon-bedrock", "amazon.nova-2-lite-v1:0"],
    ["openrouter/anthropic/claude-opus-5", "openrouter", "anthropic/claude-opus-5"],
  ])("parses %s without interpreting the model id", (raw, provider, modelId) => {
    expect(parseModelId(raw)).toEqual({ provider, modelId });
  });

  it.each(["", "openai", "/model", "openai/", "openai:model/id", "openai/a b"])(
    "rejects malformed target %s",
    (raw) => {
      expect(parseModelId(raw)).toBeUndefined();
    },
  );
});
