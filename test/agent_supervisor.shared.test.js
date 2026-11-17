import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../dist/core/agent/agent_runtime.js";
import { NotificationInbox } from "../dist/core/agent/notification_inbox.js";
import { personas } from "../dist/core/personas.js";
import { renderSubagentPrefixPrompt } from "../dist/core/static/index.js";
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

function createSpawnOptions(overrides = {}) {
  return {
    parentId: "main",
    notifyOnCompletion: false,
    launchEpoch: 0,
    runtimeConfig: {
      kind: "native",
      systemPrompt: "child system",
      autoCompactThresholdTokens: 80000,
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
  it("notifies every subscribed direct-child idle transition independently of waits", async () => {
    const completions = [];
    const supervisor = new AgentSupervisor({
      mainAgentId: "main",
      onEvent: () => {},
      onCompletion: (state) => completions.push(state),
    });
    const child = supervisor.spawn(createSpawnOptions({ notifyOnCompletion: true }));
    const record = getRecord(supervisor, child.id);
    record.runtime.agent.spec.model.stream = () => createStream(createAssistant("done"));
    await supervisor.waitForAgents([child.id]);
    expect(completions.map((state) => state.run.revision)).toEqual([1]);
    supervisor.setCompletionNotification("main", child.id, false);
    supervisor.sendInput({ id: child.id, prompt: "again", mode: "queue" });
    await supervisor.waitForAgents([child.id]);
    expect(completions).toHaveLength(1);
    supervisor.setCompletionNotification("main", child.id, true);
    supervisor.sendInput({ id: child.id, prompt: "again", mode: "queue" });
    await supervisor.waitForAgents([child.id]);
    expect(completions.map((state) => state.run.revision)).toEqual([1, 3]);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    record.runtime.agent.spec.model.stream = () => createStream(createAssistant("slow"), gate);
    supervisor.sendInput({ id: child.id, prompt: "slow", mode: "queue" });
    await vi.waitFor(() => expect(supervisor.getSnapshot(child.id).availability).toBe("running"));
    const interrupted = supervisor.scope("main").interrupt(child.id);
    release();
    await interrupted;
    expect(completions).toHaveLength(2);
    record.runtime.agent.spec.model.stream = () => createStream(createAssistant("done"));
    supervisor.sendInput({ id: child.id, prompt: "again", mode: "queue" });
    await supervisor.waitForAgents([child.id]);
    expect(completions).toHaveLength(3);
    record.canDelegate = true;
    const nested = supervisor.spawn(
      createSpawnOptions({ parentId: child.id, launchEpoch: supervisor.prepareSpawn(child.id) }),
    );
    getRecord(supervisor, nested.id).runtime.agent.spec.model.stream = () =>
      createStream(createAssistant("nested"));
    await supervisor.waitForAgents([nested.id]);
    expect(completions).toHaveLength(3);
    expect(() => supervisor.setCompletionNotification("main", nested.id, true)).toThrow();
    expect(() =>
      supervisor.spawn(createSpawnOptions({ parentId: child.id, notifyOnCompletion: true })),
    ).toThrow();
    supervisor.dispose();
  });

  it("opens native history only after runtime construction succeeds", () => {
    const openHistory = vi.fn();
    const supervisor = new AgentSupervisor({
      mainAgentId: "main",
      onEvent: () => {},
      openHistory,
    });
    const registry = vi.spyOn(ToolCatalog, "createSubagentRegistry").mockImplementationOnce(() => {
      throw new Error("registry unavailable");
    });
    try {
      expect(() => supervisor.spawn(createSpawnOptions())).toThrow();
      expect(openHistory).not.toHaveBeenCalled();
      expect(supervisor.list()).toEqual([]);
    } finally {
      registry.mockRestore();
      supervisor.reset();
    }
  });

  it("rejects delegation tools without their management dependencies before creating jobs", () => {
    const supervisor = new AgentSupervisor({
      mainAgentId: "main",
      onEvent: vi.fn(),
    });
    const options = createSpawnOptions();
    options.runtimeConfig.tools = ["agents"];
    const createJobs = vi.spyOn(options.jobs, "create");

    expect(() => supervisor.spawn(options)).toThrow();
    expect(createJobs).not.toHaveBeenCalled();
    expect(supervisor.list()).toEqual([]);
  });

  it("binds the parent's MCP manager without resolving servers from the child workspace", async () => {
    const supervisor = new AgentSupervisor({
      mainAgentId: "main",
      onEvent: () => {},
    });
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
    const supervisor = new AgentSupervisor({
      onCompletion: () => {},
      mainAgentId: "main",
      onEvent: () => {},
      recordUsage: () => {},
    });
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
        notifications: new NotificationInbox(),
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

  it("interrupts a child before its startup event finishes", async () => {
    let releaseSpawn;
    const spawnGate = new Promise((resolve) => {
      releaseSpawn = resolve;
    });
    const supervisor = new AgentSupervisor({
      mainAgentId: "main",
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

  it("settles active waiters when disposal removes a child awaiting its startup event", async () => {
    let releaseSpawn;
    const spawnGate = new Promise((resolve) => {
      releaseSpawn = resolve;
    });
    const events = [];
    const supervisor = new AgentSupervisor({
      mainAgentId: "main",
      onEvent: async (event) => {
        events.push(event);
        if (event.type === "subagent_spawned") await spawnGate;
      },
    });
    const spawned = supervisor.spawn(createSpawnOptions());
    const record = getRecord(supervisor, spawned.id);
    const submit = vi.spyOn(record.runtime, "submit");
    const waiting = expect(supervisor.waitForAgents([spawned.id])).rejects.toMatchObject({
      code: "unknown_agent",
    });

    supervisor.dispose();
    releaseSpawn();

    await waiting;
    expect(record.run.status).toBe("interrupted");
    expect(submit).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(["subagent_spawned"]);
    expect(supervisor.list()).toEqual([]);
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
    const supervisor = new AgentSupervisor({
      mainAgentId: "main",
      onEvent: async () => {},
      recordUsage: () => {},
    });
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

  it("waits for finished-event delivery before resolving waiters", async () => {
    let releaseFinished;
    const finishedGate = new Promise((resolve) => {
      releaseFinished = resolve;
    });
    let finishedEventSeen = false;
    const supervisor = new AgentSupervisor({
      mainAgentId: "main",
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
      mainAgentId: "main",
      recordUsage: () => {},
      onEvent: async (event) => {
        if (event.type === "subagent_spawned") {
          await progressGate;
        }
      },
    });
    const ids = [];
    for (let index = 0; index < 16; index += 1) {
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
  const supervisor = new AgentSupervisor({
    mainAgentId: "main",
    onEvent: () => {},
  });
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
    const supervisor = new AgentSupervisor({
      mainAgentId: "main",
      onEvent: () => {},
      recordUsage: () => {},
    });
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
    const supervisor = new AgentSupervisor({
      mainAgentId: "main",
      onEvent: () => {},
      recordUsage: () => {},
    });
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

  it("does not return an earlier turn's answer when a follow-up has no text", async () => {
    const supervisor = new AgentSupervisor({
      mainAgentId: "main",
      onEvent: () => {},
      recordUsage: () => {},
    });
    try {
      const spawned = supervisor.spawn(createSpawnOptions());
      const record = getRecord(supervisor, spawned.id);
      const answers = [createAssistant("first answer"), { ...createAssistant(""), content: [] }];
      record.runtime.agent.spec.model.stream = vi.fn(() => createStream(answers.shift()));
      await supervisor.waitForAgents([spawned.id]);
      expect(supervisor.getLastResponse(spawned.id)).toMatchObject({
        text: "first answer",
        complete: true,
      });
      supervisor.sendInput({ id: spawned.id, prompt: "continue", mode: "queue" });
      expect(supervisor.getLastResponse(spawned.id)).toBeUndefined();
      await supervisor.waitForAgents([spawned.id]);
      expect(supervisor.getLastResponse(spawned.id)).toBeUndefined();
    } finally {
      supervisor.reset();
    }
  });

  it("cancels a wait independently and clears queued work on nonblocking interruption", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const supervisor = new AgentSupervisor({
      mainAgentId: "main",
      onEvent: () => {},
      recordUsage: () => {},
    });
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
  const supervisor = new AgentSupervisor({
    onCompletion: () => {},
    mainAgentId: "main",
    onEvent: () => {},
    recordUsage: () => {},
  });
  const jobs = new AgentJobRegistry();
  const codeJobs = new CodeJobRegistry();
  const submit = vi.spyOn(AgentRuntime.prototype, "submit").mockImplementation(async () => {
    await gate;
    return { terminalResult: { finalMessage: createAssistant("done"), aborted: false } };
  });
  try {
    const registry = ToolCatalog.createSessionRegistry({
      notifications: new NotificationInbox(),
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

describe("nested supervision", () => {
  function pool() {
    const supervisor = new AgentSupervisor({
      mainAgentId: "main",
      onEvent: () => {},
      recordUsage: () => {},
    });
    const spawn = (parentId = "main", gate) => {
      const options = createSpawnOptions();
      options.runtimeConfig.tools = ["agents"];
      options.agents = {
        callerId: parentId,
        supervisor,
        backend: options.backend,
        jobs: options.jobs,
        config: options.config,
        persona: { ...personas[0], tools: ["agents"] },
        autoCompactThresholdTokens: options.runtimeConfig.autoCompactThresholdTokens,
        modelResolver: () => undefined,
        subagentSystemPrompt: options.runtimeConfig.systemPrompt,
        history: {},
        cwd: options.runtimeConfig.workingDirectory,
      };
      const state = supervisor.spawn({
        ...options,
        parentId,
        notifyOnCompletion: false,
        launchEpoch: supervisor.prepareSpawn(parentId),
      });
      getRecord(supervisor, state.id).runtime.agent.spec.model.stream = () =>
        createStream(createAssistant("done"), gate);
      return state;
    };
    return { supervisor, spawn };
  }

  it("scopes every operation to descendants and enforces leaf policy", async () => {
    const { supervisor, spawn } = pool();
    try {
      const a = spawn();
      const b = spawn(a.id);
      const sibling = spawn();
      const scope = supervisor.scope(a.id);
      expect(
        supervisor
          .scope(supervisor.mainAgentId)
          .list()
          .map((agent) => agent.id),
      ).toEqual([a.id, b.id, sibling.id]);
      expect(scope.list()).toMatchObject([{ id: b.id, parentId: a.id, depth: 2 }]);
      expect(scope.read(b.id).depth).toBe(2);
      const prompt = getRecord(supervisor, b.id).runtime.agent.spec.systemPrompt;
      expect(
        prompt.startsWith(
          renderSubagentPrefixPrompt({
            sessionIds: [supervisor.mainAgentId, a.id, b.id],
            historyEnabled: false,
          }),
        ),
      ).toBe(true);
      expect(prompt).not.toContain(sibling.id);
      expect(prompt.split("<subagent-role>")).toHaveLength(2);
      expect(() => spawn(b.id)).toThrow(expect.objectContaining({ code: "operation_failed" }));
      expect(
        getRecord(supervisor, b.id).runtime.agent.spec.tools.get("wait_for_agents"),
      ).toBeUndefined();
      expect(getRecord(supervisor, b.id).runtime.agent.spec.tools.get("code")).toBeUndefined();
      for (const id of [a.id, sibling.id, "main"]) {
        for (const call of [
          () => scope.read(id),
          () => scope.getTrace(id),
          () => scope.getSnapshot(id),
          () => scope.getLastResponse(id),
          () => scope.sendInput({ id, mode: "queue", prompt: "no" }),
          () => scope.waitForAgents([id]),
          () => scope.interrupt(id),
        ]) {
          expect(call).toThrow(expect.objectContaining({ code: "unknown_agent" }));
        }
      }
      await Promise.all([a, b, sibling].map(({ id }) => supervisor.waitForAgents([id])));
      supervisor.retainOrigins(new Set());
      expect(supervisor.list()).toEqual([]);
      expect(() => scope.spawn(createSpawnOptions())).toThrow(
        expect.objectContaining({ code: "unknown_agent" }),
      );
    } finally {
      supervisor.reset();
    }
  });

  it("keeps single-agent interruption separate from subtree interruption and fences in-flight launches", async () => {
    const { supervisor, spawn } = pool();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    try {
      const a = spawn();
      await supervisor.waitForAgents([a.id]);
      const b = spawn(a.id, gate);
      await vi.waitFor(() =>
        expect(getRecord(supervisor, b.id).runtime.agent.status).toBe("running"),
      );
      await supervisor.interrupt(a.id);
      expect(supervisor.read(b.id).status).toBe("working");
      const epoch = supervisor.scope(a.id).prepareSpawn();
      await supervisor.interrupt(a.id, undefined, false, "subtree");
      expect(supervisor.read(b.id).status).toBe("stopping");
      expect(() => spawn(a.id)).toThrow(expect.objectContaining({ code: "operation_failed" }));
      expect(() => supervisor.sendInput({ id: a.id, mode: "queue", prompt: "retry" })).toThrow();
      release();
      await supervisor.interrupt(a.id, undefined, true, "subtree");
      expect(supervisor.read(b.id)).toMatchObject({ status: "idle", reason: "interrupted" });
      expect(() =>
        supervisor.scope(a.id).spawn({ ...createSpawnOptions(), launchEpoch: epoch }),
      ).toThrow();
      supervisor.sendInput({ id: a.id, mode: "queue", prompt: "retry" });
      await supervisor.waitForAgents([a.id]);
      expect(spawn(a.id).depth).toBe(2);
    } finally {
      release();
      supervisor.reset();
    }
  });

  it("invalidates pending root launches on rewind and rejects launches after disposal", () => {
    const { supervisor } = pool();
    const scope = supervisor.scope(supervisor.mainAgentId);
    const epoch = scope.prepareSpawn();
    supervisor.retainOrigins(new Set());
    expect(() => scope.spawn({ ...createSpawnOptions(), launchEpoch: epoch })).toThrow(
      expect.objectContaining({ code: "operation_failed" }),
    );
    supervisor.dispose();
    expect(() => scope.prepareSpawn()).toThrow(
      expect.objectContaining({ code: "operation_failed" }),
    );
  });

  it("shares admission across levels, including follow-up turns", async () => {
    const { supervisor, spawn } = pool();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    try {
      const idle = spawn();
      await supervisor.waitForAgents([idle.id]);
      const parent = spawn("main", gate);
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => Promise.resolve().then(() => spawn(parent.id, gate))),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(15);
      expect(supervisor.scope(parent.id).getCapacity()).toEqual({ running: 16, limit: 16 });
      expect(() => supervisor.sendInput({ id: idle.id, mode: "queue", prompt: "more" })).toThrow(
        expect.objectContaining({ code: "operation_failed" }),
      );
      release();
      await Promise.all(supervisor.list().map(({ id }) => supervisor.waitForAgents([id])));
      expect(supervisor.sendInput({ id: idle.id, mode: "queue", prompt: "more" }).status).toBe(
        "working",
      );
    } finally {
      release();
      supervisor.reset();
    }
  });
});
