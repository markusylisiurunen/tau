import { describe, expect, it } from "vitest";
import { loadModelResolver, resolveModel } from "../dist/core/models/catalog.js";

describe("model catalog", () => {
  it("uses remote pi models as the base catalog", () => {
    const bundled = resolveModel("openai", "gpt-5.4");
    const remote = {
      ...bundled,
      name: "Remote GPT-5.4",
      contextWindow: 654321,
      maxTokens: 12345,
    };
    const resolver = loadModelResolver({
      remoteCatalog: new Map([["openai", [remote]]]),
    });

    expect(resolver.resolveModel("openai", "gpt-5.4")).toMatchObject({
      name: "Remote GPT-5.4",
      contextWindow: 654321,
      maxTokens: 12345,
    });
  });

  it("distinguishes catalog models from synthesized model ids", () => {
    const resolver = loadModelResolver();
    expect(resolver.resolveConfiguredModel("openai", "unbundled-model")).toBeUndefined();
    expect(resolver.resolveModel("openai", "unbundled-model")).toMatchObject({
      provider: "openai",
      id: "unbundled-model",
    });
  });
});
