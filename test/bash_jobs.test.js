import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createBashToolDefinition } from "../dist/core/tools/bash.js";
import { BashJobRegistry, createBashJobToolDefinitions } from "../dist/core/tools/bash_jobs.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { createFlySpriteToolExecutionBackend } from "../dist/execution/fly_sprite_execution_environment.js";

const context = (signal = new AbortController().signal) => ({
  signal,
  emitActivity: async () => {},
  agentId: "agent",
  turnId: "turn",
  assistantMessageId: "message",
});
const jobId = (text) => text.match(/`([^`]+)`/)[1];

it("rejects background launch timeouts and explains unknown job recovery", async () => {
  const runBash = vi.fn(async (_command, options) => {
    options.onStarted?.();
    return { exitCode: 0, aborted: false, timedOut: false, closeSignal: null, truncated: false };
  });
  const jobs = new BashJobRegistry();
  const bash = createBashToolDefinition({ runBash }, "/Workspace", jobs);
  try {
    for (const timeout of [1000, undefined]) {
      const events = [];
      const result = await bash.execute(
        {
          id: "invalid-launch",
          name: "bash",
          arguments: { command: "server", background: true, timeout },
        },
        { ...context(), emitActivity: async (event) => events.push(event) },
      );
      expect(result.outcome).toBe("blocked");
      expect(result.content[0].text).toContain("timeout is only available for foreground commands");
      expect(events.at(-1).presentation.details[0].text).toContain("timeout");
    }
    expect(runBash).not.toHaveBeenCalled();
    expect(jobs.format()).toBe("No Bash jobs.");
    const events = [];
    await bash.execute(
      { id: "launch", name: "bash", arguments: { command: "server", background: true } },
      { ...context(), emitActivity: async (event) => events.push(event) },
    );
    expect(runBash.mock.calls[0][1].timeoutMs).toBeUndefined();
    expect(events.at(-1).presentation).toMatchObject({
      operation: "background",
      subject: "server",
      actionByStatus: { succeeded: "started" },
    });
    expect(bash.schema.description).toContain(
      "do not assume the command never ran or is no longer running",
    );
    expect(bash.schema.description).toContain(
      "check current process and output state before restarting it",
    );
    expect(bash.schema.description).not.toContain("Tau stops jobs");
  } finally {
    await jobs.dispose();
  }
});

it.each([
  [0, false, null, "succeeded"],
  [17, false, null, "failed"],
  [null, false, "SIGKILL", "failed"],
  [null, true, "SIGTERM", "stopped"],
])(
  "keeps exit metadata independent of output for exit %s, aborted %s, signal %s",
  async (exitCode, aborted, closeSignal, status) => {
    const jobs = new BashJobRegistry();
    const output = Array.from({ length: 40 }, (_, index) => `output line ${index}`).join("\n");
    const backend = {
      async runBash(_command, options) {
        options.onStarted();
        options.onOutput(Buffer.from(output));
        return { exitCode, aborted, timedOut: false, closeSignal, truncated: true };
      },
    };
    try {
      const id = jobId(await jobs.start(backend, "ServerCommand", "/Workspace", context().signal));
      await jobs.waitForIdle();
      for (const tool of createBashJobToolDefinitions(jobs)) {
        const name = tool.schema.name;
        const args =
          name === "list_bash_jobs" ? {} : name === "wait_for_bash_jobs" ? { ids: [id] } : { id };
        for (const includeOutput of name === "list_bash_jobs"
          ? [undefined]
          : [undefined, true, false]) {
          const call = {
            id: "observe",
            name,
            arguments: { ...args, ...(includeOutput === undefined ? {} : { includeOutput }) },
          };
          const events = [];
          const result = await tool.execute(call, {
            ...context(),
            emitActivity: async (event) => events.push(event),
          });
          expect(result.outcome).toBe("succeeded");
          const text = result.content[0].text;
          expect(text).toContain(
            `\`${id}\` · ServerCommand\n${status}\ncwd /Workspace\nexit ${exitCode ?? "?"}`,
          );
          if (aborted) expect(text).toContain("Command was cancelled.");
          if (closeSignal)
            expect(text).toContain(`Command was terminated by signal ${closeSignal}.`);
          const hasOutput = name !== "list_bash_jobs" && includeOutput !== false;
          expect(text.includes("output line 0")).toBe(hasOutput);
          expect(text.includes("Output truncated")).toBe(hasOutput);
          const initial = tool.describe(call).presentation;
          const terminal = events.at(-1).presentation;
          expect(terminal.subject).toBe(initial.subject);
          expect(terminal.operation).toBe("bash");
          if (hasOutput) {
            expect(terminal.details).toHaveLength(7);
            expect(terminal.details[3].text).toMatch(/…\d+ more lines…/);
            expect(terminal.details[0].text).toBe(text.split("\n")[0]);
            expect(terminal.details.at(-1).text).toBe(text.split("\n").at(-1));
          }
        }
        if (name !== "list_bash_jobs") {
          expect(tool.schema.parameters.properties.includeOutput.type).toBe("boolean");
          const invalid = await tool.execute(
            { id: "invalid", name, arguments: { ...args, includeOutput: "false" } },
            context(),
          );
          expect(invalid.outcome).toBe("blocked");
        }
      }
    } finally {
      await jobs.dispose();
    }
  },
);

for (const kind of ["local", "Sprite"]) {
  describe(`${kind} Bash jobs`, () => {
    const createBackend = () =>
      kind === "local"
        ? createLocalToolExecutionBackend()
        : createFlySpriteToolExecutionBackend({
            cwd: process.cwd(),
            sprite: {
              spawn: (command, args, options) =>
                spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }),
            },
          });

    it("survives turn cancellation, bounds logs, waits without killing, and stops independently", async () => {
      const backend = createBackend();
      const jobs = new BashJobRegistry();
      const other = new BashJobRegistry();
      const turn = new AbortController();
      try {
        const bash = createBashToolDefinition(backend, process.cwd(), jobs);
        const outcome = await bash.execute(
          {
            id: "start",
            name: "bash",
            arguments: { command: "printf ready; sleep 100", background: true },
          },
          context(turn.signal),
        );
        expect(outcome.outcome).toBe("succeeded");
        const id = jobId(outcome.content[0].text);
        turn.abort();
        await vi.waitFor(() => expect(jobs.format([id])).toContain("ready"));
        expect(await jobs.wait([id], 10, context().signal, true)).toContain(
          "Wait timed out after 10ms",
        );
        expect(jobs.format([id])).toContain("running");
        const wait = new AbortController();
        const waiting = jobs.wait([id], 60_000, wait.signal, true);
        wait.abort();
        await expect(waiting).rejects.toBeDefined();
        const second = jobId(
          await other.start(backend, "sleep 100", process.cwd(), context().signal),
        );
        const stopTool = createBashJobToolDefinitions(jobs).find(
          (tool) => tool.schema.name === "stop_bash_job",
        );
        const stopped = await stopTool.execute(
          { id: "stop", name: "stop_bash_job", arguments: { id, includeOutput: false } },
          context(),
        );
        expect(stopped.content[0].text).toContain("stopped");
        expect(stopped.content[0].text).toContain("Command was cancelled.");
        expect(stopped.content[0].text).not.toContain("\nready");
        expect(other.format([second])).toContain("running");
        const output = jobId(
          await jobs.start(
            backend,
            'node -e \'process.stdout.write("x".repeat(100000) + "TAIL")\'',
            process.cwd(),
            context().signal,
          ),
        );
        const result = await jobs.wait([output], 5000, context().signal, true);
        expect(result).toContain("TAIL");
        expect(result).toContain("truncated");
        expect(result.length).toBeLessThan(14000);
        expect(await jobs.wait([output], 1, context().signal, true)).toContain("succeeded");
        expect(() => new BashJobRegistry().format([id])).toThrow("Unknown Bash job");
      } finally {
        await Promise.all([jobs.dispose(), other.dispose()]);
        await backend.dispose();
      }
    });

    it("kills a TERM-ignoring child on shutdown", async () => {
      const backend = createBackend();
      const jobs = new BashJobRegistry();
      try {
        const id = jobId(
          await jobs.start(
            backend,
            "bash -c 'trap \"\" TERM; echo $$; exec sleep 100' & wait",
            process.cwd(),
            context().signal,
          ),
        );
        let pid;
        await vi.waitFor(() => {
          pid = Number(
            jobs
              .format([id])
              .split("\n")
              .find((line) => /^\d+$/.test(line)),
          );
          expect(pid).toBeGreaterThan(0);
        });
        await jobs.dispose();
        expect(jobs.format([id])).toContain("stopped");
        await vi.waitFor(() => {
          expect(() => process.kill(pid, 0)).toThrow();
        });
      } finally {
        await jobs.dispose();
        await backend.dispose();
      }
    });
  });
}

it("defaults waits to 60 seconds, validates the cap, and retains a running job on expiry", async () => {
  const jobs = new BashJobRegistry();
  const backend = createLocalToolExecutionBackend();
  const id = jobId(
    await jobs.start(backend, "printf ready; sleep 100", process.cwd(), context().signal),
  );
  try {
    await vi.waitFor(() => expect(jobs.format([id])).toContain("\nready"));
    const tool = createBashJobToolDefinitions(jobs).find(
      (tool) => tool.schema.name === "wait_for_bash_jobs",
    );
    for (const timeout of [0, -1, 0.5, 300001]) {
      expect((await tool.execute({ arguments: { ids: [id], timeout } }, context())).outcome).toBe(
        "blocked",
      );
    }
    vi.useFakeTimers();
    const waiting = tool.execute({ arguments: { ids: [id], includeOutput: false } }, context());
    await vi.advanceTimersByTimeAsync(59999);
    expect(jobs.format([id])).toContain("running");
    await vi.advanceTimersByTimeAsync(1);
    const result = await waiting;
    expect(result.outcome).toBe("succeeded");
    expect(result.content[0].text).toContain("Wait timed out after 60000ms");
    expect(result.content[0].text).not.toContain("\nready");
    expect(jobs.format([id])).toContain("running");
  } finally {
    vi.useRealTimers();
    await jobs.dispose();
    await backend.dispose();
  }
});

it.each(["read_bash_job", "stop_bash_job", "wait_for_bash_jobs"])(
  "%s presents unknown IDs and validation failures, but keeps cancellation quiet",
  async (name) => {
    const tool = createBashJobToolDefinitions(new BashJobRegistry()).find(
      (tool) => tool.schema.name === name,
    );
    const args = name === "wait_for_bash_jobs" ? { ids: ["stale-job"] } : { id: "stale-job" };
    const events = [];
    const controller = new AbortController();
    const executionContext = {
      ...context(controller.signal),
      emitActivity: async (event) => events.push(event),
    };
    const call = { id: "job-call", name, arguments: args };
    const failed = await tool.execute(call, executionContext);
    expect(failed.outcome).toBe("failed");
    expect(events.at(-1)).toMatchObject({
      type: "tool_call_finished",
      status: "error",
      presentation: {
        subject: "stale-job",
        operation: "bash",
        details: [{ text: failed.content[0].text }],
      },
    });
    expect(failed.content[0].text).toContain("Unknown Bash job 'stale-job'");

    const blocked = await tool.execute({ ...call, arguments: {} }, executionContext);
    expect(blocked.outcome).toBe("blocked");
    expect(events.at(-1)).toMatchObject({
      type: "tool_call_blocked",
      presentation: { details: [{ text: blocked.content[0].text }] },
    });
    expect(blocked.content[0].text).toMatch(/^Invalid arguments:/);

    controller.abort();
    const cancelled = await tool.execute(call, executionContext);
    expect(cancelled.outcome).toBe("cancelled");
    expect(cancelled.content[0].text).toBe("Bash job operation was cancelled.");
    expect(events.at(-1).presentation).toMatchObject({ subject: "stale-job", details: [] });
  },
);

it("presents bounded cleanup diagnostics without changing backend text casing", async () => {
  const jobs = new BashJobRegistry();
  const reason = `Failed to terminate PID 123: ${"x".repeat(10000)}`;
  const backend = {
    runBash: (_command, options) =>
      new Promise((_, reject) => {
        options.onStarted();
        options.signal.addEventListener("abort", () => reject(new Error(reason)), { once: true });
      }),
  };
  try {
    const id = jobId(await jobs.start(backend, "ServerCommand", "/Workspace", context().signal));
    const tool = createBashJobToolDefinitions(jobs).find(
      (tool) => tool.schema.name === "stop_bash_job",
    );
    const events = [];
    const outcome = await tool.execute(
      { id: "stop-call", name: "stop_bash_job", arguments: { id, includeOutput: false } },
      { ...context(), emitActivity: async (event) => events.push(event) },
    );
    expect(outcome.outcome).toBe("failed");
    expect(outcome.content[0].text).toBe(reason);
    expect(jobs.format([id], false)).toContain(reason);
    expect(events.at(-1).presentation.subject).toBe(id);
    const diagnostic = events
      .at(-1)
      .presentation.details.map((line) => line.text)
      .join("\n");
    expect(diagnostic).toContain("Failed to terminate PID 123:");
    expect(diagnostic.length).toBeLessThan(1000);
  } finally {
    await jobs.dispose();
  }
});

it("bounds job records and reports backend cleanup failures", async () => {
  const jobs = new BashJobRegistry();
  const backend = {
    runBash: (_command, options) =>
      new Promise((resolve, reject) => {
        options.onStarted();
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("failed to terminate process group")),
          { once: true },
        );
      }),
  };
  try {
    for (let i = 0; i < 64; i++)
      await jobs.start(backend, "server", "/workspace", context().signal);
    await expect(jobs.start(backend, "overflow", "/workspace", context().signal)).rejects.toThrow(
      "limit reached",
    );
    await expect(jobs.dispose()).rejects.toThrow("failed to stop Bash jobs");
    expect(jobs.format()).toContain("failed to terminate process group");
    await expect(jobs.start(backend, "closed", "/workspace", context().signal)).rejects.toThrow(
      "closed",
    );
  } finally {
    await jobs.dispose();
  }
});
