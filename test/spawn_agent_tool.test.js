import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { resolveConfigLevels } from "../dist/core/config/index.js";
import { loadModelResolver } from "../dist/core/models/catalog.js";
import { personas } from "../dist/core/personas.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { createSpawnAgentToolDefinition } from "../dist/core/tools/spawn_agent.js";
import { TOOL_NAME_SPAWN_AGENT } from "../dist/core/tools/tool_names.js";

function getText(toolResult) {
  return toolResult.content.find((block) => block.type === "text")?.text ?? "";
}

function createModelResolver(cwd = "/repo/current", home = "/repo") {
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
  return loadModelResolver({ deps, levels: resolveConfigLevels(deps, { cwd }) }).resolveModel;
}

function createFixture(overrides = {}) {
  const anthropic = personas.find((persona) => persona.id === "opus-4.8-chat")?.model;
  expect(anthropic).toBeTruthy();
  const supervisor = {
    spawn: vi.fn(() => ({ ok: true, id: "agent-1" })),
  };
  const persona = {
    id: "test-persona",
    label: "test persona",
    model: anthropic,
    systemPrompt: "main",
    settings: { reasoning: "low", serviceTier: "priority" },
    skills: "*",
    source: "project",
    subagents: {
      default: { launchModels: ["openai/gpt-5.5:high"] },
      researcher: {
        systemPrompt: "research",
        model: anthropic,
        settings: { reasoning: "medium" },
        launchModels: ["openai/gpt-5.5:high"],
      },
      fixed: { systemPrompt: "fixed", model: anthropic },
    },
  };
  const modelResolver = createModelResolver();
  const options = {
    backend: createLocalToolExecutionBackend(),
    supervisor,
    persona,
    config: {},
    modelResolver,
    subagentPrompts: {
      default: "default prompt",
      researcher: "research prompt",
      fixed: "fixed prompt",
    },
    cwd: "/repo/current",
    ...overrides,
  };
  return { tool: createSpawnAgentToolDefinition(options), supervisor, persona, modelResolver };
}

async function execute(tool, arguments_) {
  const call = { id: "call-1", name: TOOL_NAME_SPAWN_AGENT, arguments: arguments_ };
  const activities = [];
  const outcome = await tool.execute(call, {
    agentId: "parent-agent",
    turnId: "turn-1",
    assistantMessageId: "history-1",
    signal: new AbortController().signal,
    emitActivity: async (activity) => activities.push(activity),
  });
  return {
    dispatch: { startedUiEvent: activities[0] },
    result: {
      toolResult: { ...outcome, toolCallId: call.id, toolName: call.name },
      uiEvent: activities.at(-1),
    },
  };
}

const baseArguments = {
  name: "researcher",
  title: "research task",
  prompt: "investigate this",
};

describe("spawn_agent tool", () => {
  it("binds dependencies before execution and admits an allowed launch model", async () => {
    const { tool, supervisor } = createFixture();
    const { dispatch, result } = await execute(tool, {
      ...baseArguments,
      model: "openai/gpt-5.5:high",
    });

    expect(dispatch.startedUiEvent).toMatchObject({
      type: "spawn_agent_started",
      name: "researcher",
      title: "research task",
    });
    expect(result.toolResult.outcome).toBe("succeeded");
    expect(supervisor.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "investigate this",
        originHistoryEntryId: "history-1",
        runtimeConfig: expect.objectContaining({
          name: "researcher",
          workingDirectory: "/repo/current",
          settings: expect.objectContaining({ reasoning: "high" }),
        }),
      }),
    );
  });

  it("rejects launch model overrides that are absent or outside the allowlist", async () => {
    const { tool, supervisor } = createFixture();
    const missing = await execute(tool, {
      ...baseArguments,
      name: "fixed",
      model: "openai/gpt-5.5:high",
    });
    const disallowed = await execute(tool, {
      ...baseArguments,
      model: "openai/gpt-5.5:medium",
    });

    expect(missing.result.toolResult.outcome).toBe("blocked");
    expect(getText(missing.result.toolResult)).toContain("does not allow launch model overrides");
    expect(disallowed.result.toolResult.outcome).toBe("blocked");
    expect(getText(disallowed.result.toolResult)).toContain("is not allowed");
    expect(supervisor.spawn).not.toHaveBeenCalled();
  });

  it("uses the bound default settings without a launch model override", async () => {
    const { tool, supervisor } = createFixture();
    const { result } = await execute(tool, baseArguments);

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(supervisor.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        modelLabel: undefined,
        runtimeConfig: expect.objectContaining({
          settings: expect.objectContaining({ reasoning: "medium" }),
        }),
      }),
    );
  });

  it("resolves relative working directories through the supplied runtime resolver", async () => {
    const resolveSubagentRuntime = vi.fn(async ({ cwd, persona }) => ({
      persona,
      config: { apiKeys: {} },
      modelResolver: createModelResolver(cwd),
      subagentPrompts: { researcher: `target prompt: ${cwd}` },
    }));
    const { tool, supervisor } = createFixture({ resolveSubagentRuntime });
    const { result } = await execute(tool, {
      ...baseArguments,
      workingDirectory: "packages/api",
    });

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(resolveSubagentRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo/current/packages/api" }),
    );
    expect(supervisor.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeConfig: expect.objectContaining({
          systemPrompt: "target prompt: /repo/current/packages/api",
          workingDirectory: "/repo/current/packages/api",
        }),
      }),
    );
  });

  it("blocks working-directory launches when runtime resolution is unavailable", async () => {
    const { tool, supervisor } = createFixture();
    const { result } = await execute(tool, {
      ...baseArguments,
      workingDirectory: "/tmp/project",
    });

    expect(result.toolResult.outcome).toBe("blocked");
    expect(getText(result.toolResult)).toContain("context resolution is unavailable");
    expect(supervisor.spawn).not.toHaveBeenCalled();
  });

  it("reports supervisor admission failures as blocked", async () => {
    const supervisor = { spawn: vi.fn(() => ({ ok: false, reason: "active limit reached" })) };
    const { result } = await execute(createFixture({ supervisor }).tool, baseArguments);

    expect(result.toolResult.outcome).toBe("blocked");
    expect(getText(result.toolResult)).toBe("active limit reached");
    expect(result.uiEvent).toMatchObject({ type: "spawn_agent_blocked" });
  });
});
