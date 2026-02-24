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
          sandbox: { image: "sandbox-base" },
          bashCommands: [{ id: "check", cmd: "npm run check" }],
          agentContextFiles: ["AGENTS.md"],
          subagents: {
            defaultLaunchModels: ["anthropic/claude-haiku-4-5:low"],
          },
          modelSystemNotices: {
            "openai/gpt-5.2": "global codex notice",
            "anthropic/claude-sonnet-4-5": "global anthropic notice",
          },
        }),
      );

      writeFileSync(
        join(repo, ".tau", "config.json"),
        JSON.stringify({
          defaultRisk: "read-write",
          apiKeys: { openai: "repo", google: "google-key" },
          sandbox: { pruneAfterHours: 12 },
          bashCommands: [
            { id: "check", cmd: "repo check" },
            { id: "test", cmd: "repo test" },
          ],
          agentContextFiles: ["docs/AGENTS.md"],
          subagents: {
            defaultLaunchModels: ["openai/gpt-5.2:high"],
          },
          modelSystemNotices: {
            "openai/gpt-5.2": "repo codex notice",
          },
        }),
      );

      writeFileSync(
        join(nested, ".tau", "config.json"),
        JSON.stringify({
          defaultPersona: "custom-persona",
          sandbox: { mountPath: "/workspace", extraDockerArgs: ["--network=none"] },
          bashCommands: [{ id: "test", cmd: "nested test" }],
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
      expect(config.sandbox).toEqual({
        image: "sandbox-base",
        pruneAfterHours: 12,
        mountPath: "/workspace",
        extraDockerArgs: ["--network=none"],
      });
      expect(config.bashCommands).toEqual([
        { id: "check", cmd: "repo check", cwd: repo },
        { id: "test", cmd: "nested test", cwd: nested },
      ]);
      expect(config.agentContextFiles).toEqual([
        join(fx.home, "AGENTS.md"),
        join(repo, "docs", "AGENTS.md"),
        join(nested, "AGENTS.md"),
      ]);
      expect(config.subagents).toEqual({
        defaultLaunchModels: ["openai/gpt-5.2:high"],
      });
      expect(config.modelSystemNotices).toEqual({
        "openai/gpt-5.2": "repo codex notice",
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
        defaultPersona: "opus-4.6-chat",
        defaultRisk: "read-only",
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

      const result = loadConfigWithDiagnostics(fx.repo, deps);
      expect(result.config).toMatchObject({
        defaultPersona: "opus-4.6-chat",
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

      const result = loadConfigWithDiagnostics(fx.repo, deps);
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

  it("accepts defaultLaunchModels for known providers even when model id is not bundled", () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({
          subagents: {
            defaultLaunchModels: ["openai/gpt-5.9-custom:high"],
          },
        }),
      );

      const deps = createConfigDeps({
        cwd: fx.repo,
        home: fx.home,
        env: {},
      });

      const result = loadConfigWithDiagnostics(fx.repo, deps);
      expect(result.errors).toEqual([]);
      expect(result.config.subagents.defaultLaunchModels).toEqual(["openai/gpt-5.9-custom:high"]);
    } finally {
      fx.cleanup();
    }
  });

  it("merges async client config targets by key", () => {
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
          async: {
            client: {
              defaultTarget: "global",
              defaultProjectId: "global-project",
              targets: {
                global: { url: "http://global", token: "global-token", timeoutMs: 5000 },
              },
            },
          },
        }),
      );

      writeFileSync(
        join(repo, ".tau", "config.json"),
        JSON.stringify({
          async: {
            client: {
              defaultTarget: "repo",
              defaultProjectId: "repo-project",
              targets: {
                repo: { url: "http://repo", token: "repo-token" },
              },
            },
          },
        }),
      );

      const deps = createConfigDeps({
        cwd: nested,
        home: fx.home,
        env: {},
      });

      const config = loadConfig(nested, deps);
      expect(config.async).toEqual({
        client: {
          defaultTarget: "repo",
          defaultProjectId: "repo-project",
          targets: {
            global: { url: "http://global", token: "global-token", timeoutMs: 5000 },
            repo: { url: "http://repo", token: "repo-token" },
          },
        },
      });
    } finally {
      fx.cleanup();
    }
  });
});
