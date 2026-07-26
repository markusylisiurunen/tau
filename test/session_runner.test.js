import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureDiffReviewSnapshot } from "../dist/core/diff_review/snapshot.js";
import { prepareSessionCompaction } from "../dist/core/session/compaction.js";
import { runDirectBashCommand } from "../dist/core/session/direct_bash.js";
import {
  prepareSessionSmartPrunePrompt,
  pruneSessionHistory,
} from "../dist/core/session/pruning.js";
import { runModelSubturn, runToolCalls } from "../dist/core/session/runner.js";
import { BASH_DEFAULT_TIMEOUT_MS, createBashToolDefinition } from "../dist/core/tools/bash.js";
import { scopeToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { ToolRegistry } from "../dist/core/tools/registry.js";
import { TOOL_NAME_BASH, TOOL_NAME_EDIT } from "../dist/core/tools/tool_names.js";
import { createWriteToolDefinition } from "../dist/core/tools/write.js";
import { buildCompactionUserMessage } from "../dist/core/utils/compact.js";
import { autocompleteProjectPathsWithBackend } from "../dist/core/utils/project_files.js";
import { prependTauUserMetadata } from "../dist/core/utils/user_metadata.js";
import {
  createSdkDiffSnapshotDeps,
  createSdkToolExecutionBackend,
} from "../dist/tui/session_tool_execution_backend.js";

function createToolResult(toolCall, text) {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    timestamp: Date.now(),
    isError: false,
    content: [{ type: "text", text }],
  };
}

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

describe("session runner tool dispatch context", () => {
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
        modelRuntime,
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
        modelRuntime,
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

  it("replaces changed streamed identities and discards unfinished calls on failure", async () => {
    const oldCall = {
      id: "old-call",
      type: "toolCall",
      name: "write",
      arguments: {},
    };
    const newCall = { ...oldCall, id: "new-call" };
    const partial = {
      role: "assistant",
      content: [oldCall],
      timestamp: 1,
    };
    const modelRuntime = {
      streamModel() {
        return createModelStream(
          [
            { type: "toolcall_start", contentIndex: 0, partial },
            {
              type: "toolcall_delta",
              contentIndex: 0,
              delta: "{}",
              partial: { ...partial, content: [newCall] },
            },
          ],
          undefined,
          new Error("stream failed"),
        );
      },
    };
    const runner = runModelSubturn({
      model: {},
      context: {},
      modelRuntime,
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
        toolCallId: "old-call",
        toolName: "write",
        contentIndex: 0,
      },
      {
        type: "tool_call_streaming",
        toolCallId: "new-call",
        toolName: "write",
        contentIndex: 0,
      },
      {
        type: "tool_call_discarded",
        toolCallId: "new-call",
        contentIndex: 0,
      },
    ]);
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
      modelRuntime,
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

  it("retries without exposing tool calls when early execution is disabled", async () => {
    const toolCall = {
      id: "tool-call-1",
      type: "toolCall",
      name: "fake_tool",
      arguments: {},
    };
    const errorMessage = {
      role: "assistant",
      api: "anthropic",
      provider: "anthropic",
      model: "claude-opus",
      stopReason: "error",
      errorMessage: "network error",
      content: [toolCall],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const successMessage = {
      ...errorMessage,
      stopReason: "stop",
      errorMessage: undefined,
      content: [{ type: "text", text: "recovered" }],
    };
    let attempts = 0;
    const modelRuntime = {
      streamModel() {
        attempts += 1;
        if (attempts === 1) {
          return createModelStream(
            [
              { type: "toolcall_start", contentIndex: 0 },
              { type: "toolcall_end", contentIndex: 0, toolCall },
              { type: "error", reason: "error", error: errorMessage },
            ],
            errorMessage,
          );
        }
        return createModelStream([], successMessage);
      },
    };
    const runner = runModelSubturn({
      model: {},
      context: {},
      modelRuntime,
      streamOptions: {},
      signal: new AbortController().signal,
      emitPartials: false,
      retry: {
        shouldRetryAfterError: () => true,
        maxRetries: 1,
      },
    });
    const events = [];
    let finalMessage;
    while (true) {
      const next = await runner.next();
      if (next.done) {
        finalMessage = next.value;
        break;
      }
      events.push(next.value);
    }

    expect(attempts).toBe(2);
    expect(events).toEqual([]);
    expect(finalMessage).toBe(successMessage);
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
        modelRuntime,
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

  it("does not emit empty assistant partials for thinking start events", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const finalMessage = {
      role: "assistant",
      api: "anthropic",
      provider: "anthropic",
      model: "claude-opus",
      stopReason: "end_turn",
      content: [{ type: "text", text: "hello" }],
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
          [{ type: "thinking_start" }, { type: "text_delta", delta: "hello" }],
          finalMessage,
        );
      },
    };

    try {
      const events = [];
      const runner = runModelSubturn({
        model: {},
        context: {},
        modelRuntime,
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

      expect(events.map((event) => event.snapshot.text)).toEqual(["hello"]);
    } finally {
      now.mockRestore();
    }
  });

  it("emits queued UI events for all valid calls before executing the first tool", async () => {
    const signal = new AbortController().signal;
    const slowCall = {
      id: "slow-call",
      type: "toolCall",
      name: "slow_tool",
      arguments: {},
    };
    const fastCall = {
      id: "fast-call",
      type: "toolCall",
      name: "fast_tool",
      arguments: {},
    };

    let resolveSlow;
    const slowRun = new Promise((resolve) => {
      resolveSlow = resolve;
    });
    let fastDispatched = false;

    const slowDefinition = {
      schema: {
        name: "slow_tool",
        description: "test",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      getDisplayTarget: () => "sleep 30",
      async dispatch(call) {
        return {
          startedUiEvent: {
            type: "bash_started",
            toolCallId: call.id,
            command: "sleep 30",
            headerTarget: "sleep 30",
          },
          run: slowRun.then(() => ({
            toolResult: createToolResult(call, "slow ok"),
            uiEvent: {
              type: "bash_execution",
              toolCallId: call.id,
              command: "sleep 30",
              headerTarget: "sleep 30",
              exitCode: 0,
              truncationInfo: {
                output: "",
                model: {
                  content: "",
                  truncated: false,
                  totalBytes: 0,
                  totalLines: 0,
                  outputBytes: 0,
                  outputLines: 0,
                },
                captureTruncated: false,
              },
              uiText: {
                previewLines: [],
                fullLines: [],
              },
            },
          })),
        };
      },
    };

    const fastDefinition = {
      schema: {
        name: "fast_tool",
        description: "test",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      getDisplayTarget: () => "fast.txt",
      async dispatch(call) {
        fastDispatched = true;
        return {
          run: Promise.resolve({
            toolResult: createToolResult(call, "fast ok"),
            uiEvent: {
              type: "write_success",
              toolCallId: call.id,
              path: "fast.txt",
              headerTarget: "fast.txt",
              bytes: 2,
              lines: 1,
              content: "ok",
              uiText: {
                previewLines: [{ text: "ok" }],
                fullLines: [{ text: "ok" }],
              },
            },
          }),
        };
      },
    };

    const toolRegistry = new ToolRegistry([slowDefinition, fastDefinition]);
    const dispatchContext = {
      scope: "subagent",
      config: {},
      toolRegistry,
      authPath: "/tmp/auth.json",
      originHistoryEntryId: "history-1",
      cwd: "/repo/subagent",
    };

    const iterator = runToolCalls({
      toolCalls: [slowCall, fastCall],
      toolRegistry,
      enabledTools: toolRegistry.schemas,
      signal,
      dispatchContext,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: "tool_ui",
        uiEvent: {
          type: "tool_call_queued",
          toolCallId: "slow-call",
          headerTarget: "sleep 30",
        },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: "tool_ui",
        uiEvent: {
          type: "tool_call_queued",
          toolCallId: "fast-call",
          headerTarget: "fast.txt",
        },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: "tool_ui",
        uiEvent: { type: "bash_started", toolCallId: "slow-call" },
      },
    });
    expect(fastDispatched).toBe(false);

    resolveSlow();
    const rest = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }

    expect(fastDispatched).toBe(true);
    expect(
      rest.map((event) => (event.type === "tool_ui" ? event.uiEvent.type : event.type)),
    ).toEqual(["bash_execution", "write_success", "tool_result", "tool_result"]);
  });

  it("derives queued targets from completed built-in tool arguments", async () => {
    const abortController = new AbortController();
    const toolRegistry = new ToolRegistry([
      createBashToolDefinition({}),
      createWriteToolDefinition({}),
    ]);
    const dispatchContext = {
      scope: "subagent",
      config: {},
      toolRegistry,
      authPath: "/tmp/auth.json",
      originHistoryEntryId: "history-1",
      cwd: "/repo/subagent",
    };
    const iterator = runToolCalls({
      toolCalls: [
        {
          id: "bash-call",
          type: "toolCall",
          name: "bash",
          arguments: { command: "printf hello\nprintf ignored" },
        },
        {
          id: "second-bash-call",
          type: "toolCall",
          name: "bash",
          arguments: { command: "ssh host 'du -h /'" },
        },
        {
          id: "write-call",
          type: "toolCall",
          name: "write",
          arguments: { path: "src/output.ts", content: "content" },
        },
        {
          id: "invalid-bash-call",
          type: "toolCall",
          name: "bash",
          arguments: { command: 42 },
        },
      ],
      toolRegistry,
      enabledTools: toolRegistry.schemas,
      signal: abortController.signal,
      dispatchContext,
    })[Symbol.asyncIterator]();
    const queuedEvents = [];

    for (let index = 0; index < 4; index++) {
      const next = await iterator.next();
      queuedEvents.push(next.value);
    }

    expect(
      queuedEvents.map((event) => [
        event.uiEvent.type,
        event.uiEvent.toolCallId,
        event.uiEvent.toolName,
        event.uiEvent.headerTarget,
      ]),
    ).toEqual([
      ["tool_call_queued", "bash-call", "bash", "printf hello"],
      ["tool_call_queued", "second-bash-call", "bash", "ssh host 'du -h /'"],
      ["tool_call_queued", "write-call", "write", "src/output.ts"],
      ["tool_call_queued", "invalid-bash-call", "bash", "(invalid arguments)"],
    ]);

    abortController.abort();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("emits a terminal blocked event for calls rejected before dispatch", async () => {
    const toolCall = {
      id: "blocked-call",
      type: "toolCall",
      name: "disabled_tool",
      arguments: {},
    };
    const events = [];
    const toolRegistry = new ToolRegistry([]);
    for await (const event of runToolCalls({
      toolCalls: [toolCall],
      toolRegistry,
      enabledTools: [],
      signal: new AbortController().signal,
      dispatchContext: {
        scope: "main",
        config: {},
        toolRegistry,
        authPath: "/tmp/auth.json",
        originHistoryEntryId: "history-1",
        cwd: "/repo",
      },
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "tool_ui",
        uiEvent: {
          type: "tool_call_blocked",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          headerTarget: toolCall.name,
          reason: "Tool 'disabled_tool' is not enabled for this session.",
        },
      },
      {
        type: "notice",
        severity: "error",
        text: "Tool 'disabled_tool' is not enabled for this session.",
      },
      {
        type: "tool_result",
        message: expect.objectContaining({ toolCallId: toolCall.id, isError: true }),
      },
    ]);
  });

  it("converts rejected tool runs into tool error results", async () => {
    const signal = new AbortController().signal;
    const toolCall = {
      id: "tool-call-1",
      type: "toolCall",
      name: "fake_tool",
      arguments: {},
    };
    const definition = {
      schema: {
        name: "fake_tool",
        description: "test",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      getDisplayTarget: () => "fake_tool",
      async dispatch() {
        return { run: Promise.reject(new Error("run failed")) };
      },
    };
    const toolRegistry = new ToolRegistry([definition]);
    const dispatchContext = {
      scope: "subagent",
      config: {},
      toolRegistry,
      authPath: "/tmp/auth.json",
      originHistoryEntryId: "history-1",
      cwd: "/repo/subagent",
    };

    const events = [];
    for await (const event of runToolCalls({
      toolCalls: [toolCall],
      toolRegistry,
      enabledTools: toolRegistry.schemas,
      signal,
      dispatchContext,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: "tool_ui",
        uiEvent: expect.objectContaining({ type: "tool_call_queued" }),
      }),
      {
        type: "notice",
        severity: "error",
        text: "Tool 'fake_tool' (tool-call-1) execution failed: run failed",
      },
      {
        type: "tool_result",
        message: expect.objectContaining({
          toolCallId: "tool-call-1",
          toolName: "fake_tool",
          isError: true,
        }),
      },
    ]);
  });

  it("passes dispatchContext to tool definitions", async () => {
    const signal = new AbortController().signal;
    const toolCall = {
      id: "tool-call-1",
      type: "toolCall",
      name: "fake_tool",
      arguments: {},
    };

    let receivedContext;
    let receivedSignal;

    const definition = {
      schema: {
        name: "fake_tool",
        description: "test",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      getDisplayTarget: () => "fake_tool",
      async dispatch(call, dispatchSignal, context) {
        receivedSignal = dispatchSignal;
        receivedContext = context;
        return {
          run: Promise.resolve({ toolResult: createToolResult(call, "ok") }),
        };
      },
    };

    const toolRegistry = new ToolRegistry([definition]);
    const dispatchContext = {
      scope: "subagent",
      config: {},
      toolRegistry,
      authPath: "/tmp/auth.json",
      originHistoryEntryId: "history-1",
      cwd: "/repo/subagent",
    };

    const events = [];
    for await (const event of runToolCalls({
      toolCalls: [toolCall],
      toolRegistry,
      enabledTools: toolRegistry.schemas,
      signal,
      dispatchContext,
    })) {
      events.push(event);
    }

    expect(receivedSignal).toBe(signal);
    expect(receivedContext).toBe(dispatchContext);
    expect(events).toEqual([
      {
        type: "tool_ui",
        uiEvent: {
          type: "tool_call_queued",
          toolCallId: "tool-call-1",
          toolName: "fake_tool",
          headerTarget: "fake_tool",
        },
      },
      {
        type: "tool_result",
        message: expect.objectContaining({
          role: "toolResult",
          toolCallId: "tool-call-1",
          toolName: "fake_tool",
          isError: false,
        }),
      },
    ]);
  });
});

describe("session pruning", () => {
  it("prunes bash results plus edit call payloads and success results", () => {
    const entries = [
      {
        id: "assistant-edit",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "edit-1",
              name: TOOL_NAME_EDIT,
              arguments: {
                path: "src/example.ts",
                oldText: "before\nsame",
                newText: "after\nsame",
              },
            },
          ],
          timestamp: 1,
        },
      },
      {
        id: "edit-result",
        message: {
          role: "toolResult",
          toolCallId: "edit-1",
          toolName: TOOL_NAME_EDIT,
          content: [{ type: "text", text: "Successfully edited src/example.ts" }],
          isError: false,
          timestamp: 2,
        },
      },
      {
        id: "bash-result",
        message: {
          role: "toolResult",
          toolCallId: "bash-1",
          toolName: TOOL_NAME_BASH,
          content: [{ type: "text", text: "x".repeat(12_000) }],
          isError: false,
          timestamp: 3,
        },
      },
    ];

    const result = pruneSessionHistory({
      historyEntries: entries,
      replaceMessageById(historyEntryId, message) {
        const index = entries.findIndex((entry) => entry.id === historyEntryId);
        if (index < 0) {
          return false;
        }
        entries[index] = { ...entries[index], message };
        return true;
      },
      options: { strategy: "earliest", fraction: 1 },
    });

    expect(result).toEqual(
      expect.objectContaining({
        noop: false,
        bashResultsPruned: 1,
        editCallsPruned: 1,
        editResultsPruned: 1,
      }),
    );
    expect(entries[0].message.content[0].arguments.oldText).toBe("[Content pruned]");
    expect(entries[0].message.content[0].arguments.newText).toBe("[Content pruned]");

    const editText = entries[1].message.content[0].text;
    expect(editText).toContain("[Tool result pruned] Edit diff");
    expect(editText).toContain("- before");
    expect(editText).toContain("+ after");

    const bashText = entries[2].message.content[0].text;
    expect(bashText).toContain("[Tool result pruned] bash output removed");
    expect(result.prunedToolResults.map((item) => item.toolCallId)).toEqual(["edit-1", "bash-1"]);
  });

  it("strips tau metadata but keeps hidden system blocks in smart prune prompts", () => {
    const rawUserText = prependTauUserMetadata(
      "<system>hidden pruning context</system>\nvisible request",
      [
        {
          type: "compaction",
          version: 1,
          summary: "old summary",
          preservedUserMessages: [],
        },
      ],
    );
    const request = prepareSessionSmartPrunePrompt({
      historyEntries: [
        { id: "user", message: userMessage(rawUserText) },
        {
          id: "bash-result",
          message: {
            role: "toolResult",
            toolCallId: "bash-1",
            toolName: TOOL_NAME_BASH,
            content: [{ type: "text", text: "x".repeat(12_000) }],
            isError: false,
            timestamp: 1,
          },
        },
      ],
      fraction: 1,
    });

    expect(request?.prompt).toContain("&lt;system&gt;hidden pruning context&lt;/system&gt;");
    expect(request?.prompt).toContain("visible request");
    expect(request?.prompt).not.toContain("TAU_METADATA_V1");
    expect(request?.prompt).not.toContain("old summary");
  });

  it("skips malformed rejected edit calls while pruning valid calls", () => {
    const entries = [
      {
        id: "valid-edit",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "edit-valid",
              name: TOOL_NAME_EDIT,
              arguments: { path: "src/a.ts", oldText: "before", newText: "after" },
            },
          ],
          timestamp: 1,
        },
      },
      {
        id: "malformed-edit",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "edit-malformed",
              name: TOOL_NAME_EDIT,
              arguments: { path: "src/b.ts", oldText: 42 },
            },
          ],
          timestamp: 2,
        },
      },
    ];

    const result = pruneSessionHistory({
      historyEntries: entries,
      replaceMessageById(historyEntryId, message) {
        const index = entries.findIndex((entry) => entry.id === historyEntryId);
        entries[index] = { ...entries[index], message };
        return true;
      },
      options: { strategy: "earliest", fraction: 1 },
    });

    expect(result.editCallsPruned).toBe(1);
    expect(entries[0].message.content[0].arguments.oldText).toBe("[Content pruned]");
    expect(entries[1].message.content[0].arguments).toEqual({
      path: "src/b.ts",
      oldText: 42,
    });
  });

  it("fails fast when a selected prune replacement cannot be applied", () => {
    const entries = [
      {
        id: "bash-result",
        message: {
          role: "toolResult",
          toolCallId: "bash-1",
          toolName: TOOL_NAME_BASH,
          content: [{ type: "text", text: "x".repeat(12_000) }],
          isError: false,
          timestamp: 1,
        },
      },
    ];

    expect(() =>
      pruneSessionHistory({
        historyEntries: entries,
        replaceMessageById: () => false,
        options: { strategy: "earliest", fraction: 1 },
      }),
    ).toThrow("failed to replace pruned bash tool result 'bash-result'");
  });
});

describe("session compaction preparation", () => {
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
  it("writes binary files through the SDK execution backend without text conversion", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tau-sdk-backend-test-"));
    const session = {
      async exec(command, options) {
        const result = spawnSync("/bin/sh", ["-c", command], {
          cwd: options.cwd,
          encoding: "utf8",
        });
        const stdout = `profile stdout\n${result.stdout}logout stdout\n`;
        const stderr = `profile stderr\n${result.stderr}logout stderr\n`;
        return {
          output: stdout + stderr,
          stdout,
          stderr,
          exitCode: result.status,
          truncated: false,
        };
      },
    };
    const backend = createSdkToolExecutionBackend({ session, cwd });
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

  it("captures no-HEAD diff snapshots with noisy errexit login profiles", async () => {
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
        const result = spawnSync("/bin/bash", ["-c", `set -e\n${command}`], {
          cwd: options.cwd,
          encoding: "utf8",
        });
        const stdout = `profile stdout\n${result.stdout}logout stdout\n`;
        const stderr = `profile stderr\n${result.stderr}logout stderr\n`;
        return {
          output: stdout + stderr,
          stdout,
          stderr,
          exitCode: result.status,
          truncated: false,
        };
      },
    };

    try {
      runGit(["init"]);
      writeFileSync(join(cwd, "tracked.txt"), "tracked\n");
      runGit(["add", "tracked.txt"]);
      writeFileSync(join(cwd, "untracked.txt"), "new\n");

      const backend = createSdkToolExecutionBackend({ session, cwd });
      const snapshot = await captureDiffReviewSnapshot({
        cwd,
        source: { kind: "git_diff", diffArgs: [] },
        deps: createSdkDiffSnapshotDeps({ backend, cwd }),
      });

      expect(snapshot.repoRoot).toBe(cwd);
      expect(snapshot.files.map((file) => file.path)).toEqual(["tracked.txt", "untracked.txt"]);
      expect(snapshot.patch).toContain("+tracked");
      expect(snapshot.getFilePatch("untracked.txt")).toContain("+new");
      expect(snapshot.patch).not.toContain("profile stdout");
      expect(snapshot.patch).not.toContain("logout stdout");
      expect(execOptions).toEqual(
        expect.arrayContaining([expect.objectContaining({ maxCaptureBytes: expect.any(Number) })]),
      );
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
        };
      },
    };
    const addUserText = vi.fn(async () => "history-1");

    const result = await runDirectBashCommand({
      command: "echo hello",
      backend,
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
        };
      },
    };

    await runDirectBashCommand({
      command: "false",
      backend,
      addToContext: true,
      addUserText,
    });

    expect(addUserText).toHaveBeenCalledWith(
      "Bash command output:\n$ false\n(no output)\n(exit 2)",
    );
  });
});

function userMessage(text) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  };
}
