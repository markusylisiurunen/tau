import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { resolveConfigLevels } from "../dist/core/config/index.js";
import { loadModelResolver } from "../dist/core/models/catalog.js";
import { personas } from "../dist/core/personas.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { createInterruptAgentToolDefinition } from "../dist/core/tools/interrupt_agent.js";
import { createListAgentsToolDefinition } from "../dist/core/tools/list_agents.js";
import { createSendInputToAgentToolDefinition } from "../dist/core/tools/send_input_to_agent.js";
import { createSpawnAgentToolDefinition } from "../dist/core/tools/spawn_agent.js";
import {
  TOOL_NAME_INTERRUPT_AGENT,
  TOOL_NAME_LIST_AGENTS,
  TOOL_NAME_SEND_INPUT_TO_AGENT,
  TOOL_NAME_SPAWN_AGENT,
  TOOL_NAME_WAIT_FOR_AGENTS,
} from "../dist/core/tools/tool_names.js";
import { createWaitForAgentsToolDefinition } from "../dist/core/tools/wait_for_agents.js";

function getText(toolResult) {
  return toolResult.content.find((block) => block.type === "text")?.text ?? "";
}

function createSubagentState(overrides = {}) {
  return {
    id: "agent-1",
    name: "default",
    title: "child task",
    availability: "running",
    model: { provider: "anthropic", id: "claude-opus-5", reasoning: "medium" },
    workingDirectory: "/repo/current",
    createdAt: 10,
    run: {
      revision: 1,
      status: "running",
      startedAt: 10,
      interruptRequested: false,
    },
    costTotal: 0.01,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      contextWindowUsageTokens: 15,
      contextWindow: 200000,
    },
    ...overrides,
  };
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
  const anthropic = personas.find((persona) => persona.id === "opus-5-chat")?.model;
  expect(anthropic).toBeTruthy();
  const supervisor = {
    spawn: vi.fn(({ runtimeConfig, title }) => ({
      ok: true,
      state: createSubagentState({
        name: runtimeConfig.name,
        title,
        model: {
          provider: runtimeConfig.model.provider,
          id: runtimeConfig.model.id,
          reasoning: runtimeConfig.settings?.reasoning ?? "none",
        },
        workingDirectory: runtimeConfig.workingDirectory,
      }),
      capacity: { running: 1, limit: 8 },
    })),
  };
  const persona = {
    id: "test-persona",
    label: "test persona",
    model: anthropic,
    systemPrompt: "main",
    settings: { reasoning: "low", serviceTier: "priority" },
    tools: ["bash", "write", "edit", "history"],
    skills: "*",
    source: "project",
    subagents: {
      default: { launchModels: ["openai/gpt-5.6-sol:high"] },
      researcher: {
        systemPrompt: "research",
        model: anthropic,
        settings: { reasoning: "medium" },
        launchModels: ["openai/gpt-5.6-sol:high"],
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
    history: {
      search: vi.fn(),
      read: vi.fn(),
    },
    cwd: "/repo/current",
    ...overrides,
  };
  return { tool: createSpawnAgentToolDefinition(options), supervisor, persona, modelResolver };
}

async function execute(tool, arguments_, name = TOOL_NAME_SPAWN_AGENT) {
  const call = { id: "call-1", name, arguments: arguments_ };
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

describe("list_agents tool", () => {
  it("returns dense text without including retained response bodies", async () => {
    const state = createSubagentState({
      availability: "idle",
      run: {
        revision: 1,
        status: "succeeded",
        startedAt: 10,
        finishedAt: 20,
        interruptRequested: false,
        response: "private retained response",
      },
    });
    const supervisor = {
      listSnapshots: vi.fn(() => [state]),
      getCapacity: vi.fn(() => ({ running: 0, limit: 8 })),
    };
    const tool = createListAgentsToolDefinition(supervisor);

    const { result } = await execute(tool, {}, TOOL_NAME_LIST_AGENTS);
    const text = getText(result.toolResult);

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(text).toContain("Agents · 0 running / 8");
    expect(text).toContain("idle · run 1 succeeded · response available");
    expect(text).toContain("context 0.01% (15/200k) · cost $0.01");
    expect(text).not.toContain("private retained response");
    expect(() => JSON.parse(text)).toThrow();
  });
});

describe("send_input_to_agent tool", () => {
  it("confirms the new run without repeating the full agent state", async () => {
    const current = createSubagentState({
      availability: "idle",
      run: {
        revision: 1,
        status: "succeeded",
        startedAt: 1,
        finishedAt: 2,
        interruptRequested: false,
        response: "previous response",
      },
    });
    const next = createSubagentState({
      run: {
        revision: 2,
        status: "running",
        startedAt: 3,
        interruptRequested: false,
      },
    });
    const supervisor = {
      getSnapshot: vi.fn(() => current),
      sendInput: vi.fn(() => ({
        ok: true,
        state: next,
        capacity: { running: 1, limit: 8 },
      })),
    };
    const tool = createSendInputToAgentToolDefinition(supervisor);

    const { result } = await execute(
      tool,
      { id: "agent-1", prompt: "continue" },
      TOOL_NAME_SEND_INPUT_TO_AGENT,
    );

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(getText(result.toolResult)).toBe(
      ["Started run 2 for `agent-1` · child task", "capacity 1/8"].join("\n"),
    );
    expect(getText(result.toolResult)).not.toContain("previous response");
  });
});

describe("wait_for_agents tool", () => {
  it("returns retained responses and child failures without failing the wait operation", async () => {
    const succeeded = createSubagentState({
      availability: "idle",
      run: {
        revision: 2,
        status: "succeeded",
        startedAt: 10,
        finishedAt: 20,
        interruptRequested: false,
        response: "final response",
      },
    });
    const failed = createSubagentState({
      id: "agent-2",
      title: "second task",
      availability: "idle",
      run: {
        revision: 1,
        status: "failed",
        startedAt: 10,
        finishedAt: 20,
        interruptRequested: false,
        failure: {
          kind: "provider-error",
          message: "provider overloaded",
          stopReason: "error",
        },
      },
    });
    const supervisor = {
      waitForAgents: vi.fn(async () => [succeeded, failed]),
      getCapacity: vi.fn(() => ({ running: 0, limit: 8 })),
    };
    const tool = createWaitForAgentsToolDefinition(supervisor);

    const { result } = await execute(
      tool,
      { ids: ["agent-1", "agent-2"] },
      TOOL_NAME_WAIT_FOR_AGENTS,
    );
    const text = getText(result.toolResult);

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(result.uiEvent).toMatchObject({ status: "success" });
    expect(text).toContain("run 2 succeeded · context");
    expect(text).toContain("Response:\nfinal response");
    expect(text).toContain("run 1 failed · provider-error · context");
    expect(text).toContain("failure: provider overloaded (stop reason: error)");
    expect(text).toContain("Capacity: 0/8 running");
  });
});

describe("interrupt_agent tool", () => {
  it("succeeds when interruption produces an interrupted run", async () => {
    const supervisor = {
      getSnapshot: vi.fn(() => createSubagentState()),
      getCapacity: vi.fn(() => ({ running: 0, limit: 8 })),
      interrupt: vi.fn(async () =>
        createSubagentState({
          availability: "idle",
          run: {
            revision: 1,
            status: "interrupted",
            startedAt: 10,
            finishedAt: 20,
            interruptRequested: true,
            failure: { kind: "interrupted", message: "Subagent run was interrupted." },
          },
        }),
      ),
    };
    const tool = createInterruptAgentToolDefinition(supervisor);

    const { result } = await execute(tool, { id: "agent-1" }, TOOL_NAME_INTERRUPT_AGENT);

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(result.uiEvent).toMatchObject({
      type: "interrupt_agent_finished",
      status: "success",
      finalStatus: "interrupted",
    });
    expect(getText(result.toolResult)).toBe(
      [
        "Interrupted run 1 for `agent-1` · child task",
        "Thread is idle and available for follow-up · capacity 0/8",
      ].join("\n"),
    );
  });

  it("succeeds without dumping the response when the agent is already idle", async () => {
    const state = createSubagentState({
      availability: "idle",
      run: {
        revision: 2,
        status: "failed",
        startedAt: 10,
        finishedAt: 20,
        interruptRequested: false,
        failure: { kind: "runtime-error", message: "child failed" },
      },
    });
    const supervisor = {
      getSnapshot: vi.fn(() => state),
      getCapacity: vi.fn(() => ({ running: 0, limit: 8 })),
      interrupt: vi.fn(async () => state),
    };
    const tool = createInterruptAgentToolDefinition(supervisor);

    const { result } = await execute(tool, { id: "agent-1" }, TOOL_NAME_INTERRUPT_AGENT);

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(result.uiEvent).toMatchObject({ status: "success", finalStatus: "failed" });
    expect(getText(result.toolResult)).toBe(
      [
        "`agent-1` is already idle",
        "latest run 2 failed · runtime-error",
        "failure: child failed",
      ].join("\n"),
    );
  });
});

describe("spawn_agent tool", () => {
  it("binds dependencies before execution and admits an allowed launch model", async () => {
    const { tool, supervisor } = createFixture();
    const { dispatch, result } = await execute(tool, {
      ...baseArguments,
      model: "openai/gpt-5.6-sol:high",
    });

    expect(dispatch.startedUiEvent).toMatchObject({
      type: "spawn_agent_started",
      name: "researcher",
      title: "research task",
    });
    expect(result.toolResult.outcome).toBe("succeeded");
    expect(getText(result.toolResult)).toBe(
      [
        "Spawned `agent-1` · research task",
        "researcher · openai/gpt-5.6-sol:high · /repo/current",
        "run 1 running · capacity 1/8",
      ].join("\n"),
    );
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
      model: "openai/gpt-5.6-sol:high",
    });
    const disallowed = await execute(tool, {
      ...baseArguments,
      model: "openai/gpt-5.6-sol:medium",
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
        history: expect.objectContaining({
          search: expect.any(Function),
          read: expect.any(Function),
        }),
        runtimeConfig: expect.objectContaining({
          settings: expect.objectContaining({ reasoning: "medium" }),
          tools: ["bash", "write", "edit", "history"],
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
