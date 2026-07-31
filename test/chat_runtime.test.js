import { describe, expect, it } from "vitest";
import { AgentRuntime, ChatRuntime, createLocalToolExecutionBackend } from "../dist/core/index.js";
import { resolveModel } from "../dist/core/models/catalog.js";
import { personas } from "../dist/core/personas.js";

function createPersona(overrides = {}) {
  return {
    id: "test-persona",
    label: "test persona",
    description: "test",
    model: personas[0].model,
    systemPrompt: "main system prompt",
    settings: {},
    source: "project",
    tools: personas[0].tools,
    subagents: {
      default: {},
      researcher: {
        systemPrompt: "research subagent prompt",
        description: "deep research helper",
        launchModels: ["openai/gpt-5.4:high"],
      },
    },
    ...overrides,
  };
}

function createEnvironment(now = Date.parse("2026-01-01T00:00:00.000Z")) {
  return { now: () => now };
}

function createPromptContext(overrides = {}) {
  return {
    cwd: "/repo",
    home: "/home/user",
    platform: "linux",
    nodeVersion: "v24.0.0",
    includeAgentContext: true,
    ...overrides,
  };
}

function createRuntime(overrides = {}) {
  return ChatRuntime.create({
    persona: createPersona(),
    backend: createLocalToolExecutionBackend(),
    modelResolver: resolveModel,
    promptContext: createPromptContext(),
    environment: createEnvironment(),
    eventSink: async () => {},
    subagentEventSink: async () => {},
    config: {},
    ...overrides,
  });
}

describe("ChatRuntime", () => {
  it("constructs the canonical agent runtime with fully bound tools", async () => {
    const runtime = createRuntime();

    expect(runtime.agent).toBeInstanceOf(AgentRuntime);
    expect(runtime.agent.spec.tools.schemas.length).toBeGreaterThan(0);
    await runtime.commitUserText("hello from create");
    expect(runtime.history).toHaveLength(1);
    expect(runtime.history[0]?.role).toBe("user");
    expect(runtime.promptComposition.baseSystemPrompt).toContain("main system prompt");
    expect(runtime.promptComposition.baseSystemPrompt).toContain("<cwd>/repo</cwd>");
    expect(runtime.promptComposition.subagentPrompts.default).toContain("<inherited-instructions>");
  });

  it("keeps configured Nook alongside the persona's enabled tools", () => {
    const runtime = createRuntime({
      persona: createPersona({ tools: ["bash"] }),
      config: { nook: { domain: "nook.example.com" } },
    });

    expect(runtime.agent.spec.tools.schemas.map((tool) => tool.name)).toEqual(["bash", "nook"]);
  });

  it("uses an explicit initial prompt composition without recomposing it", () => {
    const initialPromptComposition = {
      environmentTag: "<environment><datetime>persisted</datetime></environment>",
      baseSystemPrompt: "persisted system prompt",
      subagentPrompts: { default: "persisted subagent prompt" },
    };

    const runtime = createRuntime({
      environment: createEnvironment(Date.parse("2027-01-01T00:00:00.000Z")),
      initialPromptComposition,
    });

    expect(runtime.promptComposition).toEqual(initialPromptComposition);
    expect(runtime.agent.spec.systemPrompt).toBe("persisted system prompt");
  });

  it("rebuilds the main and subagent prompts and updates the next runtime spec", () => {
    const runtime = createRuntime({
      promptContext: createPromptContext({
        skillsBlock: "### Skills\n\n- skill-a",
        projectContextBlock: '### Project context\n\n<file path="/repo/AGENTS.md">ctx</file>',
      }),
    });

    runtime.rebuildSystemPrompts({ skillsBlock: "### Skills\n\n- skill-b" });

    const composition = runtime.promptComposition;
    expect(composition.baseSystemPrompt).toContain("main system prompt");
    expect(composition.baseSystemPrompt).toContain("skill-b");
    expect(composition.baseSystemPrompt).toContain("### Project context");
    expect(composition.baseSystemPrompt).toContain("### Available sub-agents");
    expect(composition.baseSystemPrompt).toContain("`researcher`");
    expect(composition.baseSystemPrompt).toContain("openai/gpt-5.4:high");
    expect(composition.baseSystemPrompt).toContain("<datetime>2026-01-01T00:00:00.000Z</datetime>");
    expect(composition.subagentPrompts.default).toContain("main system prompt");
    expect(composition.subagentPrompts.researcher).toContain("research subagent prompt");
    expect(runtime.agent.spec.systemPrompt).toBe(composition.baseSystemPrompt);
  });

  it("applies persona, reasoning, and config changes to the runtime spec", () => {
    const runtime = createRuntime();
    const nextPersona = createPersona({
      id: "next-persona",
      label: "next persona",
      systemPrompt: "next system prompt",
    });

    runtime.setReasoning("high");
    expect(runtime.agent.spec.attribution.reasoningEffort).toBe("high");
    runtime.setRuntimeConfig({ autoCompact: { enabled: false } }, resolveModel);
    expect(runtime.agent.spec.compactionPolicy.enabled).toBe(false);
    runtime.setPersona(nextPersona);
    expect(runtime.persona.id).toBe("next-persona");
    expect(runtime.agent.spec.systemPrompt).toContain("next system prompt");
  });
});
