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
  it("binds main runtime tools and prompts", () => {
    const runtime = createRuntime();

    expect(runtime.agent).toBeInstanceOf(AgentRuntime);
    expect(runtime.agent.spec.tools.schemas.length).toBeGreaterThan(0);
    expect(runtime.agent.spec.systemPrompt).toBe(runtime.promptComposition.baseSystemPrompt);
  });

  it("keeps configured Nook alongside the persona's enabled tools", () => {
    const runtime = createRuntime({
      persona: createPersona({ tools: ["bash"] }),
      config: { nook: { domain: "nook.example.com" } },
    });

    expect(runtime.agent.spec.tools.schemas.map((tool) => tool.name)).toEqual(["bash", "nook"]);
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
    expect(composition.baseSystemPrompt).toContain("skill-b");
    expect(composition.subagentPrompts.researcher).toContain("research subagent prompt");
    expect(runtime.agent.spec.systemPrompt).toBe(composition.baseSystemPrompt);
  });
});
