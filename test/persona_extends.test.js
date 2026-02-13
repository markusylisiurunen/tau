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
import { loadAllContent } from "../dist/core/config/index.js";

function setupFixture() {
  const home = mkdtempSync(join(tmpdir(), "tau-personas-home-"));
  const cwd = join(home, "repo");
  mkdirSync(cwd, { recursive: true });

  return {
    home: resolve(home),
    cwd: resolve(cwd),
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe("custom personas", () => {
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

  it("supports extends from built-in personas", async () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.home, ".config", "tau", "personas"), { recursive: true });
      writeFileSync(
        join(fx.home, ".config", "tau", "personas", "haiku-clone-of-gpt-coder.md"),
        [
          "---",
          "id: haiku-clone-of-gpt-coder",
          "extends: gpt-5.2-coder",
          "provider: anthropic",
          "model: claude-haiku-4-5",
          "---",
          "",
        ].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContent({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);

      const base = personas.find((p) => p.id === "gpt-5.2-coder");
      const clone = personas.find((p) => p.id === "haiku-clone-of-gpt-coder");

      expect(base).toBeTruthy();
      expect(clone).toBeTruthy();

      expect(clone.model.provider).toBe("anthropic");
      expect(clone.systemPrompt).toBe(base.systemPrompt);

      expect(clone.tools.map((t) => t.name)).toEqual(base.tools.map((t) => t.name));

      expect(Object.keys(clone.subagents ?? {})).toEqual(Object.keys(base.subagents ?? {}));

      for (const [name, cfg] of Object.entries(clone.subagents ?? {})) {
        const baseCfg = base.subagents?.[name];
        expect(baseCfg).toBeTruthy();
        expect(cfg).toEqual(baseCfg);
      }
    } finally {
      fx.cleanup();
    }
  });

  it("can disable built-in personas and still load custom personas (including builtin ids)", async () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.home, ".config", "tau", "personas"), { recursive: true });
      writeFileSync(
        join(fx.home, ".config", "tau", "personas", "gpt-5.2-chat.md"),
        [
          "---",
          "id: gpt-5.2-chat",
          "provider: anthropic",
          "model: claude-haiku-4-5",
          "---",
          "custom prompt",
          "",
        ].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContent(
        { disableBuiltinPersonas: true },
        { deps, cwd: fx.cwd },
      );
      expect(errors).toEqual([]);

      expect(personas.map((p) => p.id)).toEqual(["gpt-5.2-chat"]);
      expect(personas[0].source).toBe("user");
    } finally {
      fx.cleanup();
    }
  });

  it("parses custom subagent launch models and applies config launch models for default", async () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.home, ".config", "tau", "personas"), { recursive: true });
      writeFileSync(
        join(fx.home, ".config", "tau", "personas", "launch-models.md"),
        [
          "---",
          "id: launch-models",
          "provider: anthropic",
          "model: claude-haiku-4-5",
          "subagents:",
          "  analyst:",
          "    systemPrompt: analyze repository state",
          "    launchModels:",
          "      - openai/gpt-5.2:high",
          "      - openai/gpt-5.2:high",
          "---",
          "persona with launch models",
          "",
        ].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContent(
        {
          subagents: {
            defaultLaunchModels: ["openai/gpt-5.2:low"],
          },
        },
        { deps, cwd: fx.cwd },
      );
      expect(errors).toEqual([]);

      const customPersona = personas.find((persona) => persona.id === "launch-models");
      expect(customPersona).toBeTruthy();
      expect(customPersona.subagents.analyst.launchModels).toEqual(["openai/gpt-5.2:high"]);
      expect(customPersona.subagents.default.launchModels).toEqual(["openai/gpt-5.2:low"]);
    } finally {
      fx.cleanup();
    }
  });

  it("does not mutate built-in default subagent launch models between loads", async () => {
    const fx = setupFixture();

    try {
      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const withOverrides = await loadAllContent(
        {
          subagents: {
            defaultLaunchModels: ["openai/gpt-5.2:low"],
          },
        },
        { deps, cwd: fx.cwd },
      );

      const withOverridesPersona = withOverrides.personas.find(
        (persona) => persona.id === "gpt-5.2-chat",
      );
      expect(withOverridesPersona.subagents.default.launchModels).toEqual(["openai/gpt-5.2:low"]);

      const withoutOverrides = await loadAllContent({}, { deps, cwd: fx.cwd });
      const withoutOverridesPersona = withoutOverrides.personas.find(
        (persona) => persona.id === "gpt-5.2-chat",
      );
      expect(withoutOverridesPersona.subagents.default.launchModels).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });

  it("loads no prompts when prompt files are not present", async () => {
    const fx = setupFixture();

    try {
      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { prompts, errors } = await loadAllContent({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);
      expect(prompts).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });
});
