import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigLevels } from "../dist/core/config/index.js";
import {
  listModels,
  listProviders,
  loadModelResolver,
  resolveModel,
} from "../dist/core/models/catalog.js";
import { mergeTauProviderExtensionModels } from "../dist/core/models/tau_extensions.js";
import { applyTauModelOverrides } from "../dist/core/models/tau_model_overrides.js";

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

  it("merges Tau model extensions without replacing pi-ai models", () => {
    const piModel = {
      id: "future-model",
      name: "Pi Future Model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
      contextWindow: 999,
      maxTokens: 999,
    };
    const tauModel = {
      id: "tau-only-model",
      name: "Tau Only Model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
      contextWindow: 123000,
      maxTokens: 4000,
    };
    const staleTauModel = { ...tauModel, id: "future-model", name: "Stale Tau Future Model" };

    const merged = mergeTauProviderExtensionModels(
      "openai",
      [piModel],
      [{ id: "openai", models: [staleTauModel, tauModel] }],
    );

    expect(merged.find((model) => model.id === "future-model")).toBe(piModel);
    expect(merged.find((model) => model.id === "tau-only-model")).toBe(tauModel);
  });

  it("loads GPT-5.6 models from pi-ai", () => {
    const sol = resolveModel("openai", "gpt-5.6-sol");
    expect(sol).toBeTruthy();
    expect(sol.provider).toBe("openai");
    expect(sol.api).toBe("openai-responses");
    expect(sol.cost).toEqual({
      input: 5,
      output: 30,
      cacheRead: 0.5,
      cacheWrite: 6.25,
      tiers: [
        {
          inputTokensAbove: 272000,
          input: 10,
          output: 45,
          cacheRead: 1,
          cacheWrite: 12.5,
        },
      ],
    });
    expect(sol.contextWindow).toBe(272000);
    expect(sol.maxTokens).toBe(128000);

    const terra = resolveModel("openai-codex", "gpt-5.6-terra");
    expect(terra).toBeTruthy();
    expect(terra.provider).toBe("openai-codex");
    expect(terra.api).toBe("openai-codex-responses");
    expect(terra.cost).toEqual({
      input: 2,
      output: 12,
      cacheRead: 0.2,
      cacheWrite: 2.5,
      tiers: [
        {
          inputTokensAbove: 272000,
          input: 4,
          output: 18,
          cacheRead: 0.4,
          cacheWrite: 5,
        },
      ],
    });
    expect(terra.contextWindow).toBe(272000);
  });

  it("uses corrected GPT-5.6 Terra and Luna costs across OpenAI providers", () => {
    const expectedCosts = {
      "gpt-5.6-terra": {
        input: 2,
        output: 12,
        cacheRead: 0.2,
        cacheWrite: 2.5,
        tiers: [
          {
            inputTokensAbove: 272000,
            input: 4,
            output: 18,
            cacheRead: 0.4,
            cacheWrite: 5,
          },
        ],
      },
      "gpt-5.6-luna": {
        input: 0.2,
        output: 1.2,
        cacheRead: 0.02,
        cacheWrite: 0.25,
        tiers: [
          {
            inputTokensAbove: 272000,
            input: 0.4,
            output: 1.8,
            cacheRead: 0.04,
            cacheWrite: 0.5,
          },
        ],
      },
    };

    for (const provider of ["openai", "openai-codex"]) {
      for (const [modelId, expectedCost] of Object.entries(expectedCosts)) {
        expect(resolveModel(provider, modelId)?.cost).toEqual(expectedCost);
      }
    }
  });

  it("keeps GPT-5.6 context windows at 272k across OpenAI providers", () => {
    for (const modelId of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(resolveModel("openai-codex", modelId)?.contextWindow).toBe(272000);
      expect(resolveModel("openai", modelId)?.contextWindow).toBe(272000);
    }
  });

  it("keeps the Tau model override hook inert", () => {
    const model = {
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      contextWindow: 272000,
    };

    expect(applyTauModelOverrides(model)).toBe(model);
  });

  it("uses remote pi models as the base catalog", () => {
    const bundled = resolveModel("openai", "gpt-5.4");
    const remote = {
      ...bundled,
      name: "Remote GPT-5.4",
      contextWindow: 654321,
      maxTokens: 12345,
    };
    const deps = {
      fs: {
        readFile: () => "",
        exists: () => false,
        listDir: () => [],
        stat: () => {
          throw new Error("missing");
        },
      },
      env: { getEnv: () => ({}), cwd: () => "/repo", home: () => "/home/user" },
    };

    const resolver = loadModelResolver({
      deps,
      levels: [],
      remoteCatalog: new Map([["openai", [remote]]]),
    });

    expect(resolver.resolveModel("openai", "gpt-5.4")).toMatchObject({
      name: "Remote GPT-5.4",
      contextWindow: 654321,
      maxTokens: 12345,
    });
  });

  it("returns no models for unknown providers", () => {
    expect(listModels("missing-provider")).toEqual([]);
    expect(resolveModel("missing-provider", "missing-model")).toBeUndefined();
  });

  it("loads models.json overlays with config-level precedence", () => {
    const home = mkdtempSync(join(tmpdir(), "tau-model-catalog-home-"));
    const repo = join(home, "repo");
    const nested = join(repo, "packages", "app");

    try {
      mkdirSync(join(home, ".config", "tau"), { recursive: true });
      mkdirSync(join(repo, ".tau"), { recursive: true });
      mkdirSync(nested, { recursive: true });

      writeFileSync(
        join(home, ".config", "tau", "models.json"),
        JSON.stringify(
          {
            providers: {
              openai: {
                headers: {
                  "x-route": "global-provider",
                },
                models: [
                  {
                    id: "gpt-5.9-custom",
                    baseUrl: "https://model.example/v1",
                    headers: {
                      "x-route": "global-model",
                    },
                    contextWindow: 100000,
                    maxTokens: 1000,
                  },
                ],
              },
            },
          },
          null,
          2,
        ),
      );

      writeFileSync(
        join(repo, ".tau", "models.json"),
        JSON.stringify(
          {
            providers: {
              openai: {
                baseUrl: "https://project-provider.example/v1",
                headers: {
                  "x-route": "project-provider",
                  "x-tenant": "project",
                },
                models: [
                  {
                    id: "gpt-5.9-custom",
                    contextWindow: 200000,
                    cost: {
                      tiers: [
                        {
                          inputTokensAbove: 100000,
                          input: 2,
                          output: 4,
                          cacheRead: 0.2,
                          cacheWrite: 2.5,
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
          null,
          2,
        ),
      );

      const deps = {
        fs: {
          readFile: (path) => readFileSync(path, "utf-8"),
          exists: (path) => existsSync(path),
          listDir: (path) => readdirSync(path),
          stat: (path) => statSync(path),
        },
        env: {
          getEnv: () => ({}),
          cwd: () => nested,
          home: () => home,
        },
      };
      const levels = resolveConfigLevels(deps, { cwd: nested });
      const resolver = loadModelResolver({ deps, levels });

      expect(resolver.errors).toEqual([]);
      const model = resolver.resolveModel("openai", "gpt-5.9-custom");
      expect(model).toBeTruthy();
      expect(model.baseUrl).toBe("https://model.example/v1");
      expect(model.headers).toEqual({
        "x-route": "global-model",
        "x-tenant": "project",
      });
      expect(model.contextWindow).toBe(200000);
      expect(model.maxTokens).toBe(1000);
      expect(model.cost.tiers).toEqual([
        {
          inputTokensAbove: 100000,
          input: 2,
          output: 4,
          cacheRead: 0.2,
          cacheWrite: 2.5,
        },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
