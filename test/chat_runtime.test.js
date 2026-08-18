import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
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

function createPromptContext(overrides = {}) {
  return {
    cwd: "/repo",
    home: "/home/user",
    repoRoot: "/repo",
    repository: "github.com/example/repo",
    platform: "linux",
    includeAgentContext: true,
    ...overrides,
  };
}

function createRuntime(overrides = {}) {
  return ChatRuntime.create({
    sessionId: "session-1",
    createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
    persona: createPersona(),
    backend: createLocalToolExecutionBackend(),
    modelResolver: resolveModel,
    promptContext: createPromptContext(),
    eventSink: async () => {},
    subagentEventSink: async () => {},
    goalManager: {
      getGoal: () => null,
      createGoal: async (objective) => ({ objective, status: "active" }),
      updateGoal: async () => null,
    },
    history: {
      search: async () => ({ sessions: [] }),
      read: async () => {
        throw new Error("missing history session");
      },
    },
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
    expect(runtime.agent.spec.systemPrompt).toContain("- Session ID: `session-1`");
    expect(runtime.agent.spec.systemPrompt).toContain("- Repository: `github.com/example/repo`");
  });

  it("uses method-specific goal action labels", () => {
    const runtime = createRuntime();
    const expectations = [
      ["get_goal", "checking", "checked"],
      ["create_goal", "creating", "created"],
      ["update_goal", "updating", "updated"],
    ];

    for (const [toolName, running, succeeded] of expectations) {
      const presentation = runtime.agent.spec.tools
        .get(toolName)
        .describe(fauxToolCall(toolName, {})).presentation;
      expect(presentation.actionByStatus.running).toBe(running);
      expect(presentation.actionByStatus.succeeded).toBe(succeeded);
    }
  });

  it("returns the current goal as model-facing text", async () => {
    const runtime = createRuntime({
      goalManager: {
        getGoal: () => ({ objective: "Ship <all> requirements", status: "active" }),
        createGoal: async (objective) => ({ objective, status: "active" }),
        updateGoal: async () => null,
      },
    });
    const getGoal = runtime.agent.spec.tools.get("get_goal");

    const outcome = await getGoal.execute(fauxToolCall("get_goal", {}), {
      agentId: "agent-1",
      turnId: "turn-1",
      assistantMessageId: "assistant-1",
      signal: new AbortController().signal,
      emitActivity: async () => {},
    });

    expect(outcome.content[0].text).toBe(`The session goal is active.

<goal-objective>
Ship &lt;all&gt; requirements
</goal-objective>`);
  });

  it("returns the created goal policy to the model and presents only the full objective", async () => {
    const runtime = createRuntime();
    const createGoal = runtime.agent.spec.tools.get("create_goal");
    const objective = `Ship <all> requirements\n${"x".repeat(400)}\nwithout truncation`;
    const activities = [];

    const outcome = await createGoal.execute(fauxToolCall("create_goal", { objective }), {
      agentId: "agent-1",
      turnId: "turn-1",
      assistantMessageId: "assistant-1",
      signal: new AbortController().signal,
      emitActivity: async (activity) => activities.push(activity),
    });

    expect(outcome.content[0].text).toMatch(/^Session goal created\.\n\nAn active session goal/);
    expect(outcome.content[0].text).toContain(
      `<goal-objective>\nShip &lt;all&gt; requirements\n${"x".repeat(400)}\nwithout truncation\n</goal-objective>`,
    );
    expect(activities.at(-1).presentation.details.map((line) => line.text)).toEqual(
      objective.split("\n"),
    );
  });

  it("returns focused goal execution failures", async () => {
    const runtime = createRuntime({
      goalManager: {
        getGoal: () => null,
        createGoal: async () => {
          throw new Error("goal store unavailable");
        },
        updateGoal: async () => null,
      },
    });
    const createGoal = runtime.agent.spec.tools.get("create_goal");
    const context = {
      agentId: "agent-1",
      turnId: "turn-1",
      assistantMessageId: "assistant-1",
      signal: new AbortController().signal,
      emitActivity: async () => {},
    };

    const failed = await createGoal.execute(
      fauxToolCall("create_goal", { objective: "Ship it" }),
      context,
    );
    expect([failed.outcome, failed.content[0].text]).toEqual([
      "failed",
      "Could not create session goal: goal store unavailable",
    ]);
  });

  it("supplies the authoritative active goal to compaction continuations", () => {
    const runtime = createRuntime({
      goalManager: {
        getGoal: () => ({ objective: "Ship <all> requirements", status: "active" }),
        createGoal: async (objective) => ({ objective, status: "active" }),
        updateGoal: async () => null,
      },
    });

    expect(runtime.agent.getCompactionContinuationSystemMessages()).toEqual([
      expect.stringContaining("<goal-objective>\nShip &lt;all&gt; requirements\n</goal-objective>"),
    ]);
  });

  it("returns model-facing text for goal updates", async () => {
    let goal = { objective: "Initial objective", status: "active" };
    const runtime = createRuntime({
      goalManager: {
        getGoal: () => goal,
        createGoal: async (objective) => ({ objective, status: "active" }),
        updateGoal: async (update) => {
          if (update.status === "complete") return null;
          goal = {
            objective: update.objective ?? goal.objective,
            status: update.status ?? goal.status,
          };
          return goal;
        },
      },
    });
    const updateGoal = runtime.agent.spec.tools.get("update_goal");
    const objective = `Ship <all> requirements\n${"x".repeat(400)}\nwithout truncation`;
    const activities = [];
    const context = {
      agentId: "agent-1",
      turnId: "turn-1",
      assistantMessageId: "assistant-1",
      signal: new AbortController().signal,
      emitActivity: async (activity) => activities.push(activity),
    };

    const active = await updateGoal.execute(fauxToolCall("update_goal", { objective }), context);
    const activePresentation = activities.at(-1).presentation;
    const blocked = await updateGoal.execute(
      fauxToolCall("update_goal", { status: "blocked" }),
      context,
    );
    const blockedPresentation = activities.at(-1).presentation;
    const complete = await updateGoal.execute(
      fauxToolCall("update_goal", { status: "complete" }),
      context,
    );
    const completePresentation = activities.at(-1).presentation;

    expect(active.content[0].text).toMatch(/^Session goal updated\.\n\nAn active session goal/);
    expect(active.content[0].text).toContain(
      `<goal-objective>\nShip &lt;all&gt; requirements\n${"x".repeat(400)}\nwithout truncation\n</goal-objective>`,
    );
    expect(activePresentation.details.map((line) => line.text)).toEqual(objective.split("\n"));
    expect(blocked.content[0].text).toMatch(
      /^Session goal updated\.\n\nThe session goal is now blocked/,
    );
    expect(blocked.content[0].text).not.toContain("An active session goal is in effect");
    expect(blockedPresentation.details.map((line) => line.text)).toEqual(objective.split("\n"));
    expect(complete.content[0].text).toBe("The session goal is complete and has been cleared.");
    expect(completePresentation.details.map((line) => line.text)).toEqual([
      "The session goal is complete and has been cleared.",
    ]);
  });

  it("requires both persona selection and config to expose Nook", () => {
    const configuredWithoutPersona = createRuntime({
      persona: createPersona({ tools: ["bash"] }),
      config: { nook: { domain: "nook.example.com" } },
    });
    const personaWithoutConfig = createRuntime({
      persona: createPersona({ tools: ["bash", "nook"] }),
    });
    const enabled = createRuntime({
      persona: createPersona({ tools: ["bash", "nook"] }),
      config: { nook: { domain: "nook.example.com" } },
    });

    expect(configuredWithoutPersona.agent.spec.tools.schemas.map((tool) => tool.name)).toEqual([
      "bash",
      "tau_docs",
      "get_goal",
      "create_goal",
      "update_goal",
    ]);
    expect(personaWithoutConfig.agent.spec.tools.schemas.map((tool) => tool.name)).toEqual([
      "bash",
      "tau_docs",
      "get_goal",
      "create_goal",
      "update_goal",
    ]);
    expect(enabled.agent.spec.tools.schemas.map((tool) => tool.name)).toEqual([
      "bash",
      "nook",
      "tau_docs",
      "get_goal",
      "create_goal",
      "update_goal",
    ]);
  });

  it("samples with the current persona model settings without changing agent state", async () => {
    const runtime = createRuntime({
      persona: createPersona({ settings: { reasoning: "low" } }),
    });
    const sampledMessage = fauxAssistantMessage("sampled");
    const stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
      async result() {
        return sampledMessage;
      },
    }));
    runtime.agent.spec.model.stream = stream;
    const stateBeforeSample = runtime.snapshot();

    await expect(
      runtime.sample({
        context: { systemPrompt: "Sample in isolation.", messages: [] },
        options: {},
      }),
    ).resolves.toEqual(sampledMessage);

    expect(stream).toHaveBeenCalledWith(
      { systemPrompt: "Sample in isolation.", messages: [] },
      expect.objectContaining({ reasoning: "low" }),
    );

    runtime.setReasoning("high");
    const updatedStream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
      async result() {
        return sampledMessage;
      },
    }));
    runtime.agent.spec.model.stream = updatedStream;
    await runtime.sample({
      context: { systemPrompt: "Sample again.", messages: [] },
      options: {},
    });

    expect(updatedStream).toHaveBeenCalledWith(
      { systemPrompt: "Sample again.", messages: [] },
      expect.objectContaining({ reasoning: "high" }),
    );
    expect(runtime.snapshot()).toEqual(stateBeforeSample);
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
