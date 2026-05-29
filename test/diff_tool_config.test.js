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
import { resolveConfigLevels } from "../src/core/config/paths.ts";
import { loadConfig, loadConfigWithDiagnostics } from "../src/core/config/schema.ts";
import { loadModelResolver } from "../src/core/models/catalog.ts";

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
  const home = mkdtempSync(join(tmpdir(), "tau-diff-tool-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tau-diff-tool-repo-"));
  return {
    home: resolve(home),
    repo: resolve(repo),
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

describe("diffTool config", () => {
  it("loads the most-specific diff tool config and resolves relative commands from the config root", () => {
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
          diffTool: {
            command: "./tools/global-diff",
            args: ["--global"],
            env: { GLOBAL_ONLY: "1" },
          },
        }),
      );
      writeFileSync(
        join(repo, ".tau", "config.json"),
        JSON.stringify({
          diffTool: {
            command: "./tools/repo-diff",
            args: ["--repo"],
            env: { REPO_ONLY: "1" },
          },
        }),
      );
      writeFileSync(
        join(nested, ".tau", "config.json"),
        JSON.stringify({
          defaultPersona: "custom-persona",
        }),
      );

      const deps = createConfigDeps({ cwd: nested, home: fx.home, env: {} });
      const config = loadConfig(nested, deps);

      expect(config.diffTool).toEqual({
        command: join(repo, "tools", "repo-diff"),
        args: ["--repo"],
        env: { REPO_ONLY: "1" },
      });
    } finally {
      fx.cleanup();
    }
  });

  it("loads the most-specific built-in diff tool config", () => {
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
          builtInDiffTool: { codeTheme: "dark-plus" },
        }),
      );
      writeFileSync(
        join(repo, ".tau", "config.json"),
        JSON.stringify({
          builtInDiffTool: { codeTheme: "github-dark" },
        }),
      );

      const deps = createConfigDeps({ cwd: nested, home: fx.home, env: {} });
      const config = loadConfig(nested, deps);

      expect(config.builtInDiffTool).toEqual({ codeTheme: "github-dark" });
    } finally {
      fx.cleanup();
    }
  });

  it("reports invalid diff tool fields without dropping valid config", () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({
          defaultRisk: "read-write",
          diffTool: { command: "", args: ["--ok"] },
          builtInDiffTool: { codeTheme: "not-a-theme" },
        }),
      );

      const deps = createConfigDeps({ cwd: fx.repo, home: fx.home, env: {} });
      const levels = resolveConfigLevels(deps, { cwd: fx.repo });
      const modelResolver = loadModelResolver({ deps, levels });
      const result = loadConfigWithDiagnostics(deps, { levels, modelResolver });

      expect(result.config.defaultRisk).toBe("read-write");
      expect(result.config.diffTool).toBeUndefined();
      expect(result.config.builtInDiffTool).toBeUndefined();
      expect(result.errors).toContain(
        `${join(fx.repo, ".tau", "config.json")}: diffTool.command must be a non-empty string.`,
      );
      expect(result.errors).toContain(
        `${join(fx.repo, ".tau", "config.json")}: builtInDiffTool.codeTheme is not supported.`,
      );
    } finally {
      fx.cleanup();
    }
  });
});
