import { spawnSync } from "node:child_process";
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
import { resolveConfigPaths } from "../dist/core/config/paths.js";
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

  spawnSync("git", ["init"], { cwd: repo, stdio: "ignore" });

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
  it("uses XDG_CONFIG_HOME when set", () => {
    const fx = setupFixture();

    try {
      const deps = createConfigDeps({
        cwd: fx.repo,
        home: fx.home,
        env: { XDG_CONFIG_HOME: fx.home },
      });

      const paths = resolveConfigPaths(deps, { cwd: fx.repo });
      expect(paths.userConfigDir).toBe(join(fx.home, "tau"));
      expect(paths.userConfigPath).toBe(join(fx.home, "tau", "config.json"));
    } finally {
      fx.cleanup();
    }
  });
});

describe("loadConfig", () => {
  it("merges project disableBuiltinPersonas and preserves user fields", () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.home, "tau"), { recursive: true });
      writeFileSync(
        join(fx.home, "tau", "config.json"),
        JSON.stringify({ defaultRisk: "read-only", disableBuiltinPersonas: false }),
      );

      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({ disableBuiltinPersonas: true, defaultRisk: "read-write" }),
      );

      const deps = createConfigDeps({
        cwd: fx.repo,
        home: fx.home,
        env: { XDG_CONFIG_HOME: fx.home },
      });

      const config = loadConfig(fx.repo, deps);
      expect(config.defaultRisk).toBe("read-only");
      expect(config.disableBuiltinPersonas).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("reports parse errors without throwing", () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.home, "tau"), { recursive: true });
      writeFileSync(join(fx.home, "tau", "config.json"), "{invalid json");

      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(join(fx.repo, ".tau", "config.json"), JSON.stringify({}));

      const deps = createConfigDeps({
        cwd: fx.repo,
        home: fx.home,
        env: { XDG_CONFIG_HOME: fx.home },
      });

      const result = loadConfigWithDiagnostics(fx.repo, deps);
      expect(result.config).toEqual({});
      expect(result.errors.length).toBeGreaterThan(0);
    } finally {
      fx.cleanup();
    }
  });
});
