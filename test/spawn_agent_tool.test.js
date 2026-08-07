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
          reasoning: runtimeConfig.settings.reasoning ?? "none",
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
    settings: { reasoning: "high", serviceTier: "priority" },
    tools: ["bash", "write", "edit", "history"],
    skills: "*",
    source: "project",
    subagents: {
      default: { launchModels: ["openai/gpt-5.6-sol:high"] },
      researcher: {
        systemPrompt: "research",
        launchModels: ["openai/gpt-5.6-sol:high"],
      },
      fixed: { systemPrompt: "fixed" },
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

async function execute(
  tool,
  arguments_,
  name = TOOL_NAME_SPAWN_AGENT,
  signal = new AbortController().signal,
) {
  const call = { id: "call-1", name, arguments: arguments_ };
  const activities = [];
  const outcome = await tool.execute(call, {
    agentId: "parent-agent",
    turnId: "turn-1",
    assistantMessageId: "history-1",
    signal,
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
    const running = createSubagentState({ id: "agent-2", title: "second task" });
    const supervisor = {
      listSnapshots: vi.fn(() => [state, running]),
      getCapacity: vi.fn(() => ({ running: 1, limit: 8 })),
    };
    const tool = createListAgentsToolDefinition(supervisor);

    const { result } = await execute(tool, {}, TOOL_NAME_LIST_AGENTS);
    const text = getText(result.toolResult);

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(text).toContain("Agents · 1 running / 8");
    expect(text).toContain("idle · run 1 succeeded · response available");
    expect(text).toContain("context 0.01% (15/200k) · cost $0.01");
    expect(text).not.toContain("private retained response");
    expect(result.uiEvent.presentation.details.map((line) => line.text)).toEqual(text.split("\n"));
    expect(result.uiEvent.presentation.metadata).toEqual([]);
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
    const prompt = Array.from({ length: 20 }, (_, index) => `prompt ${index + 1}`).join("\n");

    expect(tool.schema.parameters.properties.id.pattern).toBe("^[^\\r\\n]+$");

    const invalid = await execute(
      tool,
      { id: "agent-1\nagent-2", prompt },
      TOOL_NAME_SEND_INPUT_TO_AGENT,
    );
    expect(invalid.result.toolResult.outcome).toBe("blocked");

    const { result } = await execute(
      tool,
      { id: "agent-1", prompt },
      TOOL_NAME_SEND_INPUT_TO_AGENT,
    );

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(result.uiEvent.presentation.metadata).toEqual([]);
    expect(result.uiEvent.presentation.details.map((line) => line.text)).toEqual([
      ...Array.from({ length: 8 }, (_, index) => `prompt ${index + 1}`),
      "…4 more lines…",
      ...Array.from({ length: 8 }, (_, index) => `prompt ${index + 13}`),
    ]);
    expect(getText(result.toolResult)).toBe(
      ["Started run 2 for `agent-1` · child task", "capacity 1/8"].join("\n"),
    );
    expect(getText(result.toolResult)).not.toContain("previous response");
  });

  it("does not duplicate cancellation in details or metadata", async () => {
    const supervisor = {
      getSnapshot: vi.fn(() => createSubagentState({ availability: "idle" })),
      sendInput: vi.fn(),
    };
    const tool = createSendInputToAgentToolDefinition(supervisor);
    const controller = new AbortController();
    controller.abort();

    const { result } = await execute(
      tool,
      { id: "agent-1", prompt: "continue" },
      TOOL_NAME_SEND_INPUT_TO_AGENT,
      controller.signal,
    );

    expect(result.toolResult.outcome).toBe("cancelled");
    expect(result.uiEvent.presentation.details).toEqual([]);
    expect(result.uiEvent.presentation.metadata).toEqual([]);
  });
});

describe("wait_for_agents tool", () => {
  it("returns full responses while accounting only for agents that completed the wait", async () => {
    const responseLines = Array.from({ length: 30 }, (_, index) =>
      index === 29 ? "END" : `response ${index + 1}`,
    );
    const longResponse = responseLines.join("\n");
    const succeeded = createSubagentState({
      availability: "idle",
      run: {
        revision: 2,
        status: "succeeded",
        startedAt: 10_000,
        finishedAt: 20_000,
        interruptRequested: false,
        response: longResponse,
      },
    });
    const failed = createSubagentState({
      id: "agent-2",
      title: "second task",
      availability: "idle",
      run: {
        revision: 1,
        status: "failed",
        startedAt: 10_000,
        finishedAt: 40_000,
        interruptRequested: false,
        failure: {
          kind: "provider-error",
          message: "provider overloaded",
          stopReason: "error",
        },
      },
    });
    const running = createSubagentState({
      id: "agent-3",
      costTotal: 99,
      run: {
        revision: 1,
        status: "running",
        startedAt: 1,
        interruptRequested: false,
      },
    });
    const supervisor = {
      waitForAgents: vi.fn(async () => [succeeded, failed, running]),
      getCapacity: vi.fn(() => ({ running: 1, limit: 8 })),
    };
    const tool = createWaitForAgentsToolDefinition(supervisor);
    expect(tool.schema.parameters.properties.ids.items.pattern).toBe("^[^\\r\\n]+$");

    const invalid = await execute(tool, { ids: ["agent-1\nagent-2"] }, TOOL_NAME_WAIT_FOR_AGENTS);
    expect(invalid.result.toolResult.outcome).toBe("blocked");

    const { result } = await execute(
      tool,
      { ids: ["agent-1", "agent-2", "agent-3"] },
      TOOL_NAME_WAIT_FOR_AGENTS,
    );
    const text = getText(result.toolResult);

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(result.uiEvent).toMatchObject({ status: "success" });
    expect(text).toContain("run 2 succeeded · context");
    expect(text).toContain(`Response:\n${longResponse}`);
    expect(text).toContain("run 1 failed · provider-error · context");
    expect(text).toContain("failure: provider overloaded (stop reason: error)");
    expect(text).toContain("Capacity: 1/8 running");
    expect(result.uiEvent.presentation.details.map((line) => line.text)).toEqual([
      "agent-1 · child task · succeeded",
      "Response:",
      ...responseLines.slice(0, 8),
      "…14 more lines…",
      ...responseLines.slice(-8),
      "agent-2 · second task · failed",
      "provider overloaded (stop reason: error)",
    ]);
    expect(result.uiEvent.presentation.details.map((line) => line.text).join("\n")).not.toContain(
      "agent-3",
    );
    expect(result.uiEvent.presentation.metadata).toEqual(["cost $0.02", "duration 30s"]);
  });

  it("does not duplicate cancellation as a detail", async () => {
    const supervisor = {
      waitForAgents: vi.fn(async () => {
        throw new Error("Aborted.");
      }),
      getCapacity: vi.fn(() => ({ running: 1, limit: 8 })),
    };
    const tool = createWaitForAgentsToolDefinition(supervisor);
    const controller = new AbortController();
    controller.abort();

    const { result } = await execute(
      tool,
      { ids: ["agent-1"] },
      TOOL_NAME_WAIT_FOR_AGENTS,
      controller.signal,
    );

    expect(result.toolResult.outcome).toBe("cancelled");
    expect(result.uiEvent.presentation.details).toEqual([]);
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
    expect(tool.schema.parameters.properties.id.pattern).toBe("^[^\\r\\n]+$");

    const invalid = await execute(tool, { id: "agent-1\nagent-2" }, TOOL_NAME_INTERRUPT_AGENT);
    expect(invalid.result.toolResult.outcome).toBe("blocked");

    const { result } = await execute(tool, { id: "agent-1" }, TOOL_NAME_INTERRUPT_AGENT);

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(result.uiEvent).toMatchObject({
      type: "tool_call_finished",
      toolName: TOOL_NAME_INTERRUPT_AGENT,
      status: "success",
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
    expect(result.uiEvent).toMatchObject({
      type: "tool_call_finished",
      toolName: TOOL_NAME_INTERRUPT_AGENT,
      status: "success",
    });
    expect(getText(result.toolResult)).toBe(
      [
        "`agent-1` is already idle",
        "latest run 2 failed · runtime-error",
        "failure: child failed",
      ].join("\n"),
    );
  });

  it("renders every model-facing interrupt result line", async () => {
    const failureMessage = "x".repeat(400);
    const state = createSubagentState({
      availability: "idle",
      run: {
        revision: 2,
        status: "failed",
        startedAt: 10,
        finishedAt: 20,
        interruptRequested: false,
        failure: { kind: "runtime-error", message: failureMessage },
      },
    });
    const supervisor = {
      getSnapshot: vi.fn(() => state),
      getCapacity: vi.fn(() => ({ running: 0, limit: 8 })),
      interrupt: vi.fn(async () => state),
    };
    const tool = createInterruptAgentToolDefinition(supervisor);

    const { result } = await execute(tool, { id: "agent-1" }, TOOL_NAME_INTERRUPT_AGENT);
    const modelText = getText(result.toolResult);

    expect(result.uiEvent.presentation.details.map((line) => line.text).join("\n")).toBe(modelText);
    expect(result.uiEvent.presentation.details.at(-1).text).toBe(`failure: ${failureMessage}`);
  });

  it("does not duplicate cancellation as a detail", async () => {
    const supervisor = {
      getSnapshot: vi.fn(() => createSubagentState()),
      interrupt: vi.fn(async () => {
        throw new Error("Aborted.");
      }),
    };
    const tool = createInterruptAgentToolDefinition(supervisor);
    const controller = new AbortController();
    controller.abort();

    const { result } = await execute(
      tool,
      { id: "agent-1" },
      TOOL_NAME_INTERRUPT_AGENT,
      controller.signal,
    );

    expect(result.toolResult.outcome).toBe("cancelled");
    expect(result.uiEvent.presentation.details).toEqual([]);
  });
});

describe("spawn_agent tool", () => {
  it("enforces single-line title and working-directory contracts", async () => {
    const { tool } = createFixture();

    expect(tool.schema.parameters.properties.title.pattern).toBe("^[^\\r\\n]+$");
    expect(tool.schema.parameters.properties.workingDirectory.pattern).toBe("^[^\\r\\n]+$");

    const invalidDirectory = await execute(tool, {
      ...baseArguments,
      workingDirectory: "one\ntwo",
    });
    expect(invalidDirectory.result.toolResult.outcome).toBe("blocked");
    expect(invalidDirectory.result.uiEvent.presentation.details[0].text).toContain("single line");

    const invalidTitle = await execute(tool, {
      ...baseArguments,
      title: "one\ntwo",
    });
    expect(invalidTitle.result.toolResult.outcome).toBe("blocked");
    expect(invalidTitle.result.uiEvent.presentation.details[0].text).toContain("single line");
  });

  it("binds dependencies before execution and admits an allowed launch model", async () => {
    const { tool, supervisor } = createFixture();
    const arguments_ = {
      ...baseArguments,
      model: "openai/gpt-5.6-sol:high",
    };
    expect(
      tool.describe({ id: "describe", name: TOOL_NAME_SPAWN_AGENT, arguments: arguments_ })
        .presentation.metadata,
    ).toEqual(["/repo/current"]);
    const { dispatch, result } = await execute(tool, arguments_);

    expect(dispatch.startedUiEvent).toMatchObject({
      type: "tool_call_started",
      toolName: TOOL_NAME_SPAWN_AGENT,
      presentation: { subject: "research task", metadata: ["/repo/current"] },
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

  it("shows up to seventeen prompt lines using a balanced preview", async () => {
    const { tool } = createFixture();
    const prompt = Array.from({ length: 20 }, (_, index) => `prompt ${index + 1}`).join("\n");

    const { result } = await execute(tool, { ...baseArguments, prompt });

    expect(result.uiEvent.presentation.details.map((line) => line.text)).toEqual([
      ...Array.from({ length: 8 }, (_, index) => `prompt ${index + 1}`),
      "…4 more lines…",
      ...Array.from({ length: 8 }, (_, index) => `prompt ${index + 13}`),
    ]);
  });

  it("does not duplicate cancellation as a detail", async () => {
    const { tool } = createFixture();
    const controller = new AbortController();
    controller.abort();

    const { result } = await execute(tool, baseArguments, TOOL_NAME_SPAWN_AGENT, controller.signal);

    expect(result.toolResult.outcome).toBe("cancelled");
    expect(result.uiEvent.presentation.details).toEqual([]);
    expect(result.uiEvent.presentation.metadata).not.toContain("Aborted.");
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

  it("inherits the bound parent model and settings without a launch override", async () => {
    const { tool, supervisor, persona } = createFixture();
    const { result } = await execute(tool, baseArguments);

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(supervisor.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        history: expect.objectContaining({
          search: expect.any(Function),
          read: expect.any(Function),
        }),
        runtimeConfig: expect.objectContaining({
          model: persona.model,
          settings: persona.settings,
          tools: ["bash", "write", "edit", "history"],
        }),
      }),
    );
  });

  it("rebuilds prompts for a different working directory without replacing the parent runtime", async () => {
    const resolveSubagentPrompts = vi.fn(async ({ cwd }) => ({
      researcher: `target prompt: ${cwd}`,
    }));
    const sourceConfig = { autoCompact: { enabled: false } };
    const { tool, supervisor, persona } = createFixture({
      config: sourceConfig,
      resolveSubagentPrompts,
    });
    const { result } = await execute(tool, {
      ...baseArguments,
      workingDirectory: "packages/api",
    });

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(resolveSubagentPrompts).toHaveBeenCalledWith({
      cwd: "/repo/current/packages/api",
      persona,
    });
    expect(supervisor.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        config: sourceConfig,
        personaId: persona.id,
        runtimeConfig: expect.objectContaining({
          model: persona.model,
          settings: persona.settings,
          systemPrompt: "target prompt: /repo/current/packages/api",
          workingDirectory: "/repo/current/packages/api",
        }),
      }),
    );
  });

  it("treats a working directory resolving to the parent cwd as omission", async () => {
    const resolveSubagentPrompts = vi.fn();
    const { tool, supervisor, persona } = createFixture({ resolveSubagentPrompts });
    const { result } = await execute(tool, {
      ...baseArguments,
      workingDirectory: ".",
    });

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(resolveSubagentPrompts).not.toHaveBeenCalled();
    expect(supervisor.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeConfig: expect.objectContaining({
          model: persona.model,
          settings: persona.settings,
          systemPrompt: "research prompt",
          workingDirectory: "/repo/current",
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

  it("blocks without falling back when target prompt resolution fails", async () => {
    const resolveSubagentPrompts = vi.fn(async () => {
      throw new Error("target context failed");
    });
    const { tool, supervisor } = createFixture({ resolveSubagentPrompts });
    const { result } = await execute(tool, {
      ...baseArguments,
      workingDirectory: "/tmp/project",
    });

    expect(result.toolResult.outcome).toBe("blocked");
    expect(getText(result.toolResult)).toContain("target context failed");
    expect(supervisor.spawn).not.toHaveBeenCalled();
  });

  it("reports supervisor admission failures as blocked", async () => {
    const supervisor = { spawn: vi.fn(() => ({ ok: false, reason: "active limit reached" })) };
    const { result } = await execute(createFixture({ supervisor }).tool, baseArguments);

    expect(result.toolResult.outcome).toBe("blocked");
    expect(getText(result.toolResult)).toBe("active limit reached");
    expect(result.uiEvent).toMatchObject({
      type: "tool_call_blocked",
      toolName: TOOL_NAME_SPAWN_AGENT,
    });
  });
});
