import { describe, expect, it } from "vitest";
import { loadModelResolver, resolveModel } from "../dist/core/models/catalog.js";
import { createBuiltinPersonas } from "../dist/core/personas.js";

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

  it.each(["openai", "openai-codex"])(
    "resolves both GPT-6.2 models and their personas for %s before a catalog refresh",
    (provider) => {
      const resolver = loadModelResolver();
      const personas = createBuiltinPersonas(resolver.resolveConfiguredModel);
      for (const family of ["astra", "sol"]) {
        const id = `gpt-6.2-${family}`;
        const model = resolver.resolveConfiguredModel(provider, id);
        expect(model).toMatchObject({
          id,
          provider,
          reasoning: true,
          cost:
            family === "astra"
              ? { input: 8, output: 40, cacheRead: 0.4 }
              : { input: 2, output: 10, cacheRead: 0.1 },
          maxTokens: 128000,
        });
        const prefix = provider === "openai-codex" ? `${id}-chatgpt` : id;
        for (const variant of ["chat", "coder"]) {
          expect(personas.find((p) => p.id === `${prefix}-${variant}`)?.model.id).toBe(id);
        }
        if (provider === "openai-codex") {
          expect(personas.find((p) => p.id === `${prefix}-fast-coder`)?.settings.serviceTier).toBe(
            "priority",
          );
        }
        const remote = { ...model, contextWindow: 654321 };
        const refreshed = loadModelResolver({ remoteCatalog: new Map([[provider, [remote]]]) });
        expect(refreshed.resolveConfiguredModel(provider, id)?.contextWindow).toBe(654321);
      }
    },
  );

  it("distinguishes catalog models from synthesized model ids", () => {
    const resolver = loadModelResolver();
    expect(resolver.resolveConfiguredModel("openai", "unbundled-model")).toBeUndefined();
    expect(resolver.resolveModel("openai", "unbundled-model")).toMatchObject({
      provider: "openai",
      id: "unbundled-model",
    });
  });
});
