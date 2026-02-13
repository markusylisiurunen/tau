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
  getMistralApiKey,
  getParallelApiKey,
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

  it("stops at filesystem root when cwd is outside home", () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.repo, ".tau"), { recursive: true });

      const deps = createConfigDeps({
        cwd: fx.repo,
        home: fx.home,
        env: {},
      });

      const levels = resolveConfigLevels(deps, { cwd: fx.repo });
      expect(levels.map((level) => level.configDir)).toEqual([join(fx.repo, ".tau")]);
    } finally {
      fx.cleanup();
    }
  });
});

describe("loadConfig", () => {
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

  it("reports sandbox validation errors", () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({
          sandbox: {
            pruneAfterHours: -1,
            extraDockerArgs: [1, "ok"],
            mountPath: "",
          },
        }),
      );

      const deps = createConfigDeps({
        cwd: fx.repo,
        home: fx.home,
        env: {},
      });

      const result = loadConfigWithDiagnostics(fx.repo, deps);
      expect(result.errors.length).toBeGreaterThan(0);
    } finally {
      fx.cleanup();
    }
  });

  it("validates subagents.defaultLaunchModels", () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({
          subagents: {
            defaultLaunchModels: ["openai/gpt-5.2", "openai/gpt-5.2:invalid"],
          },
        }),
      );

      const deps = createConfigDeps({
        cwd: fx.repo,
        home: fx.home,
        env: {},
      });

      const result = loadConfigWithDiagnostics(fx.repo, deps);
      expect(result.config.subagents).toBeUndefined();
      expect(result.errors.some((error) => error.includes("subagents.defaultLaunchModels"))).toBe(
        true,
      );
    } finally {
      fx.cleanup();
    }
  });

  it("merges async config and resolves project workspace roots by config level", () => {
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
              targets: {
                global: { url: "http://global", token: "global-token", timeoutMs: 5000 },
              },
            },
            server: {
              host: "127.0.0.1",
              port: 7788,
              maxSessions: 2,
              telegram: {
                allowedUserIds: [1],
                allowedChatIds: [10],
              },
            },
            projects: {
              alpha: {
                repo: "git@example.com:alpha.git",
                workspaceRoot: "global-alpha",
                bootstrapCommands: ["echo global"],
                sandbox: true,
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
              targets: {
                repo: { url: "http://repo", token: "repo-token" },
              },
            },
            server: {
              telegram: {
                allowedUserIds: [2, 3],
              },
            },
            projects: {
              alpha: {
                repo: "git@example.com:alpha.git",
                workspaceRoot: "repo-alpha",
                bootstrapCommands: ["echo repo"],
              },
              beta: {
                repo: "git@example.com:beta.git",
                workspaceRoot: "repo-beta",
              },
            },
          },
        }),
      );

      writeFileSync(
        join(nested, ".tau", "config.json"),
        JSON.stringify({
          async: {
            projects: {
              alpha: {
                repo: "git@example.com:alpha.git",
                bootstrapCommands: [],
                persona: "custom-persona",
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
          targets: {
            global: { url: "http://global", token: "global-token", timeoutMs: 5000 },
            repo: { url: "http://repo", token: "repo-token" },
          },
        },
        server: {
          host: "127.0.0.1",
          port: 7788,
          maxSessions: 2,
          telegram: {
            allowedUserIds: [2, 3],
            allowedChatIds: [10],
          },
        },
        projects: {
          alpha: {
            repo: "git@example.com:alpha.git",
            workspaceRoot: join(repo, "repo-alpha"),
            bootstrapCommands: [],
            sandbox: true,
            persona: "custom-persona",
          },
          beta: {
            repo: "git@example.com:beta.git",
            workspaceRoot: join(repo, "repo-beta"),
          },
        },
      });
    } finally {
      fx.cleanup();
    }
  });

  it("reports async validation errors", () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({
          async: {
            client: {
              defaultTarget: 1,
              targets: {
                bad: {
                  url: "",
                  token: "",
                  timeoutMs: 0,
                },
              },
            },
            server: {
              port: 70000,
              maxSessions: 0,
              telegram: {
                allowedUserIds: [1.2],
                allowedChatIds: [Infinity],
                pollIntervalMs: 0,
                requestTimeoutSeconds: 0,
              },
            },
            projects: {
              alpha: {
                repo: "",
                bootstrapCommands: [],
              },
            },
          },
        }),
      );

      const deps = createConfigDeps({
        cwd: fx.repo,
        home: fx.home,
        env: {},
      });

      const result = loadConfigWithDiagnostics(fx.repo, deps);
      expect(result.config.async).toBeUndefined();
      expect(result.errors.some((error) => error.includes("async.client.defaultTarget"))).toBe(
        true,
      );
      expect(result.errors.some((error) => error.includes("async.server.port"))).toBe(true);
      expect(result.errors.some((error) => error.includes("async.projects.alpha.repo"))).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("prefers MISTRAL_API_KEY over apiKeys.mistral", () => {
    const config = { apiKeys: { mistral: "config-mistral" } };

    expect(getMistralApiKey(config, { MISTRAL_API_KEY: "env-mistral" })).toBe("env-mistral");
    expect(getMistralApiKey(config, {})).toBe("config-mistral");
  });

  it("uses the injected env map when resolving MISTRAL_API_KEY", () => {
    const previous = process.env.MISTRAL_API_KEY;
    process.env.MISTRAL_API_KEY = "process-mistral";

    try {
      const config = { apiKeys: { mistral: "config-mistral" } };
      expect(getMistralApiKey(config, {})).toBe("config-mistral");
      expect(getMistralApiKey(config)).toBe("process-mistral");
    } finally {
      if (previous === undefined) {
        delete process.env.MISTRAL_API_KEY;
      } else {
        process.env.MISTRAL_API_KEY = previous;
      }
    }
  });

  it("prefers PARALLEL_API_KEY over apiKeys.parallel", () => {
    const config = { apiKeys: { parallel: "config-parallel" } };

    expect(getParallelApiKey(config, { PARALLEL_API_KEY: "env-parallel" })).toBe("env-parallel");
    expect(getParallelApiKey(config, {})).toBe("config-parallel");
  });

  it("uses the injected env map when resolving PARALLEL_API_KEY", () => {
    const previous = process.env.PARALLEL_API_KEY;
    process.env.PARALLEL_API_KEY = "process-parallel";

    try {
      const config = { apiKeys: { parallel: "config-parallel" } };
      expect(getParallelApiKey(config, {})).toBe("config-parallel");
      expect(getParallelApiKey(config)).toBe("process-parallel");
    } finally {
      if (previous === undefined) {
        delete process.env.PARALLEL_API_KEY;
      } else {
        process.env.PARALLEL_API_KEY = previous;
      }
    }
  });
});
