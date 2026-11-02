import { describe, expect, it } from "vitest";
import {
  listModels,
  listProviders,
  loadModelResolver,
  resolveModel,
} from "../dist/core/models/catalog.js";

describe("model catalog", () => {
  it("loads pi-ai providers and models", () => {
    const providers = listProviders();
    expect(providers).toContain("openai");
    expect(providers).toContain("anthropic");

    const openaiModels = listModels("openai");
    expect(openaiModels.some((model) => model.id === "gpt-5.4")).toBe(true);

    const model = resolveModel("openai", "gpt-5.4");
    expect(model).toBeTruthy();
    expect(model.provider).toBe("openai");
    expect(model.id).toBe("gpt-5.4");
  });

  it("loads Azure models for both supported APIs", () => {
    expect(listProviders()).toContain("azure");
    expect(listProviders()).not.toContain("azure-openai-responses");
    const models = listModels("azure");
    expect(models.some((model) => model.api === "azure-openai-responses")).toBe(true);
    expect(models.some((model) => model.api === "openai-completions")).toBe(true);
    for (const model of models) {
      expect(resolveModel("azure", model.id)).toMatchObject({
        provider: "azure",
        api: model.api,
      });
    }
  });

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

  it("supplements Codex Astra until Pi supplies its metadata", () => {
    const model = resolveModel("openai-codex", "gpt-6.2-astra");
    expect(model).toMatchObject({
      api: "openai-codex-responses",
      provider: "openai-codex",
      contextWindow: 272000,
      maxTokens: 128000,
    });
    expect(resolveModel("openai", "gpt-6.2-astra")).toBeUndefined();
    expect(loadModelResolver().resolveConfiguredModel("openai-codex", model.id)).toEqual(model);

    const remote = { ...model, contextWindow: 400000, cost: { ...model.cost, input: 20 } };
    const resolver = loadModelResolver({
      remoteCatalog: new Map([["openai-codex", [remote]]]),
    });
    expect(resolver.resolveConfiguredModel("openai-codex", model.id)).toEqual(remote);
    expect(model.contextWindow).toBe(272000);
  });

  it("returns no models for unknown providers", () => {
    expect(listModels("missing-provider")).toEqual([]);
    expect(resolveModel("missing-provider", "missing-model")).toBeUndefined();
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
