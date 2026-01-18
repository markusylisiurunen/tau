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
        join(fx.home, ".config", "tau", "personas", "clone.md"),
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
        expect(cfg.model.provider).toBe(clone.model.provider);
        expect(cfg.model.id).toBe(clone.model.id);
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
        join(fx.home, ".config", "tau", "personas", "override.md"),
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

  it("disables built-in prompts when disableBuiltinPrompts is set", async () => {
    const fx = setupFixture();

    try {
      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { prompts, errors } = await loadAllContent(
        { disableBuiltinPrompts: true },
        { deps, cwd: fx.cwd },
      );
      expect(errors).toEqual([]);
      expect(prompts).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });
});
