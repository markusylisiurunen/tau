import { describe, expect, it, vi } from "vitest";
import { resolveModel } from "../dist/core/models/catalog.js";
import { AgentSupervisor } from "../dist/core/subagents/agent_supervisor.js";
import { claudeCodeOptions, claudeCodeTools } from "../dist/core/subagents/claude_code_runner.js";
import { parseSubagentLaunchModel } from "../dist/core/subagents/launch_model.js";

const sessionId = "ce4518fa-4b3f-44ef-a1a3-2f7edc024b8d";
const prefix = "tau-claude-code:";
const ok = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  output: "",
  aborted: false,
  timedOut: false,
  truncated: false,
  closeSignal: null,
};

function result(response = "done", count = 10) {
  return {
    type: "result",
    response,
    failed: false,
    cost: count / 100,
    usage: {
      input: count,
      output: count,
      cacheRead: 0,
      cacheWrite: 0,
      contextWindowUsageTokens: count,
      contextWindow: 1_000_000,
    },
  };
}

function emit(options, event) {
  options.onOutput(Buffer.from(`${prefix}${JSON.stringify(event)}\n`));
}

function fixture(run) {
  const calls = [];
  const events = [];
  const recordUsage = vi.fn();
  const backend = {
    runNodeScript: vi.fn(async (script, args, options) => {
      const input = JSON.parse(options.stdin).input;
      calls.push({ input, options, script, args });
      return await run(input, options, calls.length);
    }),
  };
  const supervisor = new AgentSupervisor({ onEvent: (event) => events.push(event), recordUsage });
  const model = parseSubagentLaunchModel("claude-code/claude-sonnet-5-5:medium", { resolveModel })
    .launchModel.model;
  const spawn = () =>
    supervisor.spawn({
      runtimeConfig: {
        kind: "claude-code",
        model,
        effort: "medium",
        tools: ["bash", "edit"],
        workingDirectory: "/remote/workspace",
      },
      prompt: "first task",
      title: "claude task",
      originHistoryEntryId: "origin",
      config: {},
      backend,
    });
  return { supervisor, spawn, calls, events, recordUsage, backend };
}

describe("Claude Code launch models", () => {
  it("resolves Claude launch identity without consulting the native catalog", () => {
    const resolveNativeModel = vi.fn(() => {
      throw new Error("must not resolve native metadata");
    });
    for (const name of ["opus", "sonnet", "haiku"]) {
      const id = `claude-${name}-5-5`;
      const parsed = parseSubagentLaunchModel(`Claude-Code/${id}:high`, {
        resolveModel: resolveNativeModel,
      });
      expect(parsed.launchModel.model).toEqual({
        id,
        provider: "claude-code",
      });
      expect(parsed.launchModel.kind).toBe("claude-code");
      expect(resolveNativeModel).not.toHaveBeenCalled();
      expect(parsed.launchModel.normalized).toBe(`claude-code/${id}:high`);
      expect(resolveModel("claude-code", id)).toBeUndefined();
    }
    expect(
      parseSubagentLaunchModel("claude-code/claude-opus-5:high", { resolveModel }).error,
    ).toBeTruthy();
    for (const effort of ["none", "minimal"]) {
      expect(
        parseSubagentLaunchModel(`claude-code/claude-opus-5-5:${effort}`, { resolveModel }).error,
      ).toBeTruthy();
    }
  });

  it("maps inherited built-in tools and leaves MCP discovery to Claude Code", () => {
    expect(claudeCodeTools([])).toEqual([]);
    expect(claudeCodeTools(["view_image", "edit"])).toEqual(["Read", "Glob", "Grep", "Edit"]);
    expect(claudeCodeTools(["history", "mcp", "models"])).toEqual([]);
    const options = claudeCodeOptions(
      {
        prompt: "task",
        cwd: "/target",
        model: "claude-haiku-5-5",
        effort: "low",
        tools: ["bash"],
        sessionId,
      },
      "/bin/claude",
    );
    expect(options).toMatchObject({
      cwd: "/target",
      model: "claude-haiku-5-5",
      effort: "low",
      resume: sessionId,
      pathToClaudeCodeExecutable: "/bin/claude",
      tools: ["Read", "Glob", "Grep", "Bash", "Skill"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      disallowedTools: ["Agent", "Task", "AskUserQuestion"],
      settingSources: ["user", "project", "local"],
      skills: "all",
      settings: { fastMode: false, autoMemoryEnabled: false, disableAllHooks: true },
      systemPrompt: { type: "preset", preset: "claude_code" },
    });
    expect(options.env.CLAUDE_AGENT_SDK_CLIENT_APP).not.toBe("tau");
    expect(options).not.toHaveProperty("fallbackModel");
    expect(options).not.toHaveProperty("strictMcpConfig");
    expect(options).not.toHaveProperty("mcpServers");
  });
});

describe("Claude Code supervised lifecycle", () => {
  it("runs through the execution backend, resumes, reports activity, and counts cumulative usage once", async () => {
    const f = fixture(async (_input, options, count) => {
      emit(options, { type: "session", id: sessionId });
      emit(options, { type: "assistant", text: "working" });
      emit(options, { type: "tool", name: "Bash", subject: "npm test", failed: true });
      emit(options, result(`answer ${count}`, count * 10));
      return ok;
    });
    const spawned = f.spawn();
    expect(spawned.ok).toBe(true);
    const id = spawned.state.id;
    const [first] = await f.supervisor.waitForAgents([id]);
    expect(first.run).toMatchObject({ status: "succeeded", response: "answer 1" });
    expect(f.calls[0].input).toMatchObject({
      cwd: "/remote/workspace",
      prompt: "first task",
      tools: ["bash", "edit"],
    });
    expect(f.calls[0].input).not.toHaveProperty("sessionId");
    expect(f.calls[0].input).not.toHaveProperty("systemPrompt");
    expect(f.calls[0].input).not.toHaveProperty("contextWindow");
    expect(spawned.state.usage.contextWindow).toBe(0);
    expect(first.usage.contextWindow).toBe(1_000_000);
    expect(f.calls[0].options.cwd).toBe("/remote/workspace");
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "subagent_activity",
        activity: expect.objectContaining({ type: "tool", outcome: "failed", toolName: "Bash" }),
      }),
    );
    expect(f.supervisor.sendInput({ id, prompt: "follow up" }).ok).toBe(true);
    const [second] = await f.supervisor.waitForAgents([id]);
    expect(second.run).toMatchObject({ revision: 2, status: "succeeded", response: "answer 2" });
    expect(f.calls[1].input).toMatchObject({ sessionId, prompt: "follow up" });
    expect(second.usage.input).toBe(20);
    expect(second.usage.contextWindowUsageTokens).toBe(20);
    expect(second.costTotal).toBe(0.2);
    expect(f.recordUsage.mock.calls.map(([entry]) => entry.usage.input)).toEqual([10, 10]);
    expect(f.recordUsage.mock.calls.map(([entry]) => entry.cost.total)).toEqual([0.1, 0.1]);
    f.supervisor.reset();
  });

  it("deduplicates message usage across blocks, interruption, and resumed results", async () => {
    const usage = (messageId, input, output) => ({
      type: "usage",
      messageId,
      usage: { input, output, cacheRead: 0, cacheWrite: 0 },
    });
    const f = fixture(async (_input, options, count) => {
      emit(options, { type: "session", id: sessionId });
      emit(options, usage("first", 5, 2));
      emit(options, usage("first", 5, 3));
      emit(options, usage("first", 5, 2));
      if (count === 1) return { ...ok, aborted: true };
      if (count === 2) {
        emit(options, usage("second", 5, 3));
        emit(options, result("done", 10));
      } else {
        // A replay after reconciliation may contain more output than earlier streamed blocks.
        emit(options, usage("second", 5, 5));
        emit(options, usage("third", 5, 5));
        emit(options, result("done", 15));
      }
      return ok;
    });
    const id = f.spawn().state.id;
    const [interrupted] = await f.supervisor.waitForAgents([id]);
    expect(interrupted.run.status).toBe("interrupted");
    expect(interrupted.usage).toMatchObject({ input: 5, output: 3, contextWindowUsageTokens: 8 });
    f.supervisor.sendInput({ id, prompt: "continue" });
    await f.supervisor.waitForAgents([id]);
    f.supervisor.sendInput({ id, prompt: "continue again" });
    const [finished] = await f.supervisor.waitForAgents([id]);
    expect(finished.usage).toMatchObject({ input: 15, output: 15 });
    expect(
      f.recordUsage.mock.calls.map(([entry]) => [entry.usage.input, entry.usage.output]),
    ).toEqual([
      [5, 2],
      [0, 1],
      [5, 3],
      [0, 4],
      [5, 5],
      [0, 0],
    ]);
    expect(f.recordUsage.mock.calls.reduce((total, [entry]) => total + entry.cost.total, 0)).toBe(
      0.15,
    );
    f.supervisor.reset();
  });

  it("keeps cumulative accounting across a zero-usage startup failure", async () => {
    const f = fixture(async (_input, options, count) => {
      emit(options, { type: "session", id: sessionId });
      emit(
        options,
        count === 2
          ? { ...result("startup failed", 0), failed: true }
          : result("done", count === 1 ? 10 : 20),
      );
      return ok;
    });
    const id = f.spawn().state.id;
    await f.supervisor.waitForAgents([id]);
    f.supervisor.sendInput({ id, prompt: "retry" });
    const [failed] = await f.supervisor.waitForAgents([id]);
    expect(failed.run.status).toBe("failed");
    expect(failed.usage.input).toBe(10);
    expect(failed.costTotal).toBe(0.1);
    f.supervisor.sendInput({ id, prompt: "retry again" });
    const [finished] = await f.supervisor.waitForAgents([id]);
    expect(finished.usage.input).toBe(20);
    expect(f.recordUsage.mock.calls.map(([entry]) => entry.usage.input)).toEqual([10, 0, 10]);
    expect(f.recordUsage.mock.calls.map(([entry]) => entry.cost.total)).toEqual([0.1, 0, 0.1]);
    f.supervisor.reset();
  });

  it("interrupts through the backend signal and permits a follow-up on the same session", async () => {
    let started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    const f = fixture(async (_input, options, count) => {
      emit(options, { type: "session", id: sessionId });
      if (count > 1) {
        emit(options, result());
        return ok;
      }
      started();
      await new Promise((resolve) =>
        options.signal.addEventListener("abort", resolve, { once: true }),
      );
      return { ...ok, aborted: true };
    });
    const id = f.spawn().state.id;
    await ready;
    expect(f.supervisor.sendInput({ id, prompt: "too early" }).ok).toBe(false);
    const stopped = await f.supervisor.interrupt(id);
    expect(stopped.run.status).toBe("interrupted");
    expect(f.calls[0].options.signal.aborted).toBe(true);
    expect(f.supervisor.sendInput({ id, prompt: "continue" }).ok).toBe(true);
    expect((await f.supervisor.waitForAgents([id]))[0].run.status).toBe("succeeded");
    expect(f.calls[1].input.sessionId).toBe(sessionId);
    f.supervisor.reset();
  });

  it("disposes running Claude children when their origins are removed", async () => {
    let started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    const f = fixture(async (_input, options) => {
      started();
      await new Promise((resolve) =>
        options.signal.addEventListener("abort", resolve, { once: true }),
      );
      return { ...ok, aborted: true };
    });
    f.spawn();
    await ready;
    f.supervisor.retainOrigins(new Set());
    expect(f.calls[0].options.signal.aborted).toBe(true);
    expect(f.supervisor.listSnapshots()).toEqual([]);
  });

  it.each(["missing", "malformed", "provider", "exit", "truncated"])(
    "fails closed on %s results",
    async (kind) => {
      const f = fixture(async (_input, options) => {
        if (kind === "malformed") options.onOutput(Buffer.from(`${prefix}{bad}\n`));
        if (kind === "truncated") options.onOutput(Buffer.from(`${prefix}{`));
        if (kind === "provider") emit(options, { ...result("provider rejected"), failed: true });
        return kind === "exit" ? { ...ok, exitCode: 1 } : ok;
      });
      const id = f.spawn().state.id;
      const [state] = await f.supervisor.waitForAgents([id]);
      expect(state.run.status).toBe("failed");
      expect(f.calls).toHaveLength(1);
      f.supervisor.reset();
    },
  );

  it("decodes split UTF-8 events without relying on the truncated capture tail", async () => {
    const f = fixture(async (_input, options) => {
      const bytes = Buffer.from(`${prefix}${JSON.stringify(result("valmista: ää 漢"))}\n`);
      for (const byte of bytes) options.onOutput(Buffer.from([byte]));
      return { ...ok, truncated: true };
    });
    const id = f.spawn().state.id;
    expect((await f.supervisor.waitForAgents([id]))[0].run.response).toBe("valmista: ää 漢");
    f.supervisor.reset();
  });
});
