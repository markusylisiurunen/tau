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
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigLevels } from "../dist/core/config/paths.js";
import {
  getApiKeyForProvider,
  loadConfig,
  loadConfigWithDiagnostics,
} from "../dist/core/config/schema.js";
import { loadModelResolver } from "../dist/core/models/catalog.js";

function createConfigDeps({ cwd, home, env }) {
  return {
    fs: {
      readFile: (path) => readFileSync(path, "utf-8"),
      exists: (path) => existsSync(path),
      listDir: (path) => readdirSync(path),
      stat: (path) => statSync(path),
    },
    env: {
      getEnv: () => env,
      cwd: () => cwd,
      home: () => home,
    },
  };
}

function setupFixture() {
  const home = mkdtempSync(join(tmpdir(), "tau-config-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tau-config-repo-"));

  return {
    home: resolve(home),
    repo: resolve(repo),
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

describe("config paths", () => {
  it("includes global and .tau levels ordered from least to most specific", () => {
    const fx = setupFixture();

    try {
      const repo = join(fx.home, "repo");
      const pkg = join(repo, "packages", "pkg1");
      mkdirSync(join(repo, ".tau"), { recursive: true });
      mkdirSync(join(pkg, ".tau"), { recursive: true });

      const deps = createConfigDeps({
        cwd: pkg,
        home: fx.home,
        env: {},
      });

      const levels = resolveConfigLevels(deps, { cwd: pkg });
      expect(levels.map((level) => level.configDir)).toEqual([
        join(fx.home, ".config", "tau"),
        join(repo, ".tau"),
        join(pkg, ".tau"),
      ]);
    } finally {
      fx.cleanup();
    }
  });

  it("merges levels with most-specific wins", () => {
    const fx = setupFixture();

    try {
      const repo = join(fx.home, "repo");
      const nested = join(repo, "packages", "pkg1");
      mkdirSync(nested, { recursive: true });
      mkdirSync(join(fx.home, ".config", "tau"), { recursive: true });
      mkdirSync(join(repo, ".tau"), { recursive: true });
      mkdirSync(join(nested, ".tau"), { recursive: true });

      writeFileSync(
        join(fx.home, ".config", "tau", "config.json"),
        JSON.stringify({
          defaultRisk: "read-only",
          apiKeys: { openai: "global", anthropic: "anthropic-key", mistral: "mistral-key" },
          diffTool: {
            command: "./scripts/global-diff-tool",
            args: ["--global"],
            env: { GLOBAL_ONLY: "1" },
          },
          agentContextFiles: ["AGENTS.md"],
          subagents: {
            defaultLaunchModels: ["anthropic/claude-haiku-4-5:low"],
          },
          speechToText: { provider: "mistral" },
          cloudflareSandbox: {
            bridges: {
              default: {
                url: "https://global.example.workers.dev",
                apiKeyEnv: "GLOBAL_SANDBOX_KEY",
              },
              shared: {
                url: "https://shared.example.workers.dev",
              },
            },
          },
          flySprites: {
            apis: {
              default: {
                baseURL: "https://api.sprites.dev",
                tokenEnv: "GLOBAL_SPRITES_TOKEN",
              },
              shared: {
                tokenEnv: "SHARED_SPRITES_TOKEN",
              },
            },
          },
          autoCompact: { enabled: false, reserveTokens: 1000 },
          modelSystemNotices: {
            "openai/gpt-5.4": "global codex notice",
            "anthropic/claude-sonnet-4-5": "global anthropic notice",
          },
        }),
      );

      writeFileSync(
        join(repo, ".tau", "config.json"),
        JSON.stringify({
          defaultRisk: "read-write",
          apiKeys: { openai: "repo", google: "google-key" },
          diffTool: {
            command: "./scripts/repo-diff-tool",
            args: ["--repo"],
            env: { REPO_ONLY: "1" },
          },
          agentContextFiles: ["docs/AGENTS.md"],
          subagents: {
            defaultLaunchModels: ["openai/gpt-5.4:high"],
          },
          speechToText: { provider: "gemini" },
          cloudflareSandbox: {
            bridges: {
              default: {
                url: "https://repo.example.workers.dev",
                apiKeyEnv: "REPO_SANDBOX_KEY",
                home: "/home/sandbox",
              },
            },
          },
          flySprites: {
            apis: {
              default: {
                baseURL: "https://repo.sprites.example",
                tokenEnv: "REPO_SPRITES_TOKEN",
                home: "/home/sprite",
              },
            },
          },
          autoCompact: { keepRecentTokens: 2000 },
          modelSystemNotices: {
            "openai/gpt-5.4": "repo codex notice",
          },
        }),
      );

      writeFileSync(
        join(nested, ".tau", "config.json"),
        JSON.stringify({
          defaultPersona: "custom-persona",
          agentContextFiles: ["AGENTS.md"],
        }),
      );

      const deps = createConfigDeps({
        cwd: nested,
        home: fx.home,
        env: {},
      });

      const config = loadConfig(nested, deps);
      expect(config.defaultRisk).toBe("read-write");
      expect(config.defaultPersona).toBe("custom-persona");
      expect(config.apiKeys).toEqual({
        openai: "repo",
        anthropic: "anthropic-key",
        google: "google-key",
        mistral: "mistral-key",
      });
      expect(config.diffTool).toEqual({
        command: join(repo, "scripts", "repo-diff-tool"),
        args: ["--repo"],
        env: { REPO_ONLY: "1" },
      });
      expect(config.agentContextFiles).toEqual([
        join(fx.home, "AGENTS.md"),
        join(repo, "docs", "AGENTS.md"),
        join(nested, "AGENTS.md"),
      ]);
      expect(config.subagents).toEqual({
        defaultLaunchModels: ["openai/gpt-5.4:high"],
      });
      expect(config.speechToText).toEqual({ provider: "gemini" });
      expect(config.cloudflareSandbox).toEqual({
        bridges: {
          default: {
            url: "https://repo.example.workers.dev",
            apiKeyEnv: "REPO_SANDBOX_KEY",
            home: "/home/sandbox",
          },
          shared: {
            url: "https://shared.example.workers.dev",
          },
        },
      });
      expect(config.flySprites).toEqual({
        apis: {
          default: {
            baseURL: "https://repo.sprites.example",
            tokenEnv: "REPO_SPRITES_TOKEN",
            home: "/home/sprite",
          },
          shared: {
            tokenEnv: "SHARED_SPRITES_TOKEN",
          },
        },
      });
      expect(config.autoCompact).toEqual({
        enabled: false,
        reserveTokens: 1000,
        keepRecentTokens: 2000,
      });
      expect(config.modelSystemNotices).toEqual({
        "openai/gpt-5.4": "repo codex notice",
        "anthropic/claude-sonnet-4-5": "global anthropic notice",
      });
    } finally {
      fx.cleanup();
    }
  });

  it("uses virtual defaults when no config files exist", () => {
    const fx = setupFixture();

    try {
      const deps = createConfigDeps({
        cwd: fx.repo,
        home: fx.home,
        env: {},
      });

      const config = loadConfig(fx.repo, deps);
      expect(config).toMatchObject({
        defaultPersona: "opus-4.8-chat",
        defaultRisk: "read-only",
        autoCompact: {
          enabled: true,
          reserveTokens: 16384,
          keepRecentTokens: 20000,
        },
      });
    } finally {
      fx.cleanup();
    }
  });

  it("reports parse errors without throwing", () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(join(fx.repo, ".tau", "config.json"), "{invalid json");

      const deps = createConfigDeps({
        cwd: fx.repo,
        home: fx.home,
        env: {},
      });

      const levels = resolveConfigLevels(deps, { cwd: fx.repo });
      const modelResolver = loadModelResolver({ deps, levels });
      const result = loadConfigWithDiagnostics(deps, { levels, modelResolver });
      expect(result.config).toMatchObject({
        defaultPersona: "opus-4.8-chat",
        defaultRisk: "read-only",
      });
      expect(result.errors.length).toBeGreaterThan(0);
    } finally {
      fx.cleanup();
    }
  });

  it("keeps valid scalar fields while reporting invalid scalar fields", () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({
          defaultRisk: "invalid",
          disableBuiltinPersonas: true,
          disableBuiltinThemes: "yes",
          defaultTheme: " midnight ",
        }),
      );

      const deps = createConfigDeps({
        cwd: fx.repo,
        home: fx.home,
        env: {},
      });

      const levels = resolveConfigLevels(deps, { cwd: fx.repo });
      const modelResolver = loadModelResolver({ deps, levels });
      const result = loadConfigWithDiagnostics(deps, { levels, modelResolver });
      expect(result.config.defaultRisk).toBe("read-only");
      expect(result.config.disableBuiltinPersonas).toBe(true);
      expect(result.config.disableBuiltinThemes).toBeUndefined();
      expect(result.config.defaultTheme).toBe("midnight");
      expect(result.errors).toContain(
        `${join(fx.repo, ".tau", "config.json")}: 'defaultRisk' must be a valid risk level.`,
      );
      expect(result.errors).toContain(
        `${join(fx.repo, ".tau", "config.json")}: 'disableBuiltinThemes' must be a boolean.`,
      );
    } finally {
      fx.cleanup();
    }
  });

  it("merges api keys for arbitrary providers", () => {
    const fx = setupFixture();

    try {
      const repo = join(fx.home, "repo");
      const nested = join(repo, "packages", "pkg1");
      mkdirSync(nested, { recursive: true });
      mkdirSync(join(fx.home, ".config", "tau"), { recursive: true });
      mkdirSync(join(repo, ".tau"), { recursive: true });

      writeFileSync(
        join(fx.home, ".config", "tau", "config.json"),
        JSON.stringify({
          apiKeys: {
            openai: "global-openai",
            "custom-provider": "global-custom",
          },
        }),
      );

      writeFileSync(
        join(repo, ".tau", "config.json"),
        JSON.stringify({
          apiKeys: {
            "custom-provider": "repo-custom",
            "another-provider": "repo-another",
          },
        }),
      );

      const deps = createConfigDeps({
        cwd: nested,
        home: fx.home,
        env: {},
      });

      const config = loadConfig(nested, deps);
      expect(config.apiKeys).toEqual({
        openai: "global-openai",
        "custom-provider": "repo-custom",
        "another-provider": "repo-another",
      });
      expect(getApiKeyForProvider(config, "custom-provider")).toBe("repo-custom");
      expect(getApiKeyForProvider(config, "another-provider")).toBe("repo-another");
      expect(getApiKeyForProvider(config, "openai")).toBe("global-openai");
    } finally {
      fx.cleanup();
    }
  });

  it("rejects modelSystemNotices for unknown model ids", () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({
          modelSystemNotices: {
            "openai/gpt-5.9-custom": "custom notice",
          },
        }),
      );

      const deps = createConfigDeps({
        cwd: fx.repo,
        home: fx.home,
        env: {},
      });

      const levels = resolveConfigLevels(deps, { cwd: fx.repo });
      const modelResolver = loadModelResolver({ deps, levels });
      const result = loadConfigWithDiagnostics(deps, { levels, modelResolver });

      expect(result.config.modelSystemNotices).toBeUndefined();
      expect(result.errors).toContain(
        `${join(fx.repo, ".tau", "config.json")}: modelSystemNotices.openai/gpt-5.9-custom unknown model 'openai/gpt-5.9-custom'.`,
      );
    } finally {
      fx.cleanup();
    }
  });

  it("reports unknown top-level config keys", () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({ async: { client: {} } }),
        "utf-8",
      );

      const deps = createConfigDeps({
        cwd: fx.repo,
        home: fx.home,
        env: {},
      });

      const levels = resolveConfigLevels(deps, { cwd: fx.repo });
      const modelResolver = loadModelResolver({ deps, levels });
      const result = loadConfigWithDiagnostics(deps, { levels, modelResolver });

      expect(result.errors).toContain(
        `${join(fx.repo, ".tau", "config.json")}: unknown key in config: async.`,
      );
    } finally {
      fx.cleanup();
    }
  });

  it("reports unknown autoCompact keys", () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({ autoCompact: { reserveTokens: 1000, bogus: true } }),
        "utf-8",
      );

      const deps = createConfigDeps({
        cwd: fx.repo,
        home: fx.home,
        env: {},
      });

      const levels = resolveConfigLevels(deps, { cwd: fx.repo });
      const modelResolver = loadModelResolver({ deps, levels });
      const result = loadConfigWithDiagnostics(deps, { levels, modelResolver });

      expect(result.errors).toContain(
        `${join(fx.repo, ".tau", "config.json")}: unknown key in autoCompact: bogus.`,
      );
    } finally {
      fx.cleanup();
    }
  });
});
