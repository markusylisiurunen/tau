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

  it("allows Nook in explicit and default persona tool lists", async () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.home, ".config", "tau", "personas"), { recursive: true });
      writeFileSync(
        join(fx.home, ".config", "tau", "personas", "nook-persona.md"),
        [
          "---",
          "id: nook-persona",
          "provider: anthropic",
          "model: claude-haiku-4-5",
          "tools:",
          "  - nook",
          "---",
          "",
          "use Nook when requested",
        ].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });

      expect(errors).toEqual([]);
      expect(personas.find((persona) => persona.id === "nook-persona")?.tools).toEqual(["nook"]);
      expect(personas.find((persona) => persona.id === "gpt-6.1-sol-chat")?.tools).toContain(
        "nook",
      );
    } finally {
      fx.cleanup();
    }
  });

  it("sorts built-in personas alphabetically and defaults to medium reasoning", async () => {
    const fx = setupFixture();

    try {
      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);

      const ids = personas.map((persona) => persona.id);
      expect(ids).toEqual([...ids].sort((left, right) => left.localeCompare(right)));
      expect(personas.length).toBeGreaterThan(0);
      expect(personas.every((persona) => persona.settings.reasoning === "medium")).toBe(true);
    } finally {
      fx.cleanup();
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
      expect(personas.some((persona) => /^gpt-(6(?:\.1)?-sol|6-luna)-/.test(persona.id))).toBe(
        false,
      );
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

  it("loads only the current built-in Anthropic personas", async () => {
    const fx = setupFixture();

    try {
      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const opus = resolveModel("anthropic", "claude-opus-5");
      expect(opus).toBeTruthy();
      const remoteCatalog = new Map([
        [
          "anthropic",
          [
            {
              ...structuredClone(opus),
              id: "claude-opus-5-5",
              name: "Claude Opus 5.5",
            },
            {
              ...structuredClone(opus),
              id: "claude-fable-5-1",
              name: "Claude Fable 5.1",
            },
            {
              ...structuredClone(resolveModel("anthropic", "claude-sonnet-5")),
              id: "claude-sonnet-5-5",
              name: "Claude Sonnet 5.5",
            },
          ],
        ],
      ]);
      const { personas, errors } = await loadAllContentWithModelResolver(
        {},
        { deps, cwd: fx.cwd, remoteCatalog },
      );
      expect(errors).toEqual([]);

      expect(personas.find((persona) => persona.id === "sonnet-5-chat")).toBeUndefined();
      expect(personas.find((persona) => persona.id === "sonnet-5-coder")).toBeUndefined();
      expect(personas.find((persona) => persona.id === "sonnet-5.5-chat")?.tools).toContain("nook");
      expect(personas.find((persona) => persona.id === "opus-5-chat")).toBeUndefined();
      expect(personas.find((persona) => persona.id === "opus-5-coder")).toBeUndefined();
      expect(personas.find((persona) => persona.id === "opus-4.6-chat")).toBeUndefined();
      expect(personas.find((persona) => persona.id === "opus-4.8-chat")).toBeUndefined();
      expect(personas.find((persona) => persona.id === "fable-5.1-chat")?.model.id).toBe(
        "claude-fable-5-1",
      );
      expect(personas.find((persona) => persona.id === "fable-5.1-chat")?.settings.reasoning).toBe(
        "medium",
      );
      expect(
        personas.find((persona) => persona.id === "fable-5.1-chat")?.allowedReasoningLevels,
      ).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(personas.find((persona) => persona.id === "fable-5.1-coder")?.model.id).toBe(
        "claude-fable-5-1",
      );
      expect(personas.find((persona) => persona.id === "opus-5.5-chat")?.model.id).toBe(
        "claude-opus-5-5",
      );
      expect(personas.find((persona) => persona.id === "opus-5.5-chat")?.settings.reasoning).toBe(
        "medium",
      );
      expect(
        personas.find((persona) => persona.id === "opus-5.5-chat")?.allowedReasoningLevels,
      ).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(personas.find((persona) => persona.id === "opus-5.5-coder")?.model.id).toBe(
        "claude-opus-5-5",
      );
      expect(personas.find((persona) => persona.id === "sonnet-5.5-chat")?.model.id).toBe(
        "claude-sonnet-5-5",
      );
      expect(personas.find((persona) => persona.id === "sonnet-5.5-chat")?.settings.reasoning).toBe(
        "medium",
      );
      expect(
        personas.find((persona) => persona.id === "sonnet-5.5-chat")?.allowedReasoningLevels,
      ).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(personas.find((persona) => persona.id === "sonnet-5.5-coder")?.model.id).toBe(
        "claude-sonnet-5-5",
      );
    } finally {
      fx.cleanup();
    }
  });

  it("omits Gemini personas even when their model is in the remote catalog", async () => {
    const fx = setupFixture();

    try {
      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const flash = resolveModel("google", "gemini-3.7-flash");
      expect(flash).toBeTruthy();
      const remoteCatalog = new Map([
        [
          "google",
          [
            {
              ...structuredClone(flash),
              id: "gemini-3.8-flash",
              name: "Gemini 3.8 Flash",
            },
          ],
        ],
      ]);
      const { personas, errors } = await loadAllContentWithModelResolver(
        {},
        { deps, cwd: fx.cwd, remoteCatalog },
      );
      expect(errors).toEqual([]);

      expect(personas.some((persona) => persona.id.startsWith("gemini-"))).toBe(false);
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

      expect(personas.find((persona) => persona.id === "gpt-5.5-chat")).toBeUndefined();
      expect(personas.find((persona) => persona.id === "gpt-5.5-chatgpt-chat")).toBeUndefined();
      expect(
        personas.find((persona) => persona.id === "gpt-5.5-chatgpt-fast-chat"),
      ).toBeUndefined();

      expect(personas.find((persona) => persona.id === "gpt-6.1-sol-chat")?.model.id).toBe(
        "gpt-6.1-sol",
      );
      expect(personas.some((persona) => persona.id.startsWith("gpt-5.6-"))).toBe(false);
      expect(personas.some((persona) => persona.id.startsWith("gpt-6-sol-"))).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it.each([
    ["gpt-6-astra", "medium"],
    ["gpt-6.1-sol", "medium"],
    ["gpt-6-luna", "medium"],
  ])("loads %s personas from both remote OpenAI catalogs", async (modelId, reasoning) => {
    const fx = setupFixture();

    try {
      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const remoteCatalog = new Map(
        ["openai", "openai-codex"].map((provider) => {
          const model = resolveModel(provider, "gpt-6.1-sol");
          expect(model).toBeTruthy();
          return [provider, [{ ...structuredClone(model), id: modelId, name: modelId }]];
        }),
      );
      const { personas, errors } = await loadAllContentWithModelResolver(
        {},
        { deps, cwd: fx.cwd, remoteCatalog },
      );
      expect(errors).toEqual([]);

      for (const suffix of ["", "-chatgpt", "-chatgpt-fast"]) {
        for (const variant of ["chat", "coder"]) {
          const persona = personas.find((entry) => entry.id === `${modelId}${suffix}-${variant}`);
          if (suffix === "-chatgpt-fast" && variant === "chat") {
            expect(persona).toBeUndefined();
            continue;
          }
          expect(persona?.model.id).toBe(modelId);
          expect(persona?.model.provider).toBe(suffix ? "openai-codex" : "openai");
          expect(persona?.settings.reasoning).toBe(reasoning);
          expect(persona?.allowedReasoningLevels).toEqual([
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
          ]);
          expect(persona?.settings.serviceTier).toBe(
            suffix === "-chatgpt-fast" ? "priority" : undefined,
          );
        }
      }
    } finally {
      fx.cleanup();
    }
  });

  it("omits retired GPT personas even when their models are in both remote OpenAI catalogs", async () => {
    const fx = setupFixture();
    const modelIds = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-sol"];

    try {
      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const remoteCatalog = new Map(
        ["openai", "openai-codex"].map((provider) => [
          provider,
          modelIds.map((id) => ({ ...structuredClone(resolveModel(provider, "gpt-6.1-sol")), id })),
        ]),
      );
      const { personas, errors } = await loadAllContentWithModelResolver(
        {},
        { deps, cwd: fx.cwd, remoteCatalog },
      );
      expect(errors).toEqual([]);
      for (const modelId of modelIds) {
        expect(personas.some((persona) => persona.id.startsWith(`${modelId}-`))).toBe(false);
      }
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
      expect(persona.tools).not.toContain("spawn_agent");
    } finally {
      fx.cleanup();
    }
  });

  it("ignores custom subagent definitions", async () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.home, ".config", "tau", "personas"), { recursive: true });
      writeFileSync(
        join(fx.home, ".config", "tau", "personas", "subagent-runtime.md"),
        [
          "---",
          "id: subagent-runtime",
          "provider: anthropic",
          "model: claude-haiku-4-5",
          "subagents:",
          "  analyst:",
          "    systemPrompt: analyze repository state",
          "    provider: openai",
          "    model: gpt-5.6-sol",
          "    reasoning: none",
          "    serviceTier: flex",
          "---",
          "persona with a subagent",
          "",
        ].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { personas, errors } = await loadAllContentWithModelResolver({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);

      const persona = personas.find((entry) => entry.id === "subagent-runtime");
      expect(persona).toBeTruthy();
      expect(persona.subagentLaunchModels).toEqual([]);
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
