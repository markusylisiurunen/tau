import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureDiffReviewSnapshot } from "../dist/core/diff_review/snapshot.js";
import { prepareSessionCompaction } from "../dist/core/session/compaction.js";
import { runDirectBashCommand } from "../dist/core/session/direct_bash.js";
import { runModelSubturn, SequentialToolCallRunner } from "../dist/core/session/runner.js";
import { BASH_DEFAULT_TIMEOUT_MS } from "../dist/core/tools/bash.js";
import { scopeToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { buildToolRunPresentation } from "../dist/core/tools/presentation.js";
import { ToolRegistry } from "../dist/core/tools/registry.js";
import { buildCompactionUserMessage } from "../dist/core/utils/compact.js";
import { autocompleteProjectPathsWithBackend } from "../dist/core/utils/project_files.js";
import { prependTauUserMetadata } from "../dist/core/utils/user_metadata.js";
import {
  createSdkDiffSnapshotDeps,
  createSdkToolExecutionBackend,
} from "../dist/tui/session_tool_execution_backend.js";

function createModelStream(events, result, error) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
      if (error) {
        throw error;
      }
    },
    async result() {
      if (error) {
        throw error;
      }
      return result;
    },
  };
}

describe("session runner", () => {
  it("coalesces rapid assistant partials and flushes the final accumulated partial", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const finalMessage = {
      role: "assistant",
      api: "anthropic",
      provider: "anthropic",
      model: "claude-opus",
      stopReason: "end_turn",
      content: [{ type: "text", text: "abc" }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const modelRuntime = {
      streamModel() {
        return createModelStream(
          [
            { type: "text_delta", delta: "a" },
            { type: "text_delta", delta: "b" },
            { type: "text_delta", delta: "c" },
          ],
          finalMessage,
        );
      },
    };

    try {
      const events = [];
      const runner = runModelSubturn({
        model: {},
        context: {},
        streamModel: modelRuntime.streamModel.bind(modelRuntime),
        streamOptions: {},
        signal: new AbortController().signal,
        emitPartials: true,
      });
      while (true) {
        const next = await runner.next();
        if (next.done) {
          expect(next.value).toBe(finalMessage);
          break;
        }
        events.push(next.value);
      }

      expect(events).toEqual([
        {
          type: "assistant_partial",
          snapshot: {
            text: "a",
            thinking: "",
            toolCalls: [],
            hasTextStarted: true,
            hasAnyThinking: false,
          },
        },
        {
          type: "assistant_partial",
          snapshot: {
            text: "abc",
            thinking: "",
            toolCalls: [],
            hasTextStarted: true,
            hasAnyThinking: false,
          },
        },
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it("flushes a coalesced assistant partial while the model stream is idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const idle = Promise.withResolvers();
    const finalMessage = {
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-luna",
      stopReason: "stop",
      content: [{ type: "text", text: "ab" }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const streamModel = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", delta: "a" };
        yield { type: "text_delta", delta: "b" };
        await idle.promise;
      },
      async result() {
        return finalMessage;
      },
    });
    const runner = runModelSubturn({
      model: {},
      context: {},
      streamModel,
      streamOptions: {},
      signal: new AbortController().signal,
      emitPartials: true,
    });

    try {
      expect((await runner.next()).value.snapshot.text).toBe("a");
      const pendingPartial = runner.next();
      await vi.advanceTimersByTimeAsync(33);
      expect((await pendingPartial).value.snapshot.text).toBe("ab");
      idle.resolve();
      await expect(runner.next()).resolves.toEqual({ done: true, value: finalMessage });
    } finally {
      idle.resolve();
      await runner.return();
      vi.useRealTimers();
    }
  });

  it("publishes authoritative text-end content after streamed deltas", async () => {
    const finalMessage = {
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-luna",
      stopReason: "stop",
      content: [{ type: "text", text: "I am checking all eight independent locations now." }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const streamModel = () =>
      createModelStream(
        [
          { type: "text_delta", delta: "I am checking all eight independent" },
          {
            type: "text_end",
            content: "I am checking all eight independent locations now.",
          },
        ],
        finalMessage,
      );
    const events = [];
    const runner = runModelSubturn({
      model: {},
      context: {},
      streamModel,
      streamOptions: {},
      signal: new AbortController().signal,
      emitPartials: true,
    });

    while (true) {
      const next = await runner.next();
      if (next.done) {
        expect(next.value).toBe(finalMessage);
        break;
      }
      events.push(next.value);
    }

    expect(events.map((event) => event.snapshot.text)).toEqual([
      "I am checking all eight independent",
      "I am checking all eight independent locations now.",
    ]);
  });

  it("flushes pending assistant text before tool-call streaming", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const toolCall = {
      id: "tool-call-1",
      type: "toolCall",
      name: "fake_tool",
      arguments: {},
    };
    const finalMessage = {
      role: "assistant",
      api: "anthropic",
      provider: "anthropic",
      model: "claude-opus",
      stopReason: "toolUse",
      content: [{ type: "text", text: "ab" }, toolCall],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const modelRuntime = {
      streamModel() {
        return createModelStream(
          [
            { type: "text_delta", delta: "a" },
            { type: "text_delta", delta: "b" },
            { type: "toolcall_start", contentIndex: 1, partial: finalMessage },
            { type: "toolcall_delta", contentIndex: 1, delta: "{}", partial: finalMessage },
            { type: "toolcall_end", contentIndex: 1, toolCall, partial: finalMessage },
          ],
          finalMessage,
        );
      },
    };

    try {
      const events = [];
      const runner = runModelSubturn({
        model: {},
        context: {},
        streamModel: modelRuntime.streamModel.bind(modelRuntime),
        streamOptions: {},
        signal: new AbortController().signal,
        emitPartials: true,
      });
      while (true) {
        const next = await runner.next();
        if (next.done) {
          expect(next.value).toBe(finalMessage);
          break;
        }
        events.push(next.value);
      }

      expect(events).toEqual([
        {
          type: "assistant_partial",
          snapshot: {
            text: "a",
            thinking: "",
            toolCalls: [],
            hasTextStarted: true,
            hasAnyThinking: false,
          },
        },
        {
          type: "assistant_partial",
          snapshot: {
            text: "ab",
            thinking: "",
            toolCalls: [],
            hasTextStarted: true,
            hasAnyThinking: false,
          },
        },
        {
          type: "tool_call_streaming",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          contentIndex: 1,
        },
        {
          type: "assistant_partial",
          snapshot: {
            text: "ab",
            thinking: "",
            toolCalls: [toolCall],
            hasTextStarted: true,
            hasAnyThinking: false,
          },
        },
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it("discards completed calls still buffered behind earlier calls", async () => {
    const earlierCall = {
      id: "earlier-call",
      type: "toolCall",
      name: "bash",
      arguments: {},
    };
    const laterCall = {
      id: "later-call",
      type: "toolCall",
      name: "write",
      arguments: {},
    };
    const partial = {
      role: "assistant",
      content: [earlierCall, laterCall],
      timestamp: 1,
    };
    const modelRuntime = {
      streamModel() {
        return createModelStream(
          [
            { type: "toolcall_start", contentIndex: 0, partial },
            { type: "toolcall_start", contentIndex: 1, partial },
            { type: "toolcall_end", contentIndex: 1, toolCall: laterCall, partial },
          ],
          undefined,
          new Error("stream failed"),
        );
      },
    };
    const runner = runModelSubturn({
      model: {},
      context: {},
      streamModel: modelRuntime.streamModel.bind(modelRuntime),
      streamOptions: {},
      signal: new AbortController().signal,
      emitPartials: true,
    });
    const events = [];

    await expect(async () => {
      while (true) {
        const next = await runner.next();
        if (next.done) break;
        events.push(next.value);
      }
    }).rejects.toThrow("stream failed");

    expect(events).toEqual([
      {
        type: "tool_call_streaming",
        toolCallId: earlierCall.id,
        toolName: earlierCall.name,
        contentIndex: 0,
      },
      {
        type: "tool_call_streaming",
        toolCallId: laterCall.id,
        toolName: laterCall.name,
        contentIndex: 1,
      },
      {
        type: "tool_call_discarded",
        toolCallId: earlierCall.id,
        contentIndex: 0,
      },
      {
        type: "tool_call_discarded",
        toolCallId: laterCall.id,
        contentIndex: 1,
      },
    ]);
  });

  it("flushes the latest pending assistant partial before a stream error", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const modelRuntime = {
      streamModel() {
        return createModelStream(
          [
            { type: "text_delta", delta: "a" },
            { type: "text_delta", delta: "b" },
          ],
          undefined,
          new Error("stream failed"),
        );
      },
    };

    try {
      const events = [];
      const runner = runModelSubturn({
        model: {},
        context: {},
        streamModel: modelRuntime.streamModel.bind(modelRuntime),
        streamOptions: {},
        signal: new AbortController().signal,
        emitPartials: true,
      });
      await expect(async () => {
        while (true) {
          const next = await runner.next();
          if (next.done) {
            break;
          }
          events.push(next.value);
        }
      }).rejects.toThrow("stream failed");

      expect(events.map((event) => event.snapshot.text)).toEqual(["a", "ab"]);
    } finally {
      now.mockRestore();
    }
  });

  it("releases pending tool acknowledgements when event consumption stops", async () => {
    const call = {
      id: "activity-call",
      type: "toolCall",
      name: "activity-tool",
      arguments: {},
    };
    const registry = new ToolRegistry([
      {
        schema: {
          name: call.name,
          description: "activity tool",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
        describe: () => ({
          presentation: buildToolRunPresentation({ toolName: call.name, subject: call.name }),
        }),
        execute: async (_call, context) => {
          await context.emitActivity({
            type: "tool_call_blocked",
            toolCallId: call.id,
            toolName: call.name,
            reason: "activity",
            presentation: buildToolRunPresentation({ toolName: call.name, subject: call.name }),
          });
          return { content: [{ type: "text", text: "done" }], outcome: "succeeded" };
        },
      },
    ]);
    const runner = new SequentialToolCallRunner(
      {
        toolRegistry: registry,
        executionContext: {
          agentId: "agent-1",
          turnId: "turn-1",
          assistantMessageId: "assistant-1",
        },
      },
      new AbortController().signal,
    );
    const admission = runner.prepare(call);
    admission.start();
    const iterator = runner[Symbol.asyncIterator]();
    const started = await iterator.next();
    started.value.acknowledge();
    const activity = await iterator.next();
    expect(activity.value.type).toBe("tool_activity");

    runner.cancelPendingAcknowledgements(new Error("event sink failed"));

    await expect(runner.finish()).rejects.toThrow("event sink failed");
  });

  it("de-duplicates preserved user message candidates across repeated compactions", () => {
    const summaryText = prependTauUserMetadata(buildCompactionUserMessage({ summary: "old" }), [
      {
        type: "auto-compaction",
        version: 1,
        summary: "old",
        preservedUserMessages: [{ id: "entry-1", text: "retained request from summary" }],
        cutType: "turn-boundary",
        retainedMessageCount: 1,
      },
    ]);
    const entries = [
      { id: "summary", message: userMessage(summaryText) },
      {
        id: "entry-1",
        message: userMessage("retained request from live history"),
      },
      { id: "entry-2", message: userMessage("new request") },
    ];

    const preparation = prepareSessionCompaction(entries, {
      systemPrompt: "system",
    });

    expect(preparation.userMessageCandidates).toEqual([
      {
        id: "entry-1",
        text: "retained request from live history",
        source: "conversation",
      },
      { id: "entry-2", text: "new request", source: "conversation" },
    ]);
  });
});

describe("session execution backend plumbing", () => {
  it("writes binary files through login Bash stdin without text conversion", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tau-sdk-backend-test-"));
    const session = {
      async exec(command, options) {
        const result = spawnSync("/bin/bash", ["-lc", command, ...(options.args ?? [])], {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          input: options.stdin,
        });
        const stdout = result.stdout.toString("utf-8");
        const stderr = result.stderr.toString("utf-8");
        return {
          output: stdout + stderr,
          stdout,
          stderr,
          exitCode: result.status,
          truncated: false,
          timedOut: false,
          aborted: false,
          closeSignal: result.signal,
        };
      },
    };
    const backend = createSdkToolExecutionBackend({ executionEnvironment: session, cwd });
    const content = Buffer.from([0, 255, 1]);

    try {
      await expect(backend.writeFileBinary("assets/image.bin", content)).resolves.toEqual({
        path: "assets/image.bin",
        bytes: content.byteLength,
      });
      expect(readFileSync(join(cwd, "assets/image.bin"))).toEqual(content);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("captures no-HEAD diff snapshots through automation-safe login Bash", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tau-sdk-diff-test-"));
    const runGit = (args) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout);
      }
    };
    const execOptions = [];
    const session = {
      async exec(command, options) {
        execOptions.push(options);
        const result = spawnSync(
          "/bin/bash",
          ["-lc", `set -e\n${command}`, ...(options.args ?? [])],
          {
            cwd: options.cwd,
            env: { ...process.env, ...options.env },
            input: options.stdin,
            encoding: "utf8",
          },
        );
        return {
          output: result.stdout + result.stderr,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          truncated: false,
          timedOut: false,
          aborted: false,
          closeSignal: result.signal,
        };
      },
    };

    try {
      runGit(["init"]);
      writeFileSync(join(cwd, "tracked.txt"), "tracked\n");
      runGit(["add", "tracked.txt"]);
      writeFileSync(join(cwd, "untracked.txt"), "new\n");

      const backend = createSdkToolExecutionBackend({ executionEnvironment: session, cwd });
      const snapshot = await captureDiffReviewSnapshot({
        cwd,
        source: { kind: "git_diff", diffArgs: [] },
        deps: createSdkDiffSnapshotDeps({ backend, cwd }),
      });

      expect(snapshot.repoRoot).toBe(realpathSync(cwd));
      expect(snapshot.files.map((file) => file.path)).toEqual(["tracked.txt", "untracked.txt"]);
      expect(snapshot.patch).toContain("+tracked");
      expect(snapshot.getFilePatch("untracked.txt")).toContain("+new");
      expect(execOptions).toEqual(
        expect.arrayContaining([expect.objectContaining({ maxCaptureBytes: expect.any(Number) })]),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("preserves patch files larger than the default command capture limit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tau-sdk-large-patch-test-"));
    const patch = [
      "diff --git a/large.txt b/large.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/large.txt",
      "@@ -0,0 +1 @@",
      `+${"x".repeat(1_100_000)}`,
      "",
    ].join("\n");
    const patchPath = join(cwd, "large.patch");
    writeFileSync(patchPath, patch);
    const runGit = (args) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    };
    runGit(["init"]);
    const session = {
      async exec(command, options) {
        const result = spawnSync("/bin/bash", ["-lc", command, ...(options.args ?? [])], {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          input: options.stdin,
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        });
        return {
          output: result.stdout + result.stderr,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.status,
          truncated: false,
          timedOut: false,
          aborted: false,
          closeSignal: result.signal,
        };
      },
    };

    try {
      const backend = createSdkToolExecutionBackend({ executionEnvironment: session, cwd });
      const snapshot = await captureDiffReviewSnapshot({
        cwd,
        source: { kind: "patch_files", patchFiles: [patchPath], scopeLabel: "large patch" },
        deps: createSdkDiffSnapshotDeps({ backend, cwd }),
      });

      expect(Buffer.byteLength(snapshot.patch)).toBe(Buffer.byteLength(patch));
      expect(snapshot.files.map((file) => file.path)).toEqual(["large.txt"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("scopes backend cwd and filesystem paths to the execution environment", async () => {
    const calls = [];
    const backend = {
      async dispose() {},
      async runBash(command, options = {}) {
        calls.push(["runBash", command, options.cwd, options.env]);
        return {
          output: "",
          stdout: "",
          stderr: "",
          exitCode: 0,
          truncated: false,
        };
      },
      async readFile(path) {
        calls.push(["readFile", path]);
        return { path, content: "" };
      },
      async readFileBinary(path) {
        calls.push(["readFileBinary", path]);
        return { path, content: Buffer.from(""), bytes: 0 };
      },
      async writeFile(path, content) {
        calls.push(["writeFile", path, content]);
        return { path, bytes: Buffer.byteLength(content), lines: 1 };
      },
      async writeFileBinary(path, content) {
        calls.push(["writeFileBinary", path, content]);
        return { path, bytes: content.byteLength };
      },
      async listDir(path) {
        calls.push(["listDir", path]);
        return { path, entries: [] };
      },
    };

    const scoped = scopeToolExecutionBackend(backend, "/remote/work", {
      GH_CONFIG_DIR: "/srv/cowork/gh",
    });

    await scoped.runBash("pwd");
    await scoped.runBash("pwd", { cwd: "subdir", env: { EXTRA: "value" } });
    await scoped.readFile("src/a.ts");
    await scoped.readFileBinary("asset.bin");
    await scoped.writeFile("out.txt", "ok");
    await scoped.writeFileBinary("asset.bin", Buffer.from([1, 2]));
    await scoped.listDir(".");

    expect(calls).toEqual([
      ["runBash", "pwd", "/remote/work", { GH_CONFIG_DIR: "/srv/cowork/gh" }],
      [
        "runBash",
        "pwd",
        "/remote/work/subdir",
        { GH_CONFIG_DIR: "/srv/cowork/gh", EXTRA: "value" },
      ],
      ["readFile", "/remote/work/src/a.ts"],
      ["readFileBinary", "/remote/work/asset.bin"],
      ["writeFile", "/remote/work/out.txt", "ok"],
      ["writeFileBinary", "/remote/work/asset.bin", Buffer.from([1, 2])],
      ["listDir", "/remote/work"],
    ]);
  });

  it("autocompletes project paths from backend stdout and keeps partial results on non-zero exit", async () => {
    const calls = [];
    const backend = {
      async runNodeScript(script, args, options = {}) {
        calls.push({ script, args, options });
        return {
          output: "src/a.ts\nrg warning on stderr\n",
          stdout: "src/a.ts\nsrc/nested/b.ts\n",
          exitCode: 2,
        };
      },
    };

    await expect(
      autocompleteProjectPathsWithBackend(backend, {
        query: "src",
        limit: 10,
        cwd: ".",
      }),
    ).resolves.toEqual(["src/", "src/a.ts", "src/nested/", "src/nested/b.ts"]);
    expect(calls).toEqual([
      {
        script: expect.stringContaining('spawn("rg", ["--files", "--hidden"'),
        args: [],
        options: { cwd: ".", timeoutMs: 5000 },
      },
    ]);
  });

  it("runs direct bash with default timeout, abort signal, and optional context recording", async () => {
    const signal = new AbortController().signal;
    const received = [];
    const backend = {
      async runBash(command, options = {}) {
        received.push({ command, options });
        return {
          output: "hello\n",
          stdout: "hello\n",
          stderr: "",
          exitCode: 0,
          truncated: false,
          timedOut: false,
          aborted: false,
          closeSignal: null,
        };
      },
    };
    const addUserText = vi.fn(async () => "history-1");

    const result = await runDirectBashCommand({
      command: "echo hello",
      backend,
      workingDirectory: "/repo",
      actionLabel: "ran",
      signal,
      addToContext: true,
      addUserText,
      now: () => 100,
    });

    expect(received).toEqual([
      {
        command: "echo hello",
        options: { signal, timeoutMs: BASH_DEFAULT_TIMEOUT_MS },
      },
    ]);
    expect(addUserText).toHaveBeenCalledWith("Bash command output:\n$ echo hello\nhello");
    expect(result.userHistoryEntryId).toBe("history-1");

    await runDirectBashCommand({
      command: "echo skipped",
      backend,
      workingDirectory: "/repo",
      actionLabel: "ran",
      addToContext: false,
      addUserText,
      now: () => 100,
    });

    expect(addUserText).toHaveBeenCalledTimes(1);
  });

  it("records nonzero direct bash exit status in session history", async () => {
    const addUserText = vi.fn(async () => "history-1");
    const backend = {
      async runBash() {
        return {
          output: "",
          stdout: "",
          stderr: "",
          exitCode: 2,
          truncated: false,
          timedOut: false,
          aborted: false,
          closeSignal: null,
        };
      },
    };

    await runDirectBashCommand({
      command: "false",
      backend,
      workingDirectory: "/repo",
      actionLabel: "ran",
      addToContext: true,
      addUserText,
    });

    expect(addUserText).toHaveBeenCalledWith(
      "Bash command output:\n$ false\n(no output)\n(exit 2)",
    );
  });

  it("formats direct Bash termination from structured execution state", async () => {
    const addUserText = vi.fn(async () => "history-1");
    const backend = {
      async runBash() {
        return {
          output: "partial output\n",
          stdout: "partial output\n",
          stderr: "",
          exitCode: null,
          truncated: false,
          timedOut: true,
          aborted: false,
          closeSignal: "SIGTERM",
        };
      },
    };

    const result = await runDirectBashCommand({
      command: "sleep 60",
      backend,
      workingDirectory: "/repo",
      actionLabel: "ran",
      addToContext: true,
      addUserText,
    });

    expect(addUserText).toHaveBeenCalledWith(
      `Bash command output:\n$ sleep 60\npartial output\n\n[Command timed out after ${BASH_DEFAULT_TIMEOUT_MS}ms.]`,
    );
    expect(result.presentation.details).toEqual([
      { text: "partial output", wrap: "character" },
      { text: `[Command timed out after ${BASH_DEFAULT_TIMEOUT_MS}ms.]`, wrap: "word" },
    ]);
    expect(result.presentation.metadata).not.toContain("exit ?");
  });
});

function userMessage(text) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  };
}
