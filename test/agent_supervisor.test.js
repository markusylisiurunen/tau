import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../dist/core/index.js";
import { personas } from "../dist/core/personas.js";
import { AgentSupervisor } from "../dist/core/subagents/agent_supervisor.js";
import { AgentJobRegistry } from "../dist/core/tools/agent_jobs.js";
import { BashJobRegistry } from "../dist/core/tools/bash_jobs.js";
import { ToolCatalog } from "../dist/core/tools/catalog.js";
import { CodeJobRegistry } from "../dist/core/tools/code_jobs.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { ClientToolBroker } from "../dist/host/client_tool_broker.js";

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
      kind: "native",
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
    config: {},
    backend: createLocalToolExecutionBackend(),
    jobs: new AgentJobRegistry(),
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
  it("binds the parent's MCP manager without resolving servers from the child workspace", async () => {
    const supervisor = new AgentSupervisor({ onEvent: () => {} });
    const mcp = { available: true, listServers: vi.fn(() => [{ name: "host" }]) };
    try {
      const spawned = supervisor.spawn(
        createSpawnOptions({
          runtimeConfig: {
            ...createSpawnOptions().runtimeConfig,
            tools: ["mcp"],
            workingDirectory: "/repo/alternate",
          },
          config: { mcpServers: { target: { type: "stdio", command: "must-not-run" } } },
          mcp,
        }),
      );

      const tool = getRecord(supervisor, spawned.id).runtime.agent.spec.tools.get("code");
      expect(tool.schema.description).toContain(JSON.stringify({ name: "host" }));
      expect(tool.schema.description).not.toContain("target");
      expect(mcp.listServers).toHaveBeenCalledOnce();
      mcp.listServers.mockClear();
      const result = await tool.execute(
        {
          id: "mcp-call",
          name: "code",
          arguments: { code: "printText(JSON.stringify(await tau.mcp.listServers()))" },
        },
        {
          agentId: spawned.id,
          turnId: "turn",
          assistantMessageId: "assistant",
          signal: new AbortController().signal,
          emitActivity: async () => {},
        },
      );
      expect(result.outcome).toBe("succeeded");
      expect(JSON.parse(result.content[0].text)).toEqual([{ name: "host" }]);
      expect(mcp.listServers).toHaveBeenCalledOnce();
      const excluded = supervisor.spawn(createSpawnOptions({ mcp }));
      expect(
        getRecord(supervisor, excluded.id).runtime.agent.spec.tools.get("code"),
      ).toBeUndefined();
    } finally {
      supervisor.reset();
    }
  });

  it("binds configured history access into child runtimes", async () => {
    const supervisor = new AgentSupervisor({ onEvent: () => {} });
    const history = {
      search: vi.fn(),
      read: vi.fn(),
    };
    const spawned = supervisor.spawn(
      createSpawnOptions({
        runtimeConfig: {
          ...createSpawnOptions().runtimeConfig,
          tools: ["history"],
        },
        history,
      }),
    );
    expect(getRecord(supervisor, spawned.id).runtime.agent.spec.tools.schemas).toEqual([
      expect.objectContaining({ name: "code" }),
      ...["list_code_jobs", "read_code_job", "stop_code_job", "wait_for_code_jobs"].map((name) =>
        expect.objectContaining({ name }),
      ),
      expect.objectContaining({ name: "tau_docs" }),
    ]);
    supervisor.reset();
  });

  it("keeps attached-client tools on the main agent across child runs", async () => {
    const broker = new ClientToolBroker();
    const sendCall = vi.fn();
    const registration = broker.registerClient({
      tools: [
        {
          name: "prefill_input",
          description: "Prefill input",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      sendCall,
      sendCancel: vi.fn(),
    });
    registration.attachSession("parent-session");
    const supervisor = new AgentSupervisor({ onEvent: () => {}, recordUsage: () => {} });
    const submit = vi.spyOn(AgentRuntime.prototype, "submit").mockImplementation(async function () {
      expect(this.spec.tools.get("prefill_input")).toBeUndefined();
      expect(this.spec.tools.get("spawn_agent")).toBeUndefined();
      return {
        finalMessage: createAssistant("done"),
        aborted: false,
        terminalResult: { finalMessage: createAssistant("done"), aborted: false },
      };
    });
    try {
      const main = ToolCatalog.createSessionRegistry({
        backend: createLocalToolExecutionBackend(),
        jobs: new AgentJobRegistry(),
        cwd: "/repo",
        config: {},
        persona: { ...personas[0], tools: ["agents"] },
        subagentSystemPrompt: "child system",
        modelResolver: () => undefined,
        supervisor,
        bashJobs: new BashJobRegistry(),
        codeJobs: new CodeJobRegistry(),
        history: {},
        clientTools: () => broker.getToolDefinitions("parent-session"),
      });
      expect(main.get("prefill_input")).toBeDefined();
      const outcome = await main.get("code").execute(
        {
          id: "spawn-call",
          name: "spawn_agent",
          arguments: { code: 'await tau.agents.spawn({ title: "child", prompt: "do work" });' },
        },
        {
          agentId: "parent-agent",
          turnId: "parent-turn",
          assistantMessageId: "parent-origin",
          signal: new AbortController().signal,
          emitActivity: async () => {},
        },
      );
      expect(outcome.outcome).toBe("succeeded");
      const [child] = supervisor.list();
      await supervisor.waitForAgents([child.id]);
      expect(supervisor.getSnapshot(child.id).run.status).toBe("succeeded");
      expect(
        supervisor.sendInput({ mode: "queue", id: child.id, prompt: "follow up" }).status,
      ).toBe("working");
      await supervisor.waitForAgents([child.id]);
      expect(supervisor.getSnapshot(child.id).run.status).toBe("succeeded");
      expect(submit).toHaveBeenCalledTimes(2);
      expect(sendCall).not.toHaveBeenCalled();
    } finally {
      submit.mockRestore();
      registration.unregister();
      supervisor.reset();
    }
  });

  it("supports child wait and follow-up", async () => {
    const events = [];
    const recordUsage = vi.fn();
    const supervisor = new AgentSupervisor({
      onEvent: async (event) => events.push(event),
      recordUsage,
    });
    const spawned = supervisor.spawn(createSpawnOptions());
    const record = getRecord(supervisor, spawned.id);
    expect(record.runtime.agent).toBeInstanceOf(AgentRuntime);
    const responses = [createAssistant("first result"), createAssistant("follow-up result")];
    record.runtime.agent.spec.model.stream = vi.fn(() => createStream(responses.shift()));

    await expect(supervisor.waitForAgents([spawned.id])).resolves.toEqual([
      expect.objectContaining({
        id: spawned.id,
        status: "idle",
        reason: "completed",
      }),
    ]);
    expect(supervisor.getSnapshot(spawned.id)).toMatchObject({
      run: { status: "succeeded", response: "first result" },
      costTotal: 0.01,
    });

    expect(supervisor.sendInput({ mode: "queue", id: spawned.id, prompt: "continue" }).status).toBe(
      "working",
    );
    await expect(supervisor.waitForAgents([spawned.id])).resolves.toEqual([
      expect.objectContaining({
        status: "idle",
        reason: "completed",
      }),
    ]);
    expect(events.filter((event) => event.type === "subagent_spawned")).toHaveLength(1);
    expect(events.filter((event) => event.type === "subagent_run_started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "subagent_finished")).toHaveLength(2);
    expect(
      events.filter((event) => event.type === "subagent_activity").map((event) => event.activity),
    ).toEqual([
      { type: "assistant", text: "first result" },
      { type: "assistant", text: "follow-up result" },
    ]);
    expect(recordUsage).toHaveBeenCalledTimes(2);
    for (const [entry] of recordUsage.mock.calls) {
      expect(entry.agent).toEqual({ type: "subagent" });
      expect(entry.personaId).toBe("parent-persona");
    }
  });

  it("marks compacted subagent state as a potentially stale snapshot", async () => {
    const supervisor = new AgentSupervisor({ onEvent: async () => {}, recordUsage: () => {} });
    const spawned = supervisor.spawn(createSpawnOptions());
    const record = getRecord(supervisor, spawned.id);
    record.runtime.agent.spec.model.stream = vi.fn(() => createStream(createAssistant("done")));

    const context = supervisor.getActiveCompactionContext();

    const states = JSON.parse(context.split("\n\n")[1].split("\n</active-subagents>")[0]);
    expect(states).toEqual([expect.objectContaining({ id: spawned.id, status: "working" })]);
    expect(states[0]).not.toHaveProperty("run");
    await supervisor.waitForAgents([spawned.id]);
  });

  it("retains the latest response for repeated waits", async () => {
    const supervisor = new AgentSupervisor({ onEvent: async () => {}, recordUsage: () => {} });
    const spawned = supervisor.spawn(createSpawnOptions());
    const record = getRecord(supervisor, spawned.id);
    record.runtime.agent.spec.model.stream = vi.fn(() => createStream(createAssistant("retained")));

    const first = await supervisor.waitForAgents([spawned.id]);
    const second = await supervisor.waitForAgents([spawned.id]);

    expect(first).toEqual(second);
    expect(second[0]).toMatchObject({
      status: "idle",
      reason: "completed",
    });
    const trace = supervisor.getTrace(spawned.id);
    const [answer] = trace.trace({ kinds: ["assistant"] }).entries;
    expect(trace.readText(answer.seq)).toEqual({ text: "retained", complete: true });
  });

  it("distinguishes returned and streamed provider errors from successful empty responses", async () => {
    const supervisor = new AgentSupervisor({ onEvent: async () => {}, recordUsage: () => {} });
    const failed = supervisor.spawn(createSpawnOptions());
    const failedRecord = getRecord(supervisor, failed.id);
    failedRecord.runtime.agent.spec.retryPolicy.delayMs = 0;
    failedRecord.runtime.agent.spec.model.stream = vi.fn(() =>
      createStream(
        createAssistant("", { stopReason: "error", errorMessage: "provider overloaded" }),
      ),
    );

    await expect(supervisor.waitForAgents([failed.id])).resolves.toEqual([
      expect.objectContaining({
        status: "idle",
        reason: "failed",
        error: { code: "provider-error", message: "provider overloaded" },
      }),
    ]);

    const rejected = supervisor.spawn(createSpawnOptions());
    const rejectedRecord = getRecord(supervisor, rejected.id);
    rejectedRecord.runtime.agent.spec.retryPolicy = { maxRetries: 0, delayMs: 0 };
    rejectedRecord.runtime.agent.spec.model.stream = vi.fn(() =>
      createFailingStream("incomplete result", new Error("provider connection failed")),
    );

    await expect(supervisor.waitForAgents([rejected.id])).resolves.toEqual([
      expect.objectContaining({
        status: "idle",
        reason: "failed",
        error: { code: "provider-error", message: "provider connection failed" },
      }),
    ]);
    expect(rejectedRecord.runtime.agent.rawHistory.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "incomplete result" }],
      stopReason: "error",
      errorMessage: "provider connection failed",
    });

    const empty = supervisor.spawn(createSpawnOptions());
    const emptyRecord = getRecord(supervisor, empty.id);
    emptyRecord.runtime.agent.spec.model.stream = vi.fn(() => createStream(createAssistant("")));

    await expect(supervisor.waitForAgents([empty.id])).resolves.toEqual([
      expect.objectContaining({
        status: "idle",
        reason: "completed",
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
    const model = { ...personas[0].model, contextWindow: 16_474 };
    const events = [];
    const supervisor = new AgentSupervisor({
      onEvent: async (event) => events.push(event),
      recordUsage: () => {},
    });
    const spawned = supervisor.spawn(
      createSpawnOptions({
        backend,
        runtimeConfig: {
          ...createSpawnOptions().runtimeConfig,
          model,
          tools: ["bash"],
        },
      }),
    );
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
      createStream(createAssistant("compacted summary")),
      createStream(createAssistant("finished after compaction")),
    ];
    const streamModel = vi.fn(() => streams.shift());
    record.runtime.agent.spec.model.stream = streamModel;

    await expect(supervisor.waitForAgents([spawned.id])).resolves.toEqual([
      expect.objectContaining({
        id: spawned.id,
        status: "idle",
        reason: "completed",
      }),
    ]);

    expect(
      record.runtime.agent.rawHistory.some((message) =>
        JSON.stringify(message).includes("compacted summary"),
      ),
    ).toBe(true);
    expect(backend.runBash).toHaveBeenCalledTimes(2);
    const evidence = supervisor.getTrace(spawned.id).trace({}).entries;
    expect(
      evidence
        .filter((entry) => entry.kind === "tool_call")
        .map((entry) => entry.arguments.blocks[0].value.command),
    ).toEqual(["printf first", "printf second"]);
    expect(
      evidence.filter((entry) => entry.kind === "tool_result").map((entry) => entry.outcome),
    ).toEqual(["succeeded", "succeeded"]);
    expect(
      evidence.some((entry) => entry.kind === "notice" && entry.code === "compaction.compacted"),
    ).toBe(true);

    expect(
      events
        .filter((event) => event.type === "subagent_activity" && event.activity.type === "tool")
        .map((event) => event.activity),
    ).toEqual([
      expect.objectContaining({
        type: "tool",
        toolName: "bash",
        outcome: "succeeded",
        presentation: expect.objectContaining({ action: "ran", subject: "printf first" }),
      }),
      expect.objectContaining({
        type: "tool",
        toolName: "bash",
        outcome: "succeeded",
        presentation: expect.objectContaining({ action: "ran", subject: "printf second" }),
      }),
    ]);
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
    const record = getRecord(supervisor, spawned.id);
    const stream = vi.fn(() => createStream(createAssistant("too late")));
    record.runtime.agent.spec.model.stream = stream;

    const interruption = supervisor.interrupt(spawned.id);
    await vi.waitFor(() => expect(record.run.interruptRequested).toBe(true));
    releaseSpawn();

    await expect(interruption).resolves.toMatchObject({
      id: spawned.id,
      status: "idle",
      reason: "interrupted",
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
    const record = getRecord(supervisor, spawned.id);
    record.runtime.agent.spec.model.stream = vi.fn((_context, options) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) =>
          options.signal.addEventListener("abort", resolve, { once: true }),
        );
      },
      async result() {
        return createAssistant("too late");
      },
    }));

    await vi.waitFor(() => expect(record.runtime.agent.status).toBe("running"));
    await expect(supervisor.interrupt(spawned.id)).rejects.toBe(interruptProjection);
    await record.completion;
    expect(record.run.status).toBe("interrupted");
    expect(record.runtime.agent.status).toBe("idle");
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
    const record = getRecord(supervisor, spawned.id);
    record.runtime.agent.submit = vi.fn(async () => {
      markSubmitStarted();
      await submitGate;
      return { aborted: false, stopReason: "stop" };
    });
    await submitStarted;

    const interruption = supervisor.interrupt(spawned.id);
    await vi.waitFor(() => expect(record.run.interruptRequested).toBe(true));
    releaseSubmit();

    await expect(interruption).resolves.toMatchObject({
      id: spawned.id,
      status: "idle",
      reason: "interrupted",
    });
    expect(record.run.failure).toMatchObject({ kind: "interrupted" });
  });

  it("interrupts a running child and reports an interrupted result", async () => {
    const supervisor = new AgentSupervisor({ onEvent: async () => {}, recordUsage: () => {} });
    const spawned = supervisor.spawn(createSpawnOptions());
    const record = getRecord(supervisor, spawned.id);
    record.runtime.agent.spec.model.stream = vi.fn((_context, options) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) =>
          options.signal.addEventListener("abort", resolve, { once: true }),
        );
      },
      async result() {
        return createAssistant("too late");
      },
    }));

    await vi.waitFor(() => expect(record.runtime.agent.status).toBe("running"));
    await expect(supervisor.interrupt(spawned.id)).resolves.toMatchObject({
      id: spawned.id,
      status: "idle",
      reason: "interrupted",
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
    const record = getRecord(supervisor, spawned.id);
    record.runtime.agent.spec.model.stream = vi.fn(() => createStream(createAssistant("done")));

    let settled = false;
    const waiting = supervisor.waitForAgents([spawned.id]).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(finishedEventSeen).toBe(true));
    expect(record.run.status).toBe("succeeded");
    expect(settled).toBe(false);

    releaseFinished();
    await expect(waiting).resolves.toEqual([
      expect.objectContaining({
        id: spawned.id,
        status: "idle",
        reason: "completed",
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
        if (event.type === "subagent_spawned") {
          await progressGate;
        }
      },
    });
    const ids = [];
    for (let index = 0; index < 8; index += 1) {
      const result = supervisor.spawn(
        createSpawnOptions({ originHistoryEntryId: `origin-${index}` }),
      );

      ids.push(result.id);
    }

    expect(() => supervisor.spawn(createSpawnOptions())).toThrow(
      expect.objectContaining({ code: "operation_failed" }),
    );
    supervisor.retainOrigins(new Set(["origin-0"]));
    expect(supervisor.list().map((snapshot) => snapshot.id)).toEqual([ids[0]]);
    expect(supervisor.records.size).toBe(1);
    releaseProgress();
    await supervisor.interrupt(ids[0]);
  });
});

it("isolates main and sibling jobs while retaining child jobs across follow-ups", async () => {
  const jobs = new AgentJobRegistry();
  const supervisor = new AgentSupervisor({ onEvent: () => {} });
  const submit = vi.spyOn(AgentRuntime.prototype, "submit").mockResolvedValue({
    finalMessage: createAssistant("done"),
    aborted: false,
    terminalResult: { finalMessage: createAssistant("done"), aborted: false },
  });
  const backend = createLocalToolExecutionBackend();
  backend.runBash = vi.fn(
    (_command, options) =>
      new Promise((resolve) => {
        options.onStarted?.();
        options.signal.addEventListener(
          "abort",
          () =>
            resolve({
              exitCode: null,
              aborted: true,
              closeSignal: "SIGTERM",
              truncated: false,
            }),
          { once: true },
        );
      }),
  );
  const mainJobs = jobs.create();
  const main = ToolCatalog.createSubagentRegistry(
    ["bash"],
    backend,
    "/repo",
    {},
    mainJobs.bashJobs,
    mainJobs.codeJobs,
  );
  const execute = (registry, name, args) =>
    registry.get(name).execute(
      { id: "call", name, arguments: args },
      {
        agentId: "test",
        turnId: "turn",
        assistantMessageId: "message",
        signal: new AbortController().signal,
        emitActivity: async () => {},
      },
    );
  try {
    const children = [0, 1].map(() => {
      const options = createSpawnOptions({ backend, jobs });
      options.runtimeConfig.tools = ["bash"];
      const result = supervisor.spawn(options);

      return result.id;
    });
    await supervisor.waitForAgents(children);
    const registries = [
      main,
      ...children.map((id) => getRecord(supervisor, id).runtime.agent.spec.tools),
    ];
    for (const [owner, registry] of registries.entries()) {
      for (const kind of ["bash", "code"]) {
        const started = await execute(
          registry,
          kind,
          kind === "bash"
            ? { command: "server", background: true }
            : { code: 'printText("owned");', background: true },
        );
        expect(started.outcome).toBe("succeeded");
        const id = started.content[0].text.match(/job ([^ ]+)/)[1];
        for (const [index, other] of registries.entries()) {
          const listed = await execute(other, `list_${kind}_jobs`, {});
          expect(listed.content[0].text.includes(id)).toBe(index === owner);
          for (const operation of ["read", "stop", "wait"]) {
            if (index === owner && operation !== "read") continue;
            const name =
              operation === "wait" ? `wait_for_${kind}_jobs` : `${operation}_${kind}_job`;
            const args = operation === "wait" ? { ids: [id], timeout: 1 } : { id };
            expect((await execute(other, name, args)).outcome).toBe(
              index === owner ? "succeeded" : "failed",
            );
          }
        }
        if (owner === 1) {
          expect(
            supervisor.sendInput({ mode: "queue", id: children[0], prompt: "follow up" }).status,
          ).toBe("working");
          await supervisor.waitForAgents([children[0]]);
          expect(
            (
              await execute(
                getRecord(supervisor, children[0]).runtime.agent.spec.tools,
                `read_${kind}_job`,
                { id },
              )
            ).outcome,
          ).toBe("succeeded");
        }
      }
    }
    supervisor.reset();
    expect(jobs.hasRunning).toBe(true);
    expect(jobs.agents.size).toBe(3);
    await jobs.dispose();
    await vi.waitFor(() => expect(jobs.agents.size).toBe(1));
    expect(jobs.hasRunning).toBe(false);
    expect(() => jobs.create()).toThrow();
  } finally {
    await jobs.dispose();
    supervisor.reset();
    submit.mockRestore();
  }
});

describe("worker conversation scheduling", () => {
  it("waits through FIFO queued inputs and retains earlier assistant messages", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const supervisor = new AgentSupervisor({ onEvent: () => {}, recordUsage: () => {} });
    const spawned = supervisor.spawn(createSpawnOptions());
    const record = getRecord(supervisor, spawned.id);
    const answers = ["first", "second", "third"];
    record.runtime.agent.spec.model.stream = vi.fn(() =>
      createStream(createAssistant(answers.shift()), gate),
    );
    supervisor.sendInput({ id: record.id, prompt: "second input", mode: "queue" });
    supervisor.sendInput({ id: record.id, prompt: "third input", mode: "queue" });
    expect(supervisor.read(record.id).pending.queue).toBe(2);
    const wait = supervisor.waitForAgents([record.id]);
    release();
    await wait;
    expect(supervisor.read(record.id)).toMatchObject({
      status: "idle",
      reason: "completed",
      pending: { queue: 0, steer: 0 },
    });
    expect(
      supervisor
        .getTrace(record.id)
        .trace({ kinds: ["assistant"] })
        .entries.map((entry) => supervisor.getTrace(record.id).readText(entry.seq).text),
    ).toEqual(["first", "second", "third"]);
    supervisor.reset();
  });

  it("steers at a native boundary and settles with the continuation answer", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const supervisor = new AgentSupervisor({ onEvent: () => {}, recordUsage: () => {} });
    const spawned = supervisor.spawn(createSpawnOptions());
    const record = getRecord(supervisor, spawned.id);
    const answers = ["preamble", "steered answer"];
    record.runtime.agent.spec.model.stream = vi.fn(() =>
      createStream(createAssistant(answers.shift()), gate),
    );
    await vi.waitFor(() => expect(record.runtime.agent.status).toBe("running"));
    supervisor.sendInput({ id: record.id, prompt: "change focus", mode: "steer" });
    release();
    await supervisor.waitForAgents([record.id]);
    expect(record.run.response).toBe("steered answer");
    expect(
      supervisor
        .getTrace(record.id)
        .trace({ kinds: ["input"] })
        .entries.at(-1).mode,
    ).toBe("steer");
    supervisor.reset();
  });

  it("cancels a wait independently and clears queued work on nonblocking interruption", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const supervisor = new AgentSupervisor({ onEvent: () => {}, recordUsage: () => {} });
    const spawned = supervisor.spawn(createSpawnOptions());
    const record = getRecord(supervisor, spawned.id);
    record.runtime.agent.spec.model.stream = vi.fn(() =>
      createStream(createAssistant("done"), gate),
    );
    supervisor.sendInput({ id: record.id, prompt: "queued", mode: "queue" });
    await expect(supervisor.waitForAgents([record.id], AbortSignal.abort())).rejects.toThrow();
    expect(supervisor.read(record.id).status).toBe("working");
    await supervisor.interrupt(record.id, undefined, false);
    expect(supervisor.read(record.id)).toMatchObject({ status: "stopping", pending: { queue: 0 } });
    release();
    await supervisor.waitForAgents([record.id]);
    expect(supervisor.read(record.id)).toMatchObject({ status: "idle", reason: "interrupted" });
    expect(
      supervisor
        .getTrace(record.id)
        .trace({ kinds: ["notice"] })
        .entries.some((entry) => entry.code === "input.discarded"),
    ).toBe(true);
    supervisor.reset();
  });
});

it("keeps background orchestration attribution and cancels only its wait", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const supervisor = new AgentSupervisor({ onEvent: () => {}, recordUsage: () => {} });
  const jobs = new AgentJobRegistry();
  const codeJobs = new CodeJobRegistry();
  const submit = vi.spyOn(AgentRuntime.prototype, "submit").mockImplementation(async () => {
    await gate;
    return { terminalResult: { finalMessage: createAssistant("done"), aborted: false } };
  });
  try {
    const registry = ToolCatalog.createSessionRegistry({
      backend: createLocalToolExecutionBackend(),
      jobs,
      codeJobs,
      bashJobs: new BashJobRegistry(),
      cwd: "/repo",
      config: {},
      persona: { ...personas[0], tools: ["agents"] },
      subagentSystemPrompt: "child system",
      modelResolver: () => undefined,
      supervisor,
      history: {},
    });
    const tool = registry.get("code");
    const launched = await tool.execute(
      {
        id: "orchestrate",
        name: "code",
        arguments: {
          background: true,
          code: 'const worker = await tau.agents.spawn({ title: "child", prompt: "task" }); await tau.agents.waitUntilIdle({ id: worker.id }); printText("done");',
        },
      },
      {
        agentId: "main",
        turnId: "turn",
        assistantMessageId: "launch-origin",
        signal: new AbortController().signal,
        emitActivity: async () => {},
      },
    );
    expect(launched.outcome).toBe("succeeded");
    await vi.waitFor(() => expect(supervisor.list()).toHaveLength(1));
    const [worker] = supervisor.list();
    expect(getRecord(supervisor, worker.id).originHistoryEntryId).toBe("launch-origin");
    await codeJobs.dispose();
    expect(supervisor.read(worker.id).status).toBe("working");
    release();
    await supervisor.waitForAgents([worker.id]);
    expect(supervisor.read(worker.id)).toMatchObject({ status: "idle", reason: "completed" });
  } finally {
    release();
    submit.mockRestore();
    supervisor.reset();
    await codeJobs.dispose();
  }
});
