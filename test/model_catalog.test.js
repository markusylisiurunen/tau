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
    expect(sol.cost).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 });
    expect(sol.contextWindow).toBe(1050000);
    expect(sol.maxTokens).toBe(128000);

    const terra = resolveModel("openai-codex", "gpt-5.6-terra");
    expect(terra).toBeTruthy();
    expect(terra.provider).toBe("openai-codex");
    expect(terra.api).toBe("openai-codex-responses");
    expect(terra.cost).toEqual({ input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 });
    expect(terra.contextWindow).toBe(272000);
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
                models: [
                  {
                    id: "gpt-5.9-custom",
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
                models: [
                  {
                    id: "gpt-5.9-custom",
                    contextWindow: 200000,
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
      expect(model.contextWindow).toBe(200000);
      expect(model.maxTokens).toBe(1000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
