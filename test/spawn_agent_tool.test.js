import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { resolveConfigLevels } from "../dist/core/config/index.js";
import { loadModelResolver } from "../dist/core/models/catalog.js";
import { personas } from "../dist/core/personas.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { createSpawnAgentToolDefinition } from "../dist/core/tools/spawn_agent.js";
import { TOOL_NAME_SPAWN_AGENT } from "../dist/core/tools/tool_names.js";

function getText(toolResult) {
  const textBlock = toolResult.content.find((block) => block.type === "text");
  return textBlock?.text ?? "";
}

function createModels() {
  const anthropic = personas.find((persona) => persona.id === "opus-4.8-chat")?.model;
  const openai = personas.find((persona) => persona.id === "gpt-5.5-chat")?.model;
  expect(anthropic).toBeTruthy();
  expect(openai).toBeTruthy();
  return { anthropic, openai };
}

function createModelResolver(cwd, home) {
  const deps = {
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
  const levels = resolveConfigLevels(deps, { cwd });

  return loadModelResolver({ deps, levels }).resolveModel;
}

function createContext(overrides = {}) {
  const { anthropic, openai } = createModels();
  const spawned = [];
  const baseCwd = overrides.cwd ?? "/repo/current";
  const baseHome = overrides.home ?? "/repo";
  const modelResolver = createModelResolver(baseCwd, baseHome);

  const context = {
    scope: "main",
    modelResolver,
    resolveSubagentRuntime: async ({ cwd, name }) => ({
      config: {},
      modelResolver,
      systemPrompt: `${name} prompt\n<cwd>${cwd}</cwd>`,
    }),
    persona: {
      id: "test-persona",
      label: "test persona",
      model: anthropic,
      systemPrompt: "main",
      settings: { reasoning: "low", serviceTier: "priority" },
      skills: "*",
      source: "project",
      subagents: {
        default: {
          launchModels: ["openai/gpt-5.5:high"],
        },
        researcher: {
          systemPrompt: "research",
          model: anthropic,
          settings: { reasoning: "medium" },
          launchModels: ["openai/gpt-5.5:high"],
        },
      },
    },
    subagentPrompts: {
      default: "default prompt",
      researcher: "research prompt",
    },
    cwd: baseCwd,
    home: baseHome,
    config: {},
    toolRegistry: { schemas: [] },
    authPath: "/tmp/auth.json",
    includeAgentContext: false,
    originHistoryEntryId: "history-1",
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
          model: "openai/gpt-5.5:high",
        },
      },
      undefined,
      context,
    );

    expect(dispatched.kind).toBe("phased");
    const result = await dispatched.run;
    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(false);
    expect(result.uiEvent.type).toBe("spawn_agent_finished");
    expect(result.uiEvent.uiText.statusLine).toContain("openai/gpt-5.5:high");
    expect(spawned).toHaveLength(1);
    expect(spawned[0].model.provider).toBe(openai.provider);
    expect(spawned[0].model.id).toBe(openai.id);
    expect(spawned[0].settings.reasoning).toBe("high");
    expect(spawned[0].settings.serviceTier).toBe("priority");
  });

  it("shows the launch model override in status when it matches the persona model", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { openai } = createModels();
    const { context } = createContext({
      persona: {
        id: "test-persona",
        label: "test persona",
        model: openai,
        systemPrompt: "main",
        settings: { reasoning: "low" },
        source: "project",
        subagents: {
          researcher: {
            systemPrompt: "research",
            model: openai,
            settings: { reasoning: "medium" },
            launchModels: ["openai/gpt-5.5:high"],
          },
        },
      },
      subagentPrompts: {
        researcher: "research prompt",
      },
    });

    const dispatched = await tool.dispatch(
      {
        id: "call-1b",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
          model: "openai/gpt-5.5:high",
        },
      },
      undefined,
      context,
    );

    expect(dispatched.kind).toBe("phased");
    const result = await dispatched.run;
    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(false);
    expect(result.uiEvent.type).toBe("spawn_agent_finished");
    expect(result.uiEvent.uiText.statusLine).toContain("openai/gpt-5.5:high");
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
          model: "openai/gpt-5.5:high",
        },
      },
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
          model: "openai/gpt-5.5:low",
        },
      },
      undefined,
      context,
    );

    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(true);
    expect(getText(result.toolResult)).toContain("is not allowed for subagent");
    expect(getText(result.toolResult)).toContain("openai/gpt-5.5:high");
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
    expect(spawned[0].settings.serviceTier).toBe("priority");
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
          model: "openai/gpt-5.5:high",
        },
      },
      undefined,
      context,
    );

    expect(dispatched.kind).toBe("phased");
    await dispatched.run;
    expect(spawned).toHaveLength(1);
    expect(spawned[0].model.provider).toBe(openai.provider);
    expect(spawned[0].model.id).toBe(openai.id);
    expect(spawned[0].settings.reasoning).toBe("high");
    expect(spawned[0].settings.serviceTier).toBe("priority");
  });

  it("rejects an explicitly provided but empty model parameter", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { context, spawned } = createContext();

    const result = await tool.dispatch(
      {
        id: "call-6",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
          model: "",
        },
      },
      undefined,
      context,
    );

    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(true);
    expect(getText(result.toolResult)).toContain("Invalid arguments: model:");
    expect(spawned).toHaveLength(0);
  });

  it("rejects an explicitly provided but empty workingDirectory parameter", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { context, spawned } = createContext();

    const result = await tool.dispatch(
      {
        id: "call-7",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
          workingDirectory: "",
        },
      },
      undefined,
      context,
    );

    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(true);
    expect(getText(result.toolResult)).toContain("Invalid arguments: workingDirectory:");
    expect(spawned).toHaveLength(0);
  });

  it("accepts absolute workingDirectory values", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { context, spawned } = createContext({
      cwd: "/repo/src",
    });

    const dispatched = await tool.dispatch(
      {
        id: "call-8",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
          workingDirectory: "/tmp",
        },
      },
      undefined,
      context,
    );

    expect(dispatched.kind).toBe("phased");
    await dispatched.run;
    expect(spawned).toHaveLength(1);
    expect(spawned[0].workingDirectory).toBe("/tmp");
  });

  it("resolves relative workingDirectory values against the current cwd", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { context, spawned } = createContext({
      cwd: "/repo/src",
    });

    const dispatched = await tool.dispatch(
      {
        id: "call-8b",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
          workingDirectory: "..",
        },
      },
      undefined,
      context,
    );

    expect(dispatched.kind).toBe("phased");
    await dispatched.run;
    expect(spawned).toHaveLength(1);
    expect(spawned[0].workingDirectory).toBe("/repo");
  });

  it("resolves working-directory context through the execution environment", async () => {
    const resolveSubagentRuntime = vi.fn(async ({ cwd, name }) => ({
      config: { modelSystemNotices: {} },
      modelResolver: createModelResolver(cwd, "/repo"),
      systemPrompt: `${name} target prompt\n<cwd>${cwd}</cwd>\ntarget AGENTS context`,
    }));
    const { context, spawned } = createContext({
      cwd: "/repo/src",
      resolveSubagentRuntime,
    });
    const persona = context.persona;

    const dispatched = await createSpawnAgentToolDefinition(
      createLocalToolExecutionBackend(),
    ).dispatch(
      {
        id: "call-9",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
          workingDirectory: "..",
        },
      },
      undefined,
      context,
    );

    expect(dispatched.kind).toBe("phased");
    await dispatched.run;
    expect(resolveSubagentRuntime).toHaveBeenCalledWith({
      cwd: "/repo",
      persona,
      name: "researcher",
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].workingDirectory).toBe("/repo");
    expect(spawned[0].systemPrompt).toContain("target AGENTS context");
  });

  it("reports execution-environment context resolution failures", async () => {
    const { context, spawned } = createContext({
      resolveSubagentRuntime: async () => {
        throw new Error("target skill configuration is invalid");
      },
    });

    const result = await createSpawnAgentToolDefinition(createLocalToolExecutionBackend()).dispatch(
      {
        id: "call-10",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
          workingDirectory: ".",
        },
      },
      undefined,
      context,
    );

    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(true);
    expect(getText(result.toolResult)).toContain("Failed to build the subagent prompt");
    expect(getText(result.toolResult)).toContain("target skill configuration is invalid");
    expect(spawned).toHaveLength(0);
  });
});
