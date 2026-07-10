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
import { loadAllContent, resolveConfigLevels } from "../dist/core/config/index.js";
import { loadModelResolver } from "../dist/core/models/catalog.js";

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

async function loadAllContentWithModelResolver(config, options) {
  const levels = resolveConfigLevels(options.deps, { cwd: options.cwd });
  const modelResolverResult = loadModelResolver({
    deps: options.deps,
    levels,
  });
  return await loadAllContent(config, {
    deps: options.deps,
    levels,
    modelResolver: modelResolverResult,
  });
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
          "extends: gpt-5.5-coder",
          "provider: anthropic",
          "model: claude-haiku-4-5",
          "---",
          "",
        ].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);

      const base = personas.find((p) => p.id === "gpt-5.5-coder");
      const clone = personas.find((p) => p.id === "haiku-clone-of-gpt-coder");

      expect(base).toBeTruthy();
      expect(clone).toBeTruthy();

      expect(clone.model.provider).toBe("anthropic");
      expect(clone.systemPrompt).toBe(base.systemPrompt);
      expect(clone.skills).toEqual(base.skills);

      expect(clone.tools).toEqual(base.tools);

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

  it("keeps both built-in opus personas available", async () => {
    const fx = setupFixture();

    try {
      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);

      expect(personas.find((persona) => persona.id === "opus-4.6-chat")?.model.id).toBe(
        "claude-opus-4-6",
      );
      expect(personas.find((persona) => persona.id === "opus-4.6-chat")?.settings.reasoning).toBe(
        "medium",
      );
      expect(
        personas.find((persona) => persona.id === "opus-4.6-chat")?.allowedReasoningLevels,
      ).toEqual(["low", "medium", "high", "max"]);
      expect(personas.find((persona) => persona.id === "opus-4.6-coder")?.model.id).toBe(
        "claude-opus-4-6",
      );
      expect(personas.find((persona) => persona.id === "opus-4.8-chat")?.model.id).toBe(
        "claude-opus-4-8",
      );
      expect(personas.find((persona) => persona.id === "opus-4.8-chat")?.settings.reasoning).toBe(
        "medium",
      );
      expect(
        personas.find((persona) => persona.id === "opus-4.8-chat")?.allowedReasoningLevels,
      ).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(personas.find((persona) => persona.id === "opus-4.8-coder")?.model.id).toBe(
        "claude-opus-4-8",
      );
    } finally {
      fx.cleanup();
    }
  });

  it("loads only current built-in GPT personas", async () => {
    const fx = setupFixture();

    try {
      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);

      expect(personas.find((persona) => persona.id === "gpt-5.3-codex-chat")).toBeUndefined();
      expect(personas.find((persona) => persona.id === "gpt-5.4-chat")).toBeUndefined();
      expect(personas.find((persona) => persona.id === "gpt-5.4-chatgpt-chat")).toBeUndefined();
      expect(
        personas.find((persona) => persona.id === "gpt-5.4-chatgpt-fast-chat"),
      ).toBeUndefined();

      expect(personas.find((persona) => persona.id === "gpt-5.5-chat")?.model.id).toBe("gpt-5.5");
      expect(personas.find((persona) => persona.id === "gpt-5.5-coder")?.model.id).toBe("gpt-5.5");
      expect(personas.find((persona) => persona.id === "gpt-5.5-chatgpt-chat")?.model.id).toBe(
        "gpt-5.5",
      );
      expect(personas.find((persona) => persona.id === "gpt-5.5-chatgpt-coder")?.model.id).toBe(
        "gpt-5.5",
      );
      expect(personas.find((persona) => persona.id === "gpt-5.5-chatgpt")).toBeUndefined();
      expect(
        personas.find((persona) => persona.id === "gpt-5.5-chatgpt-fast-chat")?.settings
          .serviceTier,
      ).toBe("priority");

      expect(personas.find((persona) => persona.id === "gpt-5.6-sol-chat")?.model.id).toBe(
        "gpt-5.6-sol",
      );
      expect(
        personas.find((persona) => persona.id === "gpt-5.6-sol-chat")?.allowedReasoningLevels,
      ).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(personas.find((persona) => persona.id === "gpt-5.6-terra-chat")?.model.id).toBe(
        "gpt-5.6-terra",
      );
      expect(
        personas.find((persona) => persona.id === "gpt-5.6-sol-chatgpt-fast-chat")?.settings
          .serviceTier,
      ).toBe("priority");
    } finally {
      fx.cleanup();
    }
  });

  it("applies configured models.json entries to built-in personas", async () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.home, ".config", "tau"), { recursive: true });
      writeFileSync(
        join(fx.home, ".config", "tau", "models.json"),
        JSON.stringify(
          {
            providers: {
              openai: {
                models: [
                  {
                    id: "gpt-5.5",
                    contextWindow: 400000,
                  },
                ],
              },
              "openai-codex": {
                models: [
                  {
                    id: "gpt-5.5",
                    contextWindow: 400000,
                  },
                ],
              },
            },
          },
          null,
          2,
        ),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);

      expect(personas.find((persona) => persona.id === "gpt-5.5-chat")?.model.contextWindow).toBe(
        400000,
      );
      expect(personas.find((persona) => persona.id === "gpt-5.5-coder")?.model.contextWindow).toBe(
        400000,
      );
      expect(
        personas.find((persona) => persona.id === "gpt-5.5-chatgpt-chat")?.model.contextWindow,
      ).toBe(400000);
      expect(
        personas.find((persona) => persona.id === "gpt-5.5-chatgpt-coder")?.model.contextWindow,
      ).toBe(400000);
      expect(
        personas.find((persona) => persona.id === "gpt-5.5-chatgpt-fast-chat")?.settings
          .serviceTier,
      ).toBe("priority");
      expect(
        personas.find((persona) => persona.id === "gpt-5.5-chatgpt-fast-coder")?.settings
          .serviceTier,
      ).toBe("priority");
    } finally {
      fx.cleanup();
    }
  });

  it("can disable built-in personas and still load custom personas (including builtin ids)", async () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.home, ".config", "tau", "personas"), { recursive: true });
      writeFileSync(
        join(fx.home, ".config", "tau", "personas", "gpt-5.5-chat.md"),
        [
          "---",
          "id: gpt-5.5-chat",
          "provider: anthropic",
          "model: claude-haiku-4-5",
          "---",
          "custom prompt",
          "",
        ].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver(
        { disableBuiltinPersonas: true },
        { deps, cwd: fx.cwd },
      );
      expect(errors).toEqual([]);

      expect(personas.map((p) => p.id)).toEqual(["gpt-5.5-chat"]);
      expect(personas[0].source).toBe("user");
      expect(personas[0].skills).toBe("*");
    } finally {
      fx.cleanup();
    }
  });

  it("allows disabling skills for custom personas with an empty list", async () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.home, ".config", "tau", "personas"), { recursive: true });
      writeFileSync(
        join(fx.home, ".config", "tau", "personas", "no-skills.md"),
        [
          "---",
          "id: no-skills",
          "provider: anthropic",
          "model: claude-haiku-4-5",
          "skills: []",
          "---",
          "custom prompt",
          "",
        ].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);

      const persona = personas.find((p) => p.id === "no-skills");
      expect(persona).toBeTruthy();
      expect(persona.skills).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it("supports selecting a subset of skills for custom personas", async () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.home, ".config", "tau", "personas"), { recursive: true });
      writeFileSync(
        join(fx.home, ".config", "tau", "personas", "subset-skills.md"),
        [
          "---",
          "id: subset-skills",
          "provider: anthropic",
          "model: claude-haiku-4-5",
          "skills:",
          "  - alpha",
          "  - beta",
          "---",
          "custom prompt",
          "",
        ].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);

      const persona = personas.find((p) => p.id === "subset-skills");
      expect(persona).toBeTruthy();
      expect(persona.skills).toEqual(["alpha", "beta"]);
    } finally {
      fx.cleanup();
    }
  });

  it("parses custom persona service tiers", async () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.home, ".config", "tau", "personas"), { recursive: true });
      writeFileSync(
        join(fx.home, ".config", "tau", "personas", "flex-tier.md"),
        [
          "---",
          "id: flex-tier",
          "provider: openai",
          "model: gpt-5.4",
          "serviceTier: flex",
          "---",
          "custom prompt",
          "",
        ].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);

      const persona = personas.find((p) => p.id === "flex-tier");
      expect(persona).toBeTruthy();
      expect(persona.settings.serviceTier).toBe("flex");
    } finally {
      fx.cleanup();
    }
  });

  it("parses custom subagent service tiers", async () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.home, ".config", "tau", "personas"), { recursive: true });
      writeFileSync(
        join(fx.home, ".config", "tau", "personas", "subagent-service-tier.md"),
        [
          "---",
          "id: subagent-service-tier",
          "provider: anthropic",
          "model: claude-haiku-4-5",
          "subagents:",
          "  analyst:",
          "    systemPrompt: analyze repository state",
          "    reasoning: medium",
          "    serviceTier: flex",
          "---",
          "persona with subagent service tier",
          "",
        ].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);

      const persona = personas.find((entry) => entry.id === "subagent-service-tier");
      expect(persona).toBeTruthy();
      expect(persona.subagents?.analyst?.settings?.reasoning).toBe("medium");
      expect(persona.subagents?.analyst?.settings?.serviceTier).toBe("flex");
    } finally {
      fx.cleanup();
    }
  });

  it("preserves custom subagent reasoning none", async () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.home, ".config", "tau", "personas"), { recursive: true });
      writeFileSync(
        join(fx.home, ".config", "tau", "personas", "subagent-no-reasoning.md"),
        [
          "---",
          "id: subagent-no-reasoning",
          "provider: anthropic",
          "model: claude-haiku-4-5",
          "reasoning: medium",
          "subagents:",
          "  analyst:",
          "    systemPrompt: analyze repository state",
          "    reasoning: none",
          "---",
          "persona with subagent reasoning override",
          "",
        ].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);

      const persona = personas.find((entry) => entry.id === "subagent-no-reasoning");
      expect(persona).toBeTruthy();
      expect(persona.subagents?.analyst?.settings?.reasoning).toBe("none");
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
          "      - openai/gpt-5.5:high",
          "      - openai/gpt-5.5:high",
          "---",
          "persona with launch models",
          "",
        ].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver(
        {
          subagents: {
            defaultLaunchModels: ["openai/gpt-5.5:low"],
          },
        },
        { deps, cwd: fx.cwd },
      );
      expect(errors).toEqual([]);

      const customPersona = personas.find((persona) => persona.id === "launch-models");
      expect(customPersona).toBeTruthy();
      expect(customPersona.subagents.analyst.launchModels).toEqual(["openai/gpt-5.5:high"]);
      expect(customPersona.subagents.default.launchModels).toEqual(["openai/gpt-5.5:low"]);
    } finally {
      fx.cleanup();
    }
  });

  it("does not mutate built-in default subagent launch models between loads", async () => {
    const fx = setupFixture();

    try {
      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const withOverrides = await loadAllContentWithModelResolver(
        {
          subagents: {
            defaultLaunchModels: ["openai/gpt-5.5:low"],
          },
        },
        { deps, cwd: fx.cwd },
      );

      const withOverridesPersona = withOverrides.personas.find(
        (persona) => persona.id === "gpt-5.5-chat",
      );
      expect(withOverridesPersona.subagents.default.launchModels).toEqual(["openai/gpt-5.5:low"]);

      const withoutOverrides = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });
      const withoutOverridesPersona = withoutOverrides.personas.find(
        (persona) => persona.id === "gpt-5.5-chat",
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
      const { prompts, errors } = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);
      expect(prompts).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it("surfaces persona frontmatter YAML parse errors", async () => {
    const fx = setupFixture();

    try {
      const personasDir = join(fx.home, ".config", "tau", "personas");
      mkdirSync(personasDir, { recursive: true });
      writeFileSync(
        join(personasDir, "broken.md"),
        ["---", "id broken", "provider: anthropic", "model: claude-haiku-4-5", "---"].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });

      expect(personas.find((persona) => persona.id === "broken")).toBeUndefined();
      expect(errors.some((error) => error.includes("invalid frontmatter YAML"))).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("surfaces prompt frontmatter non-object errors", async () => {
    const fx = setupFixture();

    try {
      const promptsDir = join(fx.home, ".config", "tau", "prompts");
      mkdirSync(promptsDir, { recursive: true });
      writeFileSync(
        join(promptsDir, "broken.md"),
        ["---", "- not", "- an", "- object", "---", "hello"].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { prompts, errors } = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });

      expect(prompts.find((prompt) => prompt.id === "broken")).toBeUndefined();
      expect(errors.some((error) => error.includes("frontmatter must be a YAML object"))).toBe(
        true,
      );
    } finally {
      fx.cleanup();
    }
  });
});
