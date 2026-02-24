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

describe("model catalog", () => {
  it("loads pi-ai providers and models", () => {
    const providers = listProviders();
    expect(providers).toContain("openai");
    expect(providers).toContain("anthropic");

    const openaiModels = listModels("openai");
    expect(openaiModels.some((model) => model.id === "gpt-5.2")).toBe(true);

    const model = resolveModel("openai", "gpt-5.2");
    expect(model).toBeTruthy();
    expect(model.provider).toBe("openai");
    expect(model.id).toBe("gpt-5.2");
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
