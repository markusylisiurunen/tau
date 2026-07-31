import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../dist/core/index.js";
import { personas } from "../dist/core/personas.js";
import { AgentSupervisor } from "../dist/core/subagents/agent_supervisor.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";

function createAssistant(text) {
  const model = personas[0].model;
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text }],
    stopReason: "stop",
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
  it("constructs ordinary AgentRuntime children and supports wait and follow-up", async () => {
    const events = [];
    const recordUsage = vi.fn();
    const supervisor = new AgentSupervisor({
      onEvent: async (event) => events.push(event),
      recordUsage,
    });
    const spawned = supervisor.spawn(createSpawnOptions());
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error(spawned.reason);
    const record = getRecord(supervisor, spawned.id);
    expect(record.runtime).toBeInstanceOf(AgentRuntime);
    const responses = [createAssistant("first result"), createAssistant("follow-up result")];
    record.runtime.spec.model.stream = vi.fn(() => createStream(responses.shift()));

    await expect(supervisor.waitForAgents([spawned.id])).resolves.toEqual([
      expect.objectContaining({ id: spawned.id, status: "success", finalText: "first result" }),
    ]);
    expect(supervisor.getSnapshot(spawned.id)).toMatchObject({
      status: "success",
      turns: 1,
      costTotal: 0.01,
    });

    expect(supervisor.sendInput({ id: spawned.id, prompt: "continue" })).toEqual({
      ok: true,
      id: spawned.id,
      name: "default",
      title: "child task",
    });
    await expect(supervisor.waitForAgents([spawned.id])).resolves.toEqual([
      expect.objectContaining({ status: "success", finalText: "follow-up result", turns: 2 }),
    ]);
    expect(events.filter((event) => event.type === "subagent_spawned")).toHaveLength(2);
    expect(events.filter((event) => event.type === "subagent_finished")).toHaveLength(2);
    expect(recordUsage).toHaveBeenCalledTimes(2);
    for (const [entry] of recordUsage.mock.calls) {
      expect(entry.agent).toEqual({ type: "subagent", name: "default" });
    }
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
    const record = getRecord(supervisor, spawned.id);
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

    await expect(supervisor.waitForAgents([spawned.id])).resolves.toEqual([
      expect.objectContaining({
        id: spawned.id,
        status: "success",
        finalText: "finished after compaction",
        toolCalls: 2,
      }),
    ]);

    expect(streamModel).toHaveBeenCalledTimes(3);
    expect(
      record.runtime.rawHistory.some((message) =>
        JSON.stringify(message).includes("compacted summary"),
      ),
    ).toBe(true);
    expect(backend.runBash).toHaveBeenCalledTimes(2);
  });

  it("terminates a child before its startup event finishes", async () => {
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
    const record = getRecord(supervisor, spawned.id);
    const stream = vi.fn(() => createStream(createAssistant("too late")));
    record.runtime.spec.model.stream = stream;

    const termination = supervisor.terminate(spawned.id);
    await vi.waitFor(() => expect(record.abortRequested).toBe(true));
    releaseSpawn();

    await expect(termination).resolves.toMatchObject({ id: spawned.id, status: "aborted" });
    expect(stream).not.toHaveBeenCalled();
  });

  it("terminates a running child and reports an aborted result", async () => {
    const supervisor = new AgentSupervisor({ onEvent: async () => {}, recordUsage: () => {} });
    const spawned = supervisor.spawn(createSpawnOptions());
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error(spawned.reason);
    const record = getRecord(supervisor, spawned.id);
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
    await expect(supervisor.terminate(spawned.id)).resolves.toMatchObject({
      id: spawned.id,
      status: "aborted",
    });
    expect(supervisor.getActiveCount()).toBe(0);
  });

  it("enforces the active limit and cleans records removed by parent rewind", async () => {
    let releaseProgress;
    const progressGate = new Promise((resolve) => {
      releaseProgress = resolve;
    });
    const supervisor = new AgentSupervisor({
      recordUsage: () => {},
      onEvent: async (event) => {
        if (event.type === "subagent_progress" && event.text === "assistant: thinking") {
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
      if (result.ok) ids.push(result.id);
    }

    expect(supervisor.spawn(createSpawnOptions())).toEqual({
      ok: false,
      reason: expect.stringContaining("Subagent limit reached"),
    });
    supervisor.retainOrigins(new Set(["origin-0"]));
    expect(supervisor.listSnapshots().map((snapshot) => snapshot.id)).toEqual([ids[0]]);
    for (const id of ids.slice(1)) {
      expect(getRecord.bind(undefined, supervisor, id)).toThrow(`missing child ${id}`);
    }
    releaseProgress();
    await supervisor.terminate(ids[0]);
  });
});
