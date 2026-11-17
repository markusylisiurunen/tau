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
    "builds GPT-6.2 personas from the remote catalog for %s",
    (provider) => {
      const template = resolveModel(provider, "gpt-6-luna");
      const models = ["gpt-6.2-astra", "gpt-6.2-sol"].map((id) => ({
        ...template,
        id,
      }));
      const resolver = loadModelResolver({ remoteCatalog: new Map([[provider, models]]) });
      const personas = createBuiltinPersonas(resolver.resolveConfiguredModel);
      for (const model of models) {
        const prefix = provider === "openai-codex" ? `${model.id}-chatgpt` : model.id;
        for (const variant of ["chat", "coder"]) {
          expect(personas.find((p) => p.id === `${prefix}-${variant}`)?.model).toEqual(model);
        }
        if (provider === "openai-codex") {
          const fast = personas.find((p) => p.id === `${prefix}-fast-coder`);
          expect(fast?.model).toEqual(model);
          expect(fast?.settings.serviceTier).toBe("priority");
        }
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
