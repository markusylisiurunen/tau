import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadAllContent } from "../dist/content_loader.js";

function setupFixture() {
  const home = mkdtempSync(join(tmpdir(), "tau-personas-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "tau-personas-cwd-"));

  return {
    home: resolve(home),
    cwd: resolve(cwd),
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

describe("custom personas", () => {
  const oldXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const oldCwd = process.cwd();

  let fx;

  beforeEach(() => {
    fx = setupFixture();

    process.env.XDG_CONFIG_HOME = fx.home;
    process.chdir(fx.cwd);

    mkdirSync(join(fx.home, "tau", "personas"), { recursive: true });
  });

  afterEach(() => {
    if (oldXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = oldXdgConfigHome;
    }

    process.chdir(oldCwd);
    fx.cleanup();
  });

  it("supports extends from built-in personas", async () => {
    writeFileSync(
      join(fx.home, "tau", "personas", "clone.md"),
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

    const { personas, errors } = await loadAllContent({});
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
      expect(cfg.model.provider).toBe(baseCfg.model.provider);
      expect(cfg.model.id).toBe(baseCfg.model.id);
    }
  });

  it("can disable built-in personas and still load custom personas (including builtin ids)", async () => {
    writeFileSync(
      join(fx.home, "tau", "personas", "override.md"),
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

    const { personas, errors } = await loadAllContent({ disableBuiltinPersonas: true });
    expect(errors).toEqual([]);

    expect(personas.map((p) => p.id)).toEqual(["gpt-5.2-chat"]);
    expect(personas[0].source).toBe("user");
  });
});
