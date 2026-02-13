import { describe, expect, it } from "vitest";
import { personas } from "../dist/core/personas.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { createSpawnAgentToolDefinition } from "../dist/core/tools/spawn_agent.js";
import { TOOL_NAME_SPAWN_AGENT } from "../dist/core/tools/tool_names.js";

function getText(toolResult) {
  const textBlock = toolResult.content.find((block) => block.type === "text");
  return textBlock?.text ?? "";
}

function createModels() {
  const anthropic = personas.find((persona) => persona.model.provider === "anthropic")?.model;
  const openai = personas.find((persona) => persona.model.provider === "openai")?.model;
  expect(anthropic).toBeTruthy();
  expect(openai).toBeTruthy();
  return { anthropic, openai };
}

function createContext(overrides = {}) {
  const { anthropic, openai } = createModels();
  const spawned = [];

  const context = {
    persona: {
      id: "test-persona",
      label: "test persona",
      model: anthropic,
      systemPrompt: "main",
      settings: { reasoning: "low" },
      source: "project",
      subagents: {
        default: {
          launchModels: ["openai/gpt-5.2:high"],
        },
        researcher: {
          systemPrompt: "research",
          model: anthropic,
          settings: { reasoning: "medium" },
          launchModels: ["openai/gpt-5.2:high"],
        },
      },
    },
    riskLevel: "read-only",
    subagentPrompts: {
      default: "default prompt",
      researcher: "research prompt",
    },
    subagentControlPlane: {
      spawn: ({ runtimeConfig }) => {
        spawned.push(runtimeConfig);
        return { ok: true, id: "agent-1" };
      },
    },
    ...overrides,
  };

  return { context, anthropic, openai, spawned };
}

describe("spawn_agent tool", () => {
  it("accepts an allowed launch model override", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { context, openai, spawned } = createContext();

    const dispatched = await tool.dispatch(
      {
        id: "call-1",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
          model: "openai/gpt-5.2:high",
        },
      },
      "read-only",
      undefined,
      context,
    );

    expect(dispatched.kind).toBe("phased");
    const result = await dispatched.run;
    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(false);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].model.provider).toBe(openai.provider);
    expect(spawned[0].model.id).toBe(openai.id);
    expect(spawned[0].settings.reasoning).toBe("high");
  });

  it("blocks launch model overrides when no allowlist exists", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { context } = createContext({
      persona: {
        id: "test-persona",
        label: "test persona",
        model: createModels().anthropic,
        systemPrompt: "main",
        settings: { reasoning: "low" },
        source: "project",
        subagents: {
          researcher: {
            systemPrompt: "research",
          },
        },
      },
      subagentPrompts: {
        researcher: "research prompt",
      },
    });

    const result = await tool.dispatch(
      {
        id: "call-2",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
          model: "openai/gpt-5.2:high",
        },
      },
      "read-only",
      undefined,
      context,
    );

    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(true);
    expect(getText(result.toolResult)).toContain("does not allow launch model overrides");
  });

  it("blocks launch model overrides outside the allowlist", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { context, spawned } = createContext();

    const result = await tool.dispatch(
      {
        id: "call-3",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
          model: "openai/gpt-5.2:low",
        },
      },
      "read-only",
      undefined,
      context,
    );

    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(true);
    expect(getText(result.toolResult)).toContain("is not allowed for subagent");
    expect(getText(result.toolResult)).toContain("openai/gpt-5.2:high");
    expect(spawned).toHaveLength(0);
  });

  it("keeps default behavior when no launch model override is provided", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { context, anthropic, spawned } = createContext();

    const dispatched = await tool.dispatch(
      {
        id: "call-4",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
        },
      },
      "read-only",
      undefined,
      context,
    );

    expect(dispatched.kind).toBe("phased");
    const result = await dispatched.run;
    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(false);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].model.provider).toBe(anthropic.provider);
    expect(spawned[0].model.id).toBe(anthropic.id);
    expect(spawned[0].settings.reasoning).toBe("medium");
  });

  it("supports launch model overrides on the default subagent", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { context, openai, spawned } = createContext();

    const dispatched = await tool.dispatch(
      {
        id: "call-5",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "default",
          title: "default task",
          prompt: "collect findings",
          model: "openai/gpt-5.2:high",
        },
      },
      "read-only",
      undefined,
      context,
    );

    expect(dispatched.kind).toBe("phased");
    await dispatched.run;
    expect(spawned).toHaveLength(1);
    expect(spawned[0].model.provider).toBe(openai.provider);
    expect(spawned[0].model.id).toBe(openai.id);
    expect(spawned[0].settings.reasoning).toBe("high");
  });
});
