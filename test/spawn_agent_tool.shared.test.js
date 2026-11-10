import { describe, expect, it, vi } from "vitest";
import { createAgentsCapability } from "../dist/core/code_mode/agents.js";
import { loadModelResolver } from "../dist/core/models/catalog.js";
import { personas } from "../dist/core/personas.js";
import { AgentTrace } from "../dist/core/subagents/trace.js";
import { truncateToolText } from "../dist/core/tools/presentation.js";
import { createWaitForAgentsToolDefinition } from "../dist/core/tools/wait_for_agents.js";

const context = () => ({ signal: new AbortController().signal });
function fixture(overrides = {}) {
  const supervisor = {
    mainAgentId: "main",
    setCompletionNotification: vi.fn(),
    scope() {
      return this;
    },
    prepareSpawn: vi.fn(() => 0),
    getCapacity: vi.fn(() => ({ running: 0, limit: 16 })),
    spawn: vi.fn(() => ({ id: "worker", status: "working" })),
    read: vi.fn(() => ({ id: "worker", status: "working" })),
    sendInput: vi.fn(() => ({ id: "worker", status: "working" })),
    interrupt: vi.fn(),
    waitForAgents: vi.fn(async () => []),
    ...overrides.supervisor,
  };
  const options = {
    callerId: "main",
    backend: {},
    jobs: {},
    config: {},
    autoCompactThresholdTokens: 120000,
    history: {},
    cwd: "/repo",
    subagentSystemPrompt: "child instructions",
    persona: { ...personas[0], tools: ["bash", "agents"], subagentLaunchModels: [] },
    modelResolver: loadModelResolver().resolveModel,
    ...overrides,
    supervisor,
  };
  return { options, supervisor, api: createAgentsCapability(options, "origin").api };
}

describe("agents capability", () => {
  it("exposes subscriptions only to main and rejects worker options before spawning", async () => {
    const main = fixture();
    await main.api.spawn(
      [{ title: "child", prompt: "task", notifyOnCompletion: false }],
      context(),
    );
    expect(main.supervisor.spawn.mock.lastCall[0].notifyOnCompletion).toBe(false);
    await main.api.setCompletionNotification([{ id: "worker", enabled: true }], context());
    expect(main.supervisor.setCompletionNotification).toHaveBeenCalledWith("worker", true);
    const worker = fixture({ callerId: "worker" });
    expect(worker.api.setCompletionNotification).toBeUndefined();
    expect(createAgentsCapability(worker.options, "origin").documentation).not.toContain(
      "notifyOnCompletion",
    );
    await expect(
      worker.api.spawn([{ title: "child", prompt: "task", notifyOnCompletion: true }], context()),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(worker.supervisor.prepareSpawn).not.toHaveBeenCalled();
    expect(worker.supervisor.spawn).not.toHaveBeenCalled();
  });

  it.each([undefined, "high"])(
    "reports inherited launch settings with reasoning %s and no overrides without spawning",
    async (reasoning) => {
      const { api, options, supervisor } = fixture();
      options.persona.settings = { ...options.persona.settings, reasoning };
      const choices = await api.launchOptions([], context());
      expect(choices.overrides).toEqual([]);
      expect(supervisor.prepareSpawn).not.toHaveBeenCalled();
      expect(supervisor.spawn).not.toHaveBeenCalled();
      await api.spawn([{ title: "child", prompt: "task" }], context());
      const { model, settings } = supervisor.spawn.mock.calls[0][0].runtimeConfig;
      expect(`${model.provider}/${model.id}:${settings.reasoning ?? "none"}`).toBe(
        choices.inherited.model,
      );
      await expect(api.launchOptions([{}], context())).rejects.toMatchObject({
        code: "invalid_arguments",
      });
    },
  );

  it("reports exact native and Claude overrides accepted by spawn", async () => {
    const resolveModel = loadModelResolver().resolveModel;
    const { api, options, supervisor } = fixture({
      modelResolver: (provider, modelId) =>
        modelId === "missing-model" ? undefined : resolveModel(provider, modelId),
    });
    options.persona.subagentLaunchModels = [
      "openai/gpt-6.1-sol:high",
      "claude-code/claude-sonnet-5-5:medium",
      "openai/missing-model:high",
    ];
    const choices = await api.launchOptions([], context());
    expect(choices.overrides).toEqual(
      options.persona.subagentLaunchModels.slice(0, 2).map((model) => ({ model })),
    );
    expect(supervisor.spawn).not.toHaveBeenCalled();
    for (const { model } of choices.overrides) {
      await api.spawn([{ title: "child", prompt: "task", model }], context());
      const config = supervisor.spawn.mock.lastCall[0].runtimeConfig;
      const reasoning = config.kind === "native" ? config.settings.reasoning : config.effort;
      expect(`${config.model.provider}/${config.model.id}:${reasoning}`).toBe(model);
    }
    await expect(
      api.spawn([{ title: "child", prompt: "task", model: "openai/gpt-6.1-sol:low" }], context()),
    ).rejects.toMatchObject({ code: "operation_failed" });
    await expect(
      api.spawn(
        [{ title: "child", prompt: "task", model: "openai/missing-model:high" }],
        context(),
      ),
    ).rejects.toMatchObject({ code: "operation_failed" });
    expect(supervisor.spawn).toHaveBeenCalledTimes(2);
  });

  it("inherits launch settings and binds the launching conversation origin", async () => {
    const { api, options, supervisor } = fixture();
    await api.spawn([{ title: "child", prompt: "task" }], context());
    expect(supervisor.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        originHistoryEntryId: "origin",
        prompt: "task",
        title: "child",
        runtimeConfig: expect.objectContaining({
          kind: "native",
          model: options.persona.model,
          systemPrompt: "child instructions",
          workingDirectory: "/repo",
          tools: ["bash", "agents"],
        }),
      }),
    );
  });

  it("rebuilds native instructions for another directory and rejects unavailable context", async () => {
    const resolver = vi.fn(async () => "other instructions");
    const { api, supervisor } = fixture({ resolveSubagentPrompt: resolver });
    await api.spawn([{ title: "child", prompt: "task", workingDirectory: "other" }], context());
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo/other" }));
    expect(supervisor.spawn.mock.calls[0][0].runtimeConfig.systemPrompt).toBe("other instructions");
    const unavailable = fixture();
    await expect(
      unavailable.api.spawn(
        [{ title: "child", prompt: "task", workingDirectory: "other" }],
        context(),
      ),
    ).rejects.toThrow();
    expect(unavailable.supervisor.spawn).not.toHaveBeenCalled();
  });

  it("enforces Claude launch permission without resolving native metadata or instructions", async () => {
    const modelResolver = vi.fn(() => {
      throw new Error("unexpected native metadata");
    });
    const resolveSubagentPrompt = vi.fn(() => {
      throw new Error("unexpected instructions");
    });
    const fx = fixture({ modelResolver, resolveSubagentPrompt });
    const input = {
      title: "child",
      prompt: "task",
      model: "claude-code/claude-sonnet-5-5:medium",
      workingDirectory: "other",
    };
    await expect(fx.api.spawn([input], context())).rejects.toThrow();
    expect(fx.supervisor.spawn).not.toHaveBeenCalled();
    fx.options.persona.subagentLaunchModels = [input.model];
    await fx.api.spawn([input], context());
    expect(fx.supervisor.spawn.mock.calls[0][0].runtimeConfig).toMatchObject({
      kind: "claude-code",
      workingDirectory: "/repo/other",
      effort: "medium",
    });
    expect(modelResolver).not.toHaveBeenCalled();
    expect(resolveSubagentPrompt).not.toHaveBeenCalled();
  });

  it("requires explicit delivery mode and propagates wait cancellation without interrupting workers", async () => {
    const { api, supervisor } = fixture();
    await expect(
      api.sendInput([{ id: "worker", message: "task" }], context()),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    await api.sendInput([{ id: "worker", message: "task", mode: "steer" }], context());
    expect(supervisor.sendInput).toHaveBeenCalledWith({
      id: "worker",
      prompt: "task",
      mode: "steer",
    });
    const waitContext = context();
    await api.waitUntilIdle([{ id: "worker" }], waitContext);
    expect(supervisor.waitForAgents).toHaveBeenCalledWith(["worker"], waitContext.signal);
    expect(supervisor.interrupt).not.toHaveBeenCalled();
    await api.interrupt([{ id: "worker", wait: false }], waitContext);
    expect(supervisor.interrupt).toHaveBeenCalledWith("worker", waitContext.signal, false, "agent");
  });

  it("rejects cancelled launches before side effects", async () => {
    const { api, supervisor } = fixture();
    await expect(
      api.spawn([{ title: "child", prompt: "task" }], { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(supervisor.spawn).not.toHaveBeenCalled();
  });

  it("returns bounded settled responses and metadata for running workers", async () => {
    const getLastResponse = vi.fn((id) =>
      id === "empty"
        ? undefined
        : {
            seq: 7,
            text: `${id} ${"evidence ".repeat(100)}`,
            complete: true,
          },
    );
    const agents = [
      { id: "done", status: "idle", reason: "completed" },
      {
        id: "partial",
        status: "idle",
        reason: "failed",
        error: { code: "provider-error", message: "failed" },
      },
      { id: "empty", status: "idle", reason: "interrupted" },
      { id: "busy", status: "working" },
    ].map((state) => ({ ...state, title: state.id, pending: { queue: 0, steer: 0 } }));
    const tool = createWaitForAgentsToolDefinition({
      waitForAgents: async () => agents,
      getSnapshot: (id) => ({
        id,
        title: id,
        costTotal: 0,
        run: { status: id === "busy" ? "running" : "succeeded", startedAt: 1, finishedAt: 2 },
      }),
      getLastResponse,
    });
    const emitActivity = vi.fn();
    const outcome = await tool.execute(
      {
        id: "wait",
        name: "wait_for_agents",
        arguments: { ids: agents.map((state) => state.id), maxOutputTokens: 80 },
      },
      { ...context(), emitActivity },
    );
    const text = outcome.content[0].text;
    const finished = emitActivity.mock.calls
      .map(([activity]) => activity)
      .find((activity) => activity.type === "tool_call_finished");
    expect(finished.presentation.details.map((line) => line.text).join("\n")).toBe(
      truncateToolText(text, { maxLines: 17, maxLineChars: 512, strategy: "middle" }),
    );
    expect(text).toContain("done evidence");
    expect(text).toContain("partial evidence");
    expect(text).toContain("response_seq: 7");
    expect(text).toContain("response_complete: false");
    expect(text).toContain("response_partial: true");
    expect(text).toContain("response: none");
    expect(text).not.toContain("evidence ".repeat(100));
    expect(getLastResponse.mock.calls.map(([id]) => id)).toEqual(["done", "partial", "empty"]);
  });
});

describe("worker traces", () => {
  it("retains image content beyond 16 MiB and evicts it at 64 MiB", () => {
    const trace = new AgentTrace();
    const content = [{ type: "image", mimeType: "image/png", data: "x".repeat(5 * 1024 * 1024) }];
    trace.append({ kind: "assistant", content });
    const first = trace.trace({}).entries[0];
    for (let i = 1; i < 4; i++) trace.append({ kind: "assistant", content });
    expect(trace.trace({}).historyEvicted).toBe(false);
    expect(trace.readContent({ ref: first.content.ref }).blocks).toEqual(content);
    for (let i = 4; i < 13; i++) trace.append({ kind: "assistant", content });
    expect(trace.trace({}).historyEvicted).toBe(true);
    expect(() => trace.readContent({ ref: first.content.ref })).toThrow();
  });

  it("paginates a stable filtered view while new evidence arrives", () => {
    const trace = new AgentTrace();
    for (let i = 0; i < 5; i++)
      trace.append({ kind: "assistant", content: [{ type: "text", text: String(i) }] });
    const first = trace.trace({ kinds: ["assistant"], limit: 2 });
    trace.append({ kind: "assistant", content: [{ type: "text", text: "new" }] });
    const next = trace.trace({ kinds: ["assistant"], limit: 2, cursor: first.nextCursor });
    expect(first.entries.map((entry) => entry.seq)).toEqual([4, 5]);
    expect(next.entries.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(() => trace.trace({ kinds: ["input"], cursor: first.nextCursor })).toThrow();
  });

  it("reads large Unicode text exactly and reports bounded or unavailable text", () => {
    const trace = new AgentTrace();
    const text = "界😀\n".repeat(20000);
    trace.append({ kind: "assistant", content: [{ type: "text", text }] });
    const entry = trace.trace({}).entries[0];
    expect(entry.content.kind).toBe("reference");
    let cursor;
    let actual = "";
    do {
      const page = trace.readContent({ ref: entry.content.ref, cursor });
      actual += page.blocks[0].text;
      cursor = page.nextCursor;
    } while (cursor);
    expect(actual).toBe(text);
    expect(trace.readText(entry.seq, 100)).toEqual({ text: text.slice(0, 100), complete: false });
    trace.append({
      kind: "assistant",
      content: [{ type: "unavailable", reason: "source truncation" }],
    });
    expect(trace.readText(2).complete).toBe(false);
  });

  it("keeps images out of pages and rejects expired references", () => {
    const trace = new AgentTrace();
    const image = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
    trace.append({ kind: "assistant", content: [image] });
    const entry = trace.trace({}).entries[0];
    expect(entry.content.kind).toBe("reference");
    expect(trace.readContent({ ref: entry.content.ref }).blocks).toEqual([image]);
    expect(() => trace.readText(entry.seq)).toThrow();
    for (let i = 0; i < 4096; i++) trace.append({ kind: "status", status: "working" });
    expect(trace.trace({}).historyEvicted).toBe(true);
    expect(() => trace.readContent({ ref: entry.content.ref })).toThrow();
  });
});

describe("subagent compaction thresholds", () => {
  it.each([
    [undefined, undefined, 120000],
    ["anthropic/claude-opus-5-5:high", 80000, 80000],
    ["openai/gpt-6.1-sol:high", 9000000, null],
  ])("resolves launch %s with configured budget %s", async (model, budget, expected) => {
    const { options, api, supervisor } = fixture();
    options.persona.subagentLaunchModels = model ? [model] : [];
    options.persona.autoCompactThresholdTokens = 200000;
    const key =
      model?.slice(0, model.lastIndexOf(":")) ??
      `${options.persona.model.provider}/${options.persona.model.id}`;
    options.persona.subagentAutoCompactThresholdTokens =
      budget === undefined ? {} : { [key]: budget };
    await api.spawn([{ title: "child", prompt: "work", ...(model ? { model } : {}) }], context());
    const config = supervisor.spawn.mock.calls[0][0].runtimeConfig;
    expect(config.autoCompactThresholdTokens).toBe(
      Math.min(expected ?? Infinity, config.model.contextWindow - 16384),
    );
  });
});
