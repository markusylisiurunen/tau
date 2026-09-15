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
        expect(await jobs.wait([id], 10, context().signal)).toContain("Wait timed out after 10ms");
        expect(jobs.format([id])).toContain("running");
        const wait = new AbortController();
        const waiting = jobs.wait([id], 60_000, wait.signal);
        wait.abort();
        await expect(waiting).rejects.toBeDefined();
        const second = jobId(
          await other.start(backend, "sleep 100", process.cwd(), undefined, context().signal),
        );
        expect(await jobs.stop(id)).toContain("stopped");
        expect(other.format([second])).toContain("running");
        const output = jobId(
          await jobs.start(
            backend,
            'node -e \'process.stdout.write("x".repeat(100000) + "TAIL")\'',
            process.cwd(),
            undefined,
            context().signal,
          ),
        );
        const result = await jobs.wait([output], 5000, context().signal);
        expect(result).toContain("TAIL");
        expect(result).toContain("truncated");
        expect(result.length).toBeLessThan(14000);
        expect(await jobs.wait([output], 1, context().signal)).toContain("succeeded");
        expect(() => new BashJobRegistry().format([id])).toThrow("Unknown Bash job");
      } finally {
        await Promise.all([jobs.dispose(), other.dispose()]);
        await backend.dispose();
      }
    });

    it("honors an execution timeout and kills a TERM-ignoring child on shutdown", async () => {
      const backend = createBackend();
      const jobs = new BashJobRegistry();
      try {
        const timed = jobId(
          await jobs.start(backend, "sleep 100", process.cwd(), 50, context().signal),
        );
        expect(await jobs.wait([timed], 5000, context().signal)).toContain("timed out");
        const id = jobId(
          await jobs.start(
            backend,
            "bash -c 'trap \"\" TERM; echo $$; exec sleep 100' & wait",
            process.cwd(),
            undefined,
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
    await jobs.start(backend, "sleep 100", process.cwd(), undefined, context().signal),
  );
  try {
    const tool = createBashJobToolDefinitions(jobs).find(
      (tool) => tool.schema.name === "wait_for_bash_jobs",
    );
    for (const timeout of [0, -1, 0.5, 300001]) {
      expect((await tool.execute({ arguments: { ids: [id], timeout } }, context())).outcome).toBe(
        "blocked",
      );
    }
    vi.useFakeTimers();
    const waiting = tool.execute({ arguments: { ids: [id] } }, context());
    await vi.advanceTimersByTimeAsync(59999);
    expect(jobs.format([id])).toContain("running");
    await vi.advanceTimersByTimeAsync(1);
    const result = await waiting;
    expect(result.outcome).toBe("succeeded");
    expect(result.content[0].text).toContain("Wait timed out after 60000ms");
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
        actionByStatus: { failed: "failed", cancelled: "cancelled" },
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
    const id = jobId(
      await jobs.start(backend, "ServerCommand", "/Workspace", undefined, context().signal),
    );
    const tool = createBashJobToolDefinitions(jobs).find(
      (tool) => tool.schema.name === "stop_bash_job",
    );
    const events = [];
    const outcome = await tool.execute(
      { id: "stop-call", name: "stop_bash_job", arguments: { id } },
      { ...context(), emitActivity: async (event) => events.push(event) },
    );
    expect(outcome.outcome).toBe("failed");
    expect(outcome.content[0].text).toBe(reason);
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
      await jobs.start(backend, "server", "/workspace", undefined, context().signal);
    await expect(
      jobs.start(backend, "overflow", "/workspace", undefined, context().signal),
    ).rejects.toThrow("limit reached");
    await expect(jobs.dispose()).rejects.toThrow("failed to stop Bash jobs");
    expect(jobs.format()).toContain("failed to terminate process group");
    await expect(
      jobs.start(backend, "closed", "/workspace", undefined, context().signal),
    ).rejects.toThrow("closed");
  } finally {
    await jobs.dispose();
  }
});
