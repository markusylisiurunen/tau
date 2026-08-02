import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../dist/core/index.js";
import { personas } from "../dist/core/personas.js";
import { AgentSupervisor } from "../dist/core/subagents/agent_supervisor.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";

function createAssistant(text, options = {}) {
  const model = personas[0].model;
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text }],
    stopReason: options.stopReason ?? "stop",
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    usage: {
      input: 2,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    },
    timestamp: Date.now(),
  };
}

function createStream(message, gate) {
  return {
    async *[Symbol.asyncIterator]() {
      if (gate) await gate;
      yield* [];
    },
    async result() {
      return message;
    },
  };
}

function createFailingStream(partialText, error) {
  const partial = createAssistant(partialText);
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "text_delta", contentIndex: 0, delta: partialText, partial };
      throw error;
    },
    async result() {
      throw error;
    },
  };
}

function createSpawnOptions(overrides = {}) {
  return {
    runtimeConfig: {
      name: "default",
      systemPrompt: "child system",
      description: "child",
      workingDirectory: "/repo",
      model: personas[0].model,
      settings: { reasoning: "medium" },
      tools: [],
    },
    prompt: "do work",
    title: "child task",
    originHistoryEntryId: "parent-origin",
    config: { autoCompact: { enabled: false } },
    backend: createLocalToolExecutionBackend(),
    personaId: "parent-persona",
    ...overrides,
  };
}

function getRecord(supervisor, id) {
  const record = supervisor.records.get(id);
  if (!record) throw new Error(`missing child ${id}`);
  return record;
}

describe("AgentSupervisor", () => {
  it("supports child wait and follow-up", async () => {
    const events = [];
    const recordUsage = vi.fn();
    const supervisor = new AgentSupervisor({
      onEvent: async (event) => events.push(event),
      recordUsage,
    });
    const spawned = supervisor.spawn(createSpawnOptions());
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error(spawned.reason);
    const record = getRecord(supervisor, spawned.state.id);
    expect(record.runtime).toBeInstanceOf(AgentRuntime);
    const responses = [createAssistant("first result"), createAssistant("follow-up result")];
    record.runtime.spec.model.stream = vi.fn(() => createStream(responses.shift()));

    await expect(supervisor.waitForAgents([spawned.state.id])).resolves.toEqual([
      expect.objectContaining({
        id: spawned.state.id,
        run: expect.objectContaining({
          status: "succeeded",
          response: "first result",
        }),
      }),
    ]);
    expect(supervisor.getSnapshot(spawned.state.id)).toMatchObject({
      run: { status: "succeeded", response: "first result" },
      costTotal: 0.01,
    });

    expect(supervisor.sendInput({ id: spawned.state.id, prompt: "continue" }).ok).toBe(true);
    await expect(supervisor.waitForAgents([spawned.state.id])).resolves.toEqual([
      expect.objectContaining({
        run: expect.objectContaining({
          revision: 2,
          status: "succeeded",
          response: "follow-up result",
        }),
      }),
    ]);
    expect(events.filter((event) => event.type === "subagent_spawned")).toHaveLength(1);
    expect(events.filter((event) => event.type === "subagent_run_started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "subagent_finished")).toHaveLength(2);
    expect(recordUsage).toHaveBeenCalledTimes(2);
    for (const [entry] of recordUsage.mock.calls) {
      expect(entry.agent).toEqual({ type: "subagent", name: "default" });
      expect(entry.personaId).toBe("parent-persona");
    }
  });

  it("marks compacted subagent state as a potentially stale snapshot", async () => {
    const supervisor = new AgentSupervisor({ onEvent: async () => {}, recordUsage: () => {} });
    const spawned = supervisor.spawn(createSpawnOptions());
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error(spawned.reason);
    const record = getRecord(supervisor, spawned.state.id);
    record.runtime.spec.model.stream = vi.fn(() => createStream(createAssistant("done")));

    const context = supervisor.getActiveCompactionContext();

    expect(context).toContain(
      "This subagent state was captured at the time of compaction and may have changed since then.",
    );
    expect(context).toContain("Use list_agents to inspect the current state.");
    expect(context).toContain(`\`${spawned.state.id}\` · child task`);
    expect(context).not.toContain("Agents ·");
    await supervisor.waitForAgents([spawned.state.id]);
  });

  it("retains the latest response for repeated waits", async () => {
    const supervisor = new AgentSupervisor({ onEvent: async () => {}, recordUsage: () => {} });
    const spawned = supervisor.spawn(createSpawnOptions());
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error(spawned.reason);
    const record = getRecord(supervisor, spawned.state.id);
    record.runtime.spec.model.stream = vi.fn(() => createStream(createAssistant("retained")));

    const first = await supervisor.waitForAgents([spawned.state.id]);
    const second = await supervisor.waitForAgents([spawned.state.id]);

    expect(first).toEqual(second);
    expect(second[0]).toMatchObject({
      run: { status: "succeeded", response: "retained" },
    });
  });

  it("distinguishes returned and streamed provider errors from successful empty responses", async () => {
    const supervisor = new AgentSupervisor({ onEvent: async () => {}, recordUsage: () => {} });
    const failed = supervisor.spawn(createSpawnOptions());
    expect(failed.ok).toBe(true);
    if (!failed.ok) throw new Error(failed.reason);
    const failedRecord = getRecord(supervisor, failed.state.id);
    failedRecord.runtime.spec.model.stream = vi.fn(() =>
      createStream(
        createAssistant("", { stopReason: "error", errorMessage: "provider overloaded" }),
      ),
    );

    await expect(supervisor.waitForAgents([failed.state.id])).resolves.toEqual([
      expect.objectContaining({
        run: expect.objectContaining({
          status: "failed",
          failure: {
            kind: "provider-error",
            message: "provider overloaded",
            stopReason: "error",
          },
        }),
      }),
    ]);

    const rejected = supervisor.spawn(createSpawnOptions());
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) throw new Error(rejected.reason);
    const rejectedRecord = getRecord(supervisor, rejected.state.id);
    rejectedRecord.runtime.spec.retryPolicy = { maxRetries: 0, delayMs: 0 };
    rejectedRecord.runtime.spec.model.stream = vi.fn(() =>
      createFailingStream("incomplete result", new Error("provider connection failed")),
    );

    await expect(supervisor.waitForAgents([rejected.state.id])).resolves.toEqual([
      expect.objectContaining({
        run: expect.objectContaining({
          status: "failed",
          failure: {
            kind: "provider-error",
            message: "provider connection failed",
            stopReason: "error",
          },
        }),
      }),
    ]);
    expect(rejectedRecord.runtime.rawHistory.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "incomplete result" }],
      stopReason: "error",
      errorMessage: "provider connection failed",
    });

    const empty = supervisor.spawn(createSpawnOptions());
    expect(empty.ok).toBe(true);
    if (!empty.ok) throw new Error(empty.reason);
    const emptyRecord = getRecord(supervisor, empty.state.id);
    emptyRecord.runtime.spec.model.stream = vi.fn(() => createStream(createAssistant("")));

    await expect(supervisor.waitForAgents([empty.state.id])).resolves.toEqual([
      expect.objectContaining({
        run: expect.objectContaining({ status: "succeeded", response: "" }),
      }),
    ]);
  });

  it("auto-compacts a child between tool subturns through the shared runtime", async () => {
    const backend = createLocalToolExecutionBackend();
    vi.spyOn(backend, "runBash").mockResolvedValue({
      output: "ok",
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    const model = { ...personas[0].model, contextWindow: 100 };
    const supervisor = new AgentSupervisor({ onEvent: async () => {}, recordUsage: () => {} });
    const spawned = supervisor.spawn(
      createSpawnOptions({
        backend,
        config: {
          autoCompact: { enabled: true, reserveTokens: 10, keepRecentTokens: 1 },
        },
        runtimeConfig: {
          ...createSpawnOptions().runtimeConfig,
          model,
          tools: ["bash"],
        },
      }),
    );
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error(spawned.reason);
    const record = getRecord(supervisor, spawned.state.id);
    const calls = [
      {
        id: "bash-1",
        type: "toolCall",
        name: "bash",
        arguments: { command: "printf first" },
      },
      {
        id: "bash-2",
        type: "toolCall",
        name: "bash",
        arguments: { command: "printf second" },
      },
    ];
    const toolMessage = {
      ...createAssistant(""),
      content: calls,
      stopReason: "toolUse",
      usage: {
        input: 89,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 91,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const streams = [
      {
        async *[Symbol.asyncIterator]() {
          for (const [contentIndex, toolCall] of calls.entries()) {
            yield { type: "toolcall_start", contentIndex, partial: toolMessage };
            yield { type: "toolcall_end", contentIndex, toolCall, partial: toolMessage };
          }
        },
        async result() {
          return toolMessage;
        },
      },
      createStream(
        createAssistant(
          "compacted summary\n\n<preserved-user-message-ids>\n[]\n</preserved-user-message-ids>",
        ),
      ),
      createStream(createAssistant("finished after compaction")),
    ];
    const streamModel = vi.fn(() => streams.shift());
    record.runtime.spec.model.stream = streamModel;

    await expect(supervisor.waitForAgents([spawned.state.id])).resolves.toEqual([
      expect.objectContaining({
        id: spawned.state.id,
        run: expect.objectContaining({
          status: "succeeded",
          response: "finished after compaction",
        }),
      }),
    ]);

    expect(
      record.runtime.rawHistory.some((message) =>
        JSON.stringify(message).includes("compacted summary"),
      ),
    ).toBe(true);
    expect(backend.runBash).toHaveBeenCalledTimes(2);
  });

  it("interrupts a child before its startup event finishes", async () => {
    let releaseSpawn;
    const spawnGate = new Promise((resolve) => {
      releaseSpawn = resolve;
    });
    const supervisor = new AgentSupervisor({
      onEvent: async (event) => {
        if (event.type === "subagent_spawned") {
          await spawnGate;
        }
      },
      recordUsage: () => {},
    });
    const spawned = supervisor.spawn(createSpawnOptions());
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error(spawned.reason);
    const record = getRecord(supervisor, spawned.state.id);
    const stream = vi.fn(() => createStream(createAssistant("too late")));
    record.runtime.spec.model.stream = stream;

    const interruption = supervisor.interrupt(spawned.state.id);
    await vi.waitFor(() => expect(record.run.interruptRequested).toBe(true));
    releaseSpawn();

    await expect(interruption).resolves.toMatchObject({
      id: spawned.state.id,
      run: { status: "interrupted", failure: { kind: "interrupted" } },
    });
    expect(stream).not.toHaveBeenCalled();
  });

  it("interrupts a child before publishing its interruption request", async () => {
    const interruptProjection = new Error("interrupt projection failed");
    const supervisor = new AgentSupervisor({
      onEvent: async (event) => {
        if (event.type === "subagent_interrupt_requested") throw interruptProjection;
      },
      recordUsage: () => {},
    });
    const spawned = supervisor.spawn(createSpawnOptions());
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error(spawned.reason);
    const record = getRecord(supervisor, spawned.state.id);
    record.runtime.spec.model.stream = vi.fn((_context, options) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) =>
          options.signal.addEventListener("abort", resolve, { once: true }),
        );
      },
      async result() {
        return createAssistant("too late");
      },
    }));

    await vi.waitFor(() => expect(record.runtime.status).toBe("running"));
    await expect(supervisor.interrupt(spawned.state.id)).rejects.toBe(interruptProjection);
    await expect(record.completion).resolves.toMatchObject({
      run: { status: "interrupted", failure: { kind: "interrupted" } },
    });
    expect(record.runtime.status).toBe("idle");
  });

  it("keeps a requested interruption when the child races to natural completion", async () => {
    let markSubmitStarted;
    const submitStarted = new Promise((resolve) => {
      markSubmitStarted = resolve;
    });
    let releaseSubmit;
    const submitGate = new Promise((resolve) => {
      releaseSubmit = resolve;
    });
    const supervisor = new AgentSupervisor({ onEvent: async () => {}, recordUsage: () => {} });
    const spawned = supervisor.spawn(createSpawnOptions());
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error(spawned.reason);
    const record = getRecord(supervisor, spawned.state.id);
    record.runtime.submit = vi.fn(async () => {
      markSubmitStarted();
      await submitGate;
      return { aborted: false, stopReason: "stop" };
    });
    await submitStarted;

    const interruption = supervisor.interrupt(spawned.state.id);
    await vi.waitFor(() => expect(record.run.interruptRequested).toBe(true));
    releaseSubmit();

    await expect(interruption).resolves.toMatchObject({
      id: spawned.state.id,
      run: { status: "interrupted", failure: { kind: "interrupted" } },
    });
    expect(record.run.failure).toMatchObject({ kind: "interrupted" });
  });

  it("interrupts a running child and reports an interrupted result", async () => {
    const supervisor = new AgentSupervisor({ onEvent: async () => {}, recordUsage: () => {} });
    const spawned = supervisor.spawn(createSpawnOptions());
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error(spawned.reason);
    const record = getRecord(supervisor, spawned.state.id);
    record.runtime.spec.model.stream = vi.fn((_context, options) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) =>
          options.signal.addEventListener("abort", resolve, { once: true }),
        );
      },
      async result() {
        return createAssistant("too late");
      },
    }));

    await vi.waitFor(() => expect(record.runtime.status).toBe("running"));
    await expect(supervisor.interrupt(spawned.state.id)).resolves.toMatchObject({
      id: spawned.state.id,
      run: { status: "interrupted", failure: { kind: "interrupted" } },
    });
    expect(supervisor.getActiveCount()).toBe(0);
  });

  it("waits for finished-event delivery before resolving waiters", async () => {
    let releaseFinished;
    const finishedGate = new Promise((resolve) => {
      releaseFinished = resolve;
    });
    let finishedEventSeen = false;
    const supervisor = new AgentSupervisor({
      onEvent: async (event) => {
        if (event.type === "subagent_finished") {
          finishedEventSeen = true;
          await finishedGate;
        }
      },
      recordUsage: () => {},
    });
    const spawned = supervisor.spawn(createSpawnOptions());
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error(spawned.reason);
    const record = getRecord(supervisor, spawned.state.id);
    record.runtime.spec.model.stream = vi.fn(() => createStream(createAssistant("done")));

    let settled = false;
    const waiting = supervisor.waitForAgents([spawned.state.id]).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(finishedEventSeen).toBe(true));
    expect(record.run.status).toBe("succeeded");
    expect(settled).toBe(false);

    releaseFinished();
    await expect(waiting).resolves.toEqual([
      expect.objectContaining({
        id: spawned.state.id,
        run: expect.objectContaining({ status: "succeeded", response: "done" }),
      }),
    ]);
  });

  it("enforces the active limit and cleans records removed by parent rewind", async () => {
    let releaseProgress;
    const progressGate = new Promise((resolve) => {
      releaseProgress = resolve;
    });
    const supervisor = new AgentSupervisor({
      recordUsage: () => {},
      onEvent: async (event) => {
        if (event.type === "subagent_activity" && event.text === "assistant: thinking") {
          await progressGate;
        }
      },
    });
    const ids = [];
    for (let index = 0; index < 8; index += 1) {
      const result = supervisor.spawn(
        createSpawnOptions({ originHistoryEntryId: `origin-${index}` }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) ids.push(result.state.id);
    }

    expect(supervisor.spawn(createSpawnOptions())).toEqual({
      ok: false,
      reason: expect.stringContaining("Subagent limit reached"),
    });
    supervisor.retainOrigins(new Set(["origin-0"]));
    expect(supervisor.listSnapshots().map((snapshot) => snapshot.id)).toEqual([ids[0]]);
    expect(supervisor.records.size).toBe(1);
    releaseProgress();
    await supervisor.interrupt(ids[0]);
  });
});
