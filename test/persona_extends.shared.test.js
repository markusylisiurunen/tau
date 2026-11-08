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
import { parsePrompt } from "../dist/core/config/content_loader.js";
import { loadAllContent, resolveConfigLevels } from "../dist/core/config/index.js";
import { buildVirtualBundle } from "../dist/core/config/virtual_bundle.js";
import { loadModelResolver, resolveModel } from "../dist/core/models/catalog.js";

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
    remoteCatalog: options.remoteCatalog,
  });
  return await loadAllContent(config, {
    deps: options.deps,
    levels,
    modelResolver: modelResolverResult.resolveModel,
    virtualBundle: buildVirtualBundle(modelResolverResult.resolveConfiguredModel),
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

  it.each([
    [
      "autoCompactThresholdTokens: 80000\nsubagentAutoCompactThresholdTokens: {OpenAI/gpt-5.4: 60000, amazon-bedrock/amazon.nova-2-lite-v1:0: 80000, ant-ling/Ling-2.6-1T: 90000}",
      true,
    ],
    ["autoCompactThresholdTokens: 49999", false],
    ["subagentAutoCompactThresholdTokens: {unknown/model: 60000}", false],
    ["subagentAutoCompactThresholdTokens: {claude-code/claude-opus-5-5: 60000}", false],
  ])("validates persona compaction policy %s", async (fields, valid) => {
    const fx = setupFixture();
    try {
      const dir = join(fx.home, ".config", "tau", "personas");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "custom.md"),
        `---\nid: custom\nprovider: anthropic\nmodel: claude-haiku-4-5\n${fields}\n---\nprompt`,
      );
      const { personas, errors } = await loadAllContentWithModelResolver(
        {},
        { deps: createConfigDeps(fx), cwd: fx.cwd },
      );
      const persona = personas.find((entry) => entry.id === "custom");
      expect(Boolean(persona)).toBe(valid);
      expect(errors).toHaveLength(valid ? 0 : 1);
      if (valid)
        expect(persona).toMatchObject({
          autoCompactThresholdTokens: 80000,
          subagentAutoCompactThresholdTokens: {
            "openai/gpt-5.4": 60000,
            "amazon-bedrock/amazon.nova-2-lite-v1:0": 80000,
            "ant-ling/Ling-2.6-1T": 90000,
          },
        });
    } finally {
      fx.cleanup();
    }
  });

  it("requires a self-contained prompt and does not inherit settings", async () => {
    const fx = setupFixture();
    try {
      const dir = join(fx.home, ".config", "tau", "personas");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "empty.md"),
        "---\nid: empty\nprovider: anthropic\nmodel: claude-haiku-4-5\n---\n",
      );
      writeFileSync(
        join(dir, "custom.md"),
        "---\nid: custom\nprovider: anthropic\nmodel: claude-haiku-4-5\nallowedReasoningLevels: [low, high]\ntools: [bash]\n---\nmy own prompt",
      );
      const { personas, errors } = await loadAllContentWithModelResolver(
        {},
        { deps: createConfigDeps(fx), cwd: fx.cwd },
      );
      expect(personas.some((persona) => persona.id === "empty")).toBe(false);
      expect(errors).toHaveLength(1);
      expect(personas.find((persona) => persona.id === "custom")).toMatchObject({
        systemPrompt: "my own prompt",
        settings: {},
        tools: ["bash"],
        allowedReasoningLevels: ["low", "high"],
      });
    } finally {
      fx.cleanup();
    }
  });

  it("derives prompt ids from filenames and requires labels", () => {
    expect(
      parsePrompt(
        "/prompts/review.md",
        "---\nlabel: Review\nid: ignored\ndescription: ignored\n---\nreview code",
      ),
    ).toEqual({ prompt: { id: "review", label: "Review", template: "review code" } });
    for (const content of ["plain markdown", "---\nlabel: ''\n---\nbody"]) {
      expect(parsePrompt("/prompts/review.md", content).prompt).toBeUndefined();
    }
  });

  it("omits catalog-only built-in personas when their model is unavailable", async () => {
    const fx = setupFixture();

    try {
      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const levels = resolveConfigLevels(deps, { cwd: fx.cwd });
      const resolveAvailableModel = (provider, modelId) =>
        [
          "gpt-6-astra",
          "gpt-6.1-sol",
          "gpt-6.1-terra",
          "gpt-6-luna",
          "claude-opus-5-5",
          "claude-sonnet-5-5",
        ].includes(modelId)
          ? undefined
          : resolveModel(provider, modelId);
      const { personas, errors } = await loadAllContent(
        {},
        {
          deps,
          levels,
          virtualBundle: buildVirtualBundle(resolveAvailableModel),
          modelResolver: resolveAvailableModel,
        },
      );
      expect(errors).toEqual([]);
      expect(personas.find((persona) => persona.id === "opus-5.5-chat")).toBeUndefined();
      expect(personas.find((persona) => persona.id === "opus-5.5-coder")).toBeUndefined();
      expect(personas.find((persona) => persona.id === "sonnet-5.5-chat")).toBeUndefined();
      expect(personas.find((persona) => persona.id === "sonnet-5.5-coder")).toBeUndefined();
      expect(personas.find((persona) => persona.id === "gpt-6-astra-chat")).toBeUndefined();
      expect(
        personas.some((persona) => /^gpt-(6(?:\.1)?-sol|6\.1-terra|6-luna)-/.test(persona.id)),
      ).toBe(false);
      expect(personas.find((persona) => persona.id === "gpt-6-astra-coder")).toBeUndefined();
      expect(personas.find((persona) => persona.id === "gpt-6-astra-chatgpt-chat")).toBeUndefined();
      expect(
        personas.find((persona) => persona.id === "gpt-6-astra-chatgpt-coder"),
      ).toBeUndefined();
      expect(
        personas.find((persona) => persona.id === "gpt-6-astra-chatgpt-fast-chat"),
      ).toBeUndefined();
      expect(
        personas.find((persona) => persona.id === "gpt-6-astra-chatgpt-fast-coder"),
      ).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });

  it("lets custom personas replace built-in ids while retaining other built-ins", async () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.home, ".config", "tau", "personas"), { recursive: true });
      writeFileSync(
        join(fx.home, ".config", "tau", "personas", "gpt-6.1-sol-chat.md"),
        [
          "---",
          "id: gpt-6.1-sol-chat",
          "provider: anthropic",
          "model: claude-haiku-4-5",
          "---",
          "custom prompt",
          "",
        ].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);

      const custom = personas.find((persona) => persona.id === "gpt-6.1-sol-chat");
      expect(custom.source).toBe("user");
      expect(custom).not.toHaveProperty("skills");
      expect(personas.some((persona) => persona.source === "builtin")).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("disables subagents through an explicit persona tool selection", async () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.home, ".config", "tau", "personas"), { recursive: true });
      writeFileSync(
        join(fx.home, ".config", "tau", "personas", "no-subagents.md"),
        [
          "---",
          "id: no-subagents",
          "provider: anthropic",
          "model: claude-haiku-4-5",
          "tools: [bash, edit]",
          "---",
          "work without background workers",
        ].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver(
        { subagents: { launchModels: ["openai/gpt-5.6-sol:low"] } },
        { deps, cwd: fx.cwd },
      );
      expect(errors).toEqual([]);
      const persona = personas.find((entry) => entry.id === "no-subagents");
      expect(persona.tools).toEqual(["bash", "edit"]);
      expect(persona.tools).not.toContain("agents");
    } finally {
      fx.cleanup();
    }
  });

  it("applies config launch models only to the built-in subagent", async () => {
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
          "      - openai/gpt-5.6-sol:high",
          "      - openai/gpt-5.6-sol:high",
          "---",
          "persona with launch models",
          "",
        ].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver(
        {
          subagents: {
            launchModels: ["openai/gpt-5.6-sol:low"],
          },
        },
        { deps, cwd: fx.cwd },
      );
      expect(errors).toEqual([]);

      const customPersona = personas.find((persona) => persona.id === "launch-models");
      expect(customPersona).toBeTruthy();
      expect(customPersona.subagentLaunchModels).toEqual(["openai/gpt-5.6-sol:low"]);
    } finally {
      fx.cleanup();
    }
  });

  it("does not mutate subagent launch models between loads", async () => {
    const fx = setupFixture();

    try {
      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const withOverrides = await loadAllContentWithModelResolver(
        {
          subagents: {
            launchModels: ["openai/gpt-5.6-sol:low"],
          },
        },
        { deps, cwd: fx.cwd },
      );

      const withOverridesPersona = withOverrides.personas.find(
        (persona) => persona.id === "gpt-6.1-sol-chat",
      );
      expect(withOverridesPersona.subagentLaunchModels).toEqual(["openai/gpt-5.6-sol:low"]);

      const withoutOverrides = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });
      const withoutOverridesPersona = withoutOverrides.personas.find(
        (persona) => persona.id === "gpt-6.1-sol-chat",
      );
      expect(withoutOverridesPersona.subagentLaunchModels).toEqual([]);
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
});
