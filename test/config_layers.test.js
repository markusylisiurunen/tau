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
import { builtinThemes } from "../dist/core/config/builtin_themes.js";
import { resolveConfigLevels } from "../dist/core/config/paths.js";
import { loadRuntimeConfig } from "../dist/core/config/runtime.js";
import {
  getApiKeyForProvider,
  getOpenAIApiKey,
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

  it("uses the built-in theme catalog across configuration levels", async () => {
    const fx = setupFixture();

    try {
      const repo = join(fx.home, "repo");
      for (const directory of [join(fx.home, ".config", "tau"), join(repo, ".tau")]) {
        mkdirSync(join(directory, "themes"), { recursive: true });
        writeFileSync(join(directory, "themes", "gold.json"), "invalid JSON");
        writeFileSync(join(directory, "themes", "extra.json"), "{}");
      }
      writeFileSync(join(repo, ".tau", "config.json"), '{"defaultTheme":"azure"}');
      const deps = createConfigDeps({ cwd: repo, home: fx.home, env: {} });
      const inspectedPaths = [];
      for (const [name, operation] of Object.entries(deps.fs)) {
        deps.fs[name] = (path) => {
          inspectedPaths.push(path);
          return operation(path);
        };
      }

      const runtime = await loadRuntimeConfig(repo, deps);

      expect(runtime.themes).toEqual(builtinThemes);
      expect(runtime.config.defaultTheme).toBe("azure");
      expect(runtime.warnings).toEqual([]);
      expect(inspectedPaths.some((path) => path.includes("/themes"))).toBe(false);
      expect(runtime.prompts).toEqual([]);
      expect(runtime.skills).toEqual([]);
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
          apiKeys: { openai: "global", anthropic: "anthropic-key", mistral: "mistral-key" },
          speech: { voiceId: "global-voice" },
          agentContextFiles: ["AGENTS.md"],
          subagents: {
            defaultLaunchModels: ["anthropic/claude-haiku-4-5:low"],
          },
          history: {
            endpoint: "https://history.example.com/",
            apiKeyEnv: "HISTORY_KEY",
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
          modelSystemNotices: {
            "openai/gpt-5.4": "global codex notice",
            "anthropic/claude-sonnet-4-5": "global anthropic notice",
          },
        }),
      );

      writeFileSync(
        join(repo, ".tau", "config.json"),
        JSON.stringify({
          apiKeys: { openai: "repo", google: "google-key" },
          speech: { voiceId: " project-voice " },
          agentContextFiles: ["docs/AGENTS.md"],
          subagents: {
            defaultLaunchModels: ["openai/gpt-5.4:high"],
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
      expect(config.defaultPersona).toBe("custom-persona");
      expect(config.speech).toEqual({ voiceId: "project-voice" });
      expect(config.apiKeys).toEqual({
        openai: "repo",
        anthropic: "anthropic-key",
        google: "google-key",
        mistral: "mistral-key",
      });
      expect(config.agentContextFiles).toEqual([
        join(fx.home, "AGENTS.md"),
        join(repo, "docs", "AGENTS.md"),
        join(nested, "AGENTS.md"),
      ]);
      expect(config.subagents).toEqual({
        defaultLaunchModels: ["openai/gpt-5.4:high"],
      });
      expect(config.history).toEqual({
        endpoint: "https://history.example.com",
        apiKeyEnv: "HISTORY_KEY",
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
        defaultPersona: "sonnet-5.5-coder",
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
        defaultPersona: "sonnet-5.5-coder",
      });
      expect(result.errors.length).toBeGreaterThan(0);
    } finally {
      fx.cleanup();
    }
  });

  it.each([null, "voice", { voiceId: " " }, { voiceId: 42 }])(
    "rejects invalid speech configuration %j",
    (speech) => {
      const fx = setupFixture();
      try {
        mkdirSync(join(fx.repo, ".tau"), { recursive: true });
        writeFileSync(join(fx.repo, ".tau", "config.json"), JSON.stringify({ speech }));
        const deps = createConfigDeps({ cwd: fx.repo, home: fx.home, env: {} });
        const levels = resolveConfigLevels(deps, { cwd: fx.repo });
        const modelResolver = loadModelResolver({ deps, levels });
        const result = loadConfigWithDiagnostics(deps, { levels, modelResolver });
        expect(result.config.speech).toBeUndefined();
        expect(result.errors.length).toBeGreaterThan(0);
      } finally {
        fx.cleanup();
      }
    },
  );

  it("keeps valid scalar fields while reporting invalid scalar fields", () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({
          speech: "invalid",
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
      expect(result.config.speech).toBeUndefined();
      expect(result.config.defaultTheme).toBe("midnight");
      expect(result.errors.length).toBeGreaterThan(0);
    } finally {
      fx.cleanup();
    }
  });

  it("rejects credentials in remote history endpoints", () => {
    const fx = setupFixture();

    try {
      const repo = join(fx.home, "repo");
      const configPath = join(fx.home, ".config", "tau", "config.json");
      mkdirSync(repo, { recursive: true });
      mkdirSync(join(fx.home, ".config", "tau"), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          history: {
            endpoint: "https://user:secret@history.example.com",
            apiKey: "history-key",
          },
        }),
      );

      const deps = createConfigDeps({ cwd: repo, home: fx.home, env: {} });
      const levels = resolveConfigLevels(deps, { cwd: repo });
      const modelResolver = loadModelResolver({ deps, levels });
      const result = loadConfigWithDiagnostics(deps, { levels, modelResolver });

      expect(result.config.history).toBeUndefined();
      expect(result.errors).toEqual([
        `${configPath}: history.endpoint must be an HTTP(S) URL without credentials, a query, or a hash.`,
      ]);
      expect(result.errors.join("\n")).not.toContain("secret");
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

  it("prefers OPENAI_API_KEY for OpenAI speech transcription", () => {
    expect(
      getOpenAIApiKey(
        { apiKeys: { openai: "configured-openai-key" } },
        { OPENAI_API_KEY: "environment-openai-key" },
      ),
    ).toBe("environment-openai-key");
    expect(getOpenAIApiKey({ apiKeys: { openai: "configured-openai-key" } }, {})).toBe(
      "configured-openai-key",
    );
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

  it("strips unknown top-level config keys", () => {
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

      expect(result.config).not.toHaveProperty("async");
      expect(result.errors).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it("ignores removed configuration fields", () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({
          disableBuiltinPersonas: true,
          autoCompact: { enabled: false, reserveTokens: 1000 },
          builtInDiffTool: { codeTheme: "dark-plus" },
          diffTool: { command: "./tools/review-ui" },
        }),
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

      expect(result.config).not.toHaveProperty("disableBuiltinPersonas");
      expect(result.config).not.toHaveProperty("autoCompact");
      expect(result.config).not.toHaveProperty("builtInDiffTool");
      expect(result.config).not.toHaveProperty("diffTool");
      expect(result.errors).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });
});
