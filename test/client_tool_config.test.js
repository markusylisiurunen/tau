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
import { loadConfigWithDiagnostics } from "../dist/core/config/schema.js";
import { loadModelResolver } from "../dist/core/models/catalog.js";

function createConfigDeps({ cwd, home }) {
  return {
    fs: {
      readFile: (path) => readFileSync(path, "utf-8"),
      exists: (path) => existsSync(path),
      listDir: (path) => readdirSync(path),
      stat: (path) => statSync(path),
    },
    env: {
      getEnv: () => ({}),
      cwd: () => cwd,
      home: () => home,
    },
  };
}

function setupFixture() {
  const home = resolve(mkdtempSync(join(tmpdir(), "tau-client-tools-home-")));
  const repo = join(home, "repo");
  mkdirSync(join(home, ".config", "tau"), { recursive: true });
  mkdirSync(join(repo, ".tau"), { recursive: true });

  return {
    home,
    repo,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function loadFixtureConfig(fixture, cwd = fixture.repo) {
  const deps = createConfigDeps({ cwd, home: fixture.home });
  const levels = resolveConfigLevels(deps, { cwd });
  const modelResolver = loadModelResolver();
  return loadConfigWithDiagnostics(deps, { levels, modelResolver });
}

describe("removed command client tool config", () => {
  it("ignores global and project keys without registering tools or changing files", () => {
    const fx = setupFixture();
    try {
      const paths = [
        join(fx.home, ".config", "tau", "config.json"),
        join(fx.repo, ".tau", "config.json"),
      ];
      const contents = JSON.stringify({
        clientTools: [
          {
            name: "notify",
            defaultEnabled: true,
            description: "Show a notification.",
            parameters: { type: "object" },
            command: "./notify",
          },
        ],
        enabledClientTools: ["notify"],
      });
      for (const path of paths) writeFileSync(path, contents);

      const result = loadFixtureConfig(fx);

      expect(result.errors).toEqual([]);
      expect(result.config).not.toHaveProperty("clientTools");
      expect(result.config).not.toHaveProperty("enabledClientTools");
      for (const path of paths) expect(readFileSync(path, "utf8")).toBe(contents);
    } finally {
      fx.cleanup();
    }
  });
});
