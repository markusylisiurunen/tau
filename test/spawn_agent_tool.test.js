import { describe, expect, it, vi } from "vitest";
import { createAgentsCapability } from "../dist/core/code_mode/agents.js";
import { loadModelResolver } from "../dist/core/models/catalog.js";
import { personas } from "../dist/core/personas.js";
import { AgentTrace } from "../dist/core/subagents/trace.js";
import { createWaitForAgentsToolDefinition } from "../dist/core/tools/wait_for_agents.js";

const context = () => ({ signal: new AbortController().signal });
function fixture(overrides = {}) {
  const supervisor = {
    spawn: vi.fn(() => ({ ok: true, state: { id: "worker" } })),
    read: vi.fn(() => ({ id: "worker", status: "working" })),
    sendInput: vi.fn(() => ({ ok: true })),
    interrupt: vi.fn(),
    waitForAgents: vi.fn(async () => []),
    ...overrides.supervisor,
  };
  const options = {
    backend: {},
    jobs: {},
    config: {},
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
          tools: ["bash"],
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
    expect(supervisor.interrupt).toHaveBeenCalledWith("worker", waitContext.signal, false);
  });

  it("rejects cancelled launches before side effects", async () => {
    const { api, supervisor } = fixture();
    await expect(
      api.spawn([{ title: "child", prompt: "task" }], { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(supervisor.spawn).not.toHaveBeenCalled();
  });

  it("returns compact direct wait state without responses", async () => {
    const state = {
      id: "worker",
      title: "child",
      costTotal: 0,
      run: { status: "succeeded", response: "secret report", startedAt: 1, finishedAt: 2 },
    };
    const tool = createWaitForAgentsToolDefinition({
      waitForAgents: async () => [state],
      read: () => ({ id: "worker", status: "idle", reason: "completed" }),
    });
    const outcome = await tool.execute(
      { id: "wait", name: "wait_for_agents", arguments: { ids: ["worker"] } },
      { ...context(), emitActivity: async () => {} },
    );
    expect(JSON.parse(outcome.content[0].text)).toEqual({
      ready: ["worker"],
      agents: [{ id: "worker", status: "idle", reason: "completed" }],
    });
    expect(JSON.stringify(outcome)).not.toContain("secret report");
  });
});

describe("worker traces", () => {
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
