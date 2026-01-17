import {
  existsSync,
  mkdtempSync,
  mkdirSync,
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
import { loadConfig, loadConfigWithDiagnostics } from "../dist/core/config/schema.js";

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
      expect(levels.map((level) => level.configDir)).toEqual([
        join(fx.repo, ".tau"),
      ]);
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
          apiKeys: { openai: "global", anthropic: "anthropic-key" },
          sandbox: { image: "sandbox-base" },
          bashCommands: [{ id: "check", cmd: "npm run check" }],
          agentContextFiles: ["AGENTS.md"],
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
      });
      expect(config.sandbox).toEqual({
        image: "sandbox-base",
        pruneAfterHours: 12,
        mountPath: "/workspace",
        extraDockerArgs: ["--network=none"],
      });
      expect(config.bashCommands).toEqual([
        { id: "check", cmd: "repo check" },
        { id: "test", cmd: "nested test" },
      ]);
      expect(config.agentContextFiles).toEqual([
        join(fx.home, "AGENTS.md"),
        join(repo, "docs", "AGENTS.md"),
        join(nested, "AGENTS.md"),
      ]);
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
        defaultPersona: "opus-4.5",
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
        defaultPersona: "opus-4.5",
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
});
