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

  it("loads GPT-5.6 models with current first-party pricing", () => {
    const expectedCosts = {
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
    };

    for (const provider of ["openai", "openai-codex"]) {
      for (const [modelId, cost] of Object.entries(expectedCosts)) {
        expect(resolveModel(provider, modelId)?.cost).toEqual(cost);
      }
    }

    expect(resolveModel("cloudflare-ai-gateway", "gpt-5.6-luna")?.cost).toEqual({
      input: 1,
      output: 6,
      cacheRead: 0.1,
      cacheWrite: 0,
    });
  });

  it("overrides GPT-5.6 Codex context windows without changing OpenAI models", () => {
    for (const modelId of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(resolveModel("openai-codex", modelId)?.contextWindow).toBe(372000);
      expect(resolveModel("openai", modelId)?.contextWindow).toBe(272000);
    }
  });

  it("only applies model overrides to the expected pi metadata", () => {
    const codexModel = {
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      contextWindow: 272000,
    };

    expect(applyTauModelOverrides(codexModel)).toEqual({
      ...codexModel,
      contextWindow: 372000,
    });

    for (const unchanged of [
      { ...codexModel, contextWindow: 372000 },
      { ...codexModel, contextWindow: 400000 },
      { ...codexModel, provider: "openai" },
      { ...codexModel, id: "gpt-5.5" },
    ]) {
      expect(applyTauModelOverrides(unchanged)).toBe(unchanged);
    }

    const staleLuna = {
      provider: "openai",
      id: "gpt-5.6-luna",
      cost: {
        input: 1,
        output: 6,
        cacheRead: 0.1,
        cacheWrite: 1.25,
        tiers: [
          {
            inputTokensAbove: 272000,
            input: 2,
            output: 9,
            cacheRead: 0.2,
            cacheWrite: 2.5,
          },
        ],
      },
    };
    const currentLunaCost = {
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
    };

    for (const provider of ["openai", "openai-codex"]) {
      expect(applyTauModelOverrides({ ...staleLuna, provider }).cost).toEqual(currentLunaCost);
    }

    for (const unchanged of [
      { ...staleLuna, provider: "cloudflare-ai-gateway" },
      { ...staleLuna, cost: currentLunaCost },
      { ...staleLuna, cost: { ...staleLuna.cost, input: 0.9 } },
    ]) {
      expect(applyTauModelOverrides(unchanged)).toBe(unchanged);
    }
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
