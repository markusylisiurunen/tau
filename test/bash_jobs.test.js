import { expect, it, vi } from "vitest";
import { createJobToolDefinitions } from "../dist/core/tools/background_jobs.js";
import { createBashToolDefinition } from "../dist/core/tools/bash.js";
import { BashJobRegistry } from "../dist/core/tools/bash_jobs.js";

const context = (signal = new AbortController().signal) => ({
  signal,
  emitActivity: async () => {},
  agentId: "agent",
  turnId: "turn",
  assistantMessageId: "message",
});
const outputMetadata = (text) => [
  `~${Math.floor(Buffer.byteLength(text, "utf8") / 6)} tokens`,
  `${text.split("\n").length} line${text.includes("\n") ? "s" : ""}`,
];
const jobId = (text) => text.match(/job ([^ ]+)/)[1];

function createPendingBackend() {
  return {
    runBash: vi.fn(
      (_command, options) =>
        new Promise((resolve) => {
          options.onStarted();
          options.onOutput(Buffer.from("ready"));
          options.signal.addEventListener(
            "abort",
            () => {
              resolve({ exitCode: null, aborted: true, closeSignal: "SIGTERM", truncated: false });
            },
            { once: true },
          );
        }),
    ),
  };
}

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
    expect(jobs.format().text).toBe("No Bash jobs.");
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

it("survives turn cancellation, waits without killing, and stops independently", async () => {
  vi.useFakeTimers();
  const backend = createPendingBackend();
  const jobs = new BashJobRegistry();
  const other = new BashJobRegistry();
  const turn = new AbortController();
  try {
    const bash = createBashToolDefinition(backend, process.cwd(), jobs);
    const outcome = await bash.execute(
      {
        id: "start",
        name: "bash",
        arguments: { command: "server", background: true },
      },
      context(turn.signal),
    );
    expect(outcome.outcome).toBe("succeeded");
    const id = jobId(outcome.content[0].text);
    turn.abort();
    expect(backend.runBash.mock.calls[0][1].signal.aborted).toBe(false);
    expect(jobs.read([id])).toEqual([
      expect.objectContaining({ status: "running", output: "ready" }),
    ]);
    const expiry = jobs.waitJobs([id], 10, context().signal);
    await vi.advanceTimersByTimeAsync(10);
    expect(await expiry).toBe(true);
    expect(jobs.hasRunning).toBe(true);
    const wait = new AbortController();
    const waiting = jobs.waitJobs([id], 60_000, wait.signal);
    wait.abort();
    await expect(waiting).rejects.toBeDefined();
    expect(backend.runBash.mock.calls[0][1].signal.aborted).toBe(false);
    const second = await other.start(backend, "other server", process.cwd(), context().signal);
    const stopTool = createJobToolDefinitions(jobs, "bash").find(
      (tool) => tool.schema.name === "stop_bash_job",
    );
    const stopped = await stopTool.execute(
      { id: "stop", name: "stop_bash_job", arguments: { id, includeOutput: false } },
      context(),
    );
    expect(stopped.outcome).toBe("succeeded");
    expect(stopped.content[0].text).not.toContain("\nready");
    expect(jobs.read([id])).toEqual([
      expect.objectContaining({ status: "stopped", aborted: true }),
    ]);
    expect(other.read([second])).toEqual([expect.objectContaining({ status: "running" })]);
    expect(backend.runBash.mock.calls[1][1].signal.aborted).toBe(false);
    expect(() => other.read([id])).toThrow();
    expect(() => jobs.read([second])).toThrow();
  } finally {
    try {
      await Promise.all([jobs.dispose(), other.dispose()]);
    } finally {
      vi.useRealTimers();
    }
  }
});

it("defaults waits to 60 seconds, validates the cap, and retains a running job on expiry", async () => {
  const jobs = new BashJobRegistry();
  const backend = createPendingBackend();
  const id = await jobs.start(backend, "server", process.cwd(), context().signal);
  try {
    const tool = createJobToolDefinitions(jobs, "bash").find(
      (tool) => tool.schema.name === "wait_for_bash_jobs",
    );
    for (const timeout of [0, -1, 0.5, 300001]) {
      expect((await tool.execute({ arguments: { ids: [id], timeout } }, context())).outcome).toBe(
        "blocked",
      );
    }
    vi.useFakeTimers();
    const events = [];
    const waiting = tool.execute(
      { arguments: { ids: [id], includeOutput: false } },
      {
        ...context(),
        emitActivity: async (event) => events.push(event),
      },
    );
    await vi.advanceTimersByTimeAsync(59999);
    expect(jobs.format([id]).text).toContain("running");
    await vi.advanceTimersByTimeAsync(1);
    const result = await waiting;
    expect(result.outcome).toBe("succeeded");
    expect(result.content[0].text).toContain("Wait timed out after 60000ms");
    expect(result.content[0].text).not.toContain("\nready");
    expect(events.at(-1).presentation.metadata).toEqual([
      "60s",
      ...outputMetadata(result.content[0].text),
      "timed out",
    ]);
    expect(jobs.format([id]).text).toContain("running");
  } finally {
    vi.useRealTimers();
    await jobs.dispose();
  }
});

it("bounds job records and reports backend cleanup failures", async () => {
  const jobs = new BashJobRegistry();
  const backend = {
    runBash: (_command, options) =>
      new Promise((_resolve, reject) => {
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
    expect(jobs.format().text).toContain("failed to terminate process group");
    await expect(jobs.start(backend, "closed", "/workspace", context().signal)).rejects.toThrow(
      "closed",
    );
  } finally {
    await jobs.dispose();
  }
});

it("marks model-tail truncation across multiple jobs without counting hidden output", async () => {
  const jobs = new BashJobRegistry();
  const backend = {
    async runBash(_command, options) {
      options.onStarted();
      options.onOutput(Buffer.from("日本語\n".repeat(6000)));
      return { exitCode: 0, aborted: false, closeSignal: null, truncated: false };
    },
  };
  try {
    const ids = await Promise.all(
      ["one", "two"].map((command) => jobs.start(backend, command, "/Workspace", context().signal)),
    );
    await jobs.waitForIdle();
    const tool = createJobToolDefinitions(jobs, "bash").find(
      (tool) => tool.schema.name === "wait_for_bash_jobs",
    );
    for (const includeOutput of [true, false]) {
      const events = [];
      const result = await tool.execute(
        {
          id: "wait",
          name: tool.schema.name,
          arguments: { ids, includeOutput },
        },
        { ...context(), emitActivity: async (event) => events.push(event) },
      );
      expect(events.at(-1).presentation.metadata).toEqual([
        ...(includeOutput ? ["◆"] : []),
        expect.stringMatching(/^\d+(?:\.\d+)?(?:ms|s)$/),
        ...outputMetadata(result.content[0].text),
      ]);
    }
  } finally {
    await jobs.dispose();
  }
});

it.each([false, true])(
  "writes the bounded capture only on completion (write failure: %s)",
  async (fail) => {
    const jobs = new BashJobRegistry();
    let emit;
    const backend = {
      runBash: vi.fn((_command, options) => {
        emit = (text) => options.onOutput(Buffer.from(text));
        options.onStarted();
        return new Promise((resolve) => {
          options.signal.addEventListener("abort", () => {
            resolve({ exitCode: null, aborted: true, closeSignal: "SIGTERM", truncated: false });
          });
        });
      }),
      runNodeScript: vi.fn(async () => ({ exitCode: 0, stdout: "/remote/output.txt" })),
      writeFile: vi.fn(async (path) => {
        if (fail) throw new Error("offline");
        return { path };
      }),
    };
    try {
      const id = await jobs.start(backend, "server", "/workspace", context().signal);
      emit(`oldest${"é".repeat(13 * 1024 * 1024)}\u001b[31mlatest\u001b[0m`);
      const first = await jobs.inspect([id], true, 100);
      const retained = jobs.read([id])[0].output;
      expect(Buffer.byteLength(retained)).toBeLessThanOrEqual(24 * 1024 * 1024);
      expect(Buffer.byteLength(retained)).toBeGreaterThan(23 * 1024 * 1024);
      expect(retained).not.toContain("oldest");
      expect(retained).not.toContain("\u001b");
      expect(first.truncated).toBe(true);
      expect(first.text).toContain("latest");
      expect(first.text).not.toContain("text_log:");
      expect(backend.runNodeScript).not.toHaveBeenCalled();
      emit("next");
      await jobs.stopJob(id);
      const completed = await jobs.inspect([id]);
      expect(await jobs.inspect([id, id])).toEqual(completed);
      expect(completed.text.includes("/remote/output.txt")).toBe(!fail);
      expect(backend.writeFile).toHaveBeenCalledExactlyOnceWith(
        "/remote/output.txt",
        jobs.read([id])[0].output,
      );
      await jobs.inspect([id]);
      expect(backend.writeFile).toHaveBeenCalledTimes(1);
    } finally {
      await jobs.dispose();
    }
  },
);
