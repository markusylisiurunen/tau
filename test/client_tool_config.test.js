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

function loadFixtureConfig(fixture) {
  const deps = createConfigDeps({ cwd: fixture.repo, home: fixture.home });
  const levels = resolveConfigLevels(deps, { cwd: fixture.repo });
  const modelResolver = loadModelResolver({ deps, levels });
  return loadConfigWithDiagnostics(deps, { levels, modelResolver });
}

const parameters = {
  type: "object",
  properties: {
    message: { type: "string" },
  },
  required: ["message"],
  additionalProperties: false,
};

describe("command client tool config", () => {
  it("loads global tools and resolves relative commands from home", () => {
    const fx = setupFixture();

    try {
      writeFileSync(
        join(fx.home, ".config", "tau", "config.json"),
        JSON.stringify({
          clientTools: [
            {
              name: "notify",
              description: "Show a local notification.",
              parameters,
              command: "./tools/notify",
              args: ["--json"],
              env: { DISPLAY: ":0" },
              executionTimeoutMs: 5000,
            },
          ],
        }),
      );

      const result = loadFixtureConfig(fx);

      expect(result.errors).toEqual([]);
      expect(result.config.clientTools).toEqual([
        {
          name: "notify",
          description: "Show a local notification.",
          parameters,
          command: join(fx.home, "tools", "notify"),
          args: ["--json"],
          env: { DISPLAY: ":0" },
          executionTimeoutMs: 5000,
        },
      ]);
    } finally {
      fx.cleanup();
    }
  });

  it("ignores project-defined command tools and reports why", () => {
    const fx = setupFixture();

    try {
      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({
          clientTools: [
            {
              name: "unsafe",
              description: "Run repository code.",
              parameters,
              command: "./tool",
            },
          ],
        }),
      );

      const result = loadFixtureConfig(fx);

      expect(result.config.clientTools).toBeUndefined();
      expect(result.errors).toContain(
        `${join(fx.repo, ".tau", "config.json")}: 'clientTools' may only be configured in the global config.`,
      );
    } finally {
      fx.cleanup();
    }
  });

  it("keeps valid tools while reporting invalid and duplicate entries", () => {
    const fx = setupFixture();

    try {
      writeFileSync(
        join(fx.home, ".config", "tau", "config.json"),
        JSON.stringify({
          clientTools: [
            {
              name: "notify",
              description: "Show a local notification.",
              parameters,
              command: "notify",
            },
            {
              name: "notify",
              description: "Duplicate.",
              parameters,
              command: "duplicate",
            },
            {
              name: "bad_schema",
              description: "Invalid schema.",
              parameters: { type: "string" },
              command: "bad",
            },
            {
              name: "bad_nested_schema",
              description: "Invalid nested schema.",
              parameters: {
                type: "object",
                properties: { message: { type: "bogus" } },
              },
              command: "bad-nested",
            },
          ],
        }),
      );

      const result = loadFixtureConfig(fx);

      expect(result.config.clientTools?.map((tool) => tool.name)).toEqual(["notify"]);
      expect(result.errors).toEqual([
        `${join(fx.home, ".config", "tau", "config.json")}: clientTools[1].name duplicates client tool 'notify'.`,
        `${join(fx.home, ".config", "tau", "config.json")}: clientTools[2].parameters must be an object JSON Schema with type 'object'.`,
        `${join(fx.home, ".config", "tau", "config.json")}: clientTools[3].parameters must be a valid JSON Schema.`,
      ]);
    } finally {
      fx.cleanup();
    }
  });
});
