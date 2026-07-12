import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../dist/core/commands/index.js";
import { safeParseCoreEventEnvelope } from "../dist/core/events/parser.js";
import { personas } from "../dist/core/personas.js";
import { ConversationTurnRuntime } from "../dist/core/runtime/conversation_turn_runtime.js";
import { resolveRuntimePromptBootstrap } from "../dist/core/runtime/runtime_bootstrap.js";
import { composeSessionPrompts } from "../dist/core/runtime/session_prompt_composer.js";
import {
  buildAutoCompactionContinuationMessage,
  buildSessionCompactionPrompt,
  parseCompactionSummaryResponse,
  prepareAutoCompaction,
  prepareSessionCompaction,
  selectAutoCompactionCut,
} from "../dist/core/session/compaction.js";
import { CoreSession } from "../dist/core/session/core_session.js";
import { ToolCatalog } from "../dist/core/tools/catalog.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { ToolRegistry } from "../dist/core/tools/registry.js";
import {
  TOOL_NAME_BASH,
  TOOL_NAME_EDIT,
  TOOL_NAME_GREP,
  TOOL_NAME_LIST,
  TOOL_NAME_READ,
} from "../dist/core/tools/tool_names.js";
import {
  buildCompactionUserMessage,
  formatHistoryForCompaction,
} from "../dist/core/utils/compact.js";
import {
  buildEnvironmentTag,
  buildProjectContextBlock,
} from "../dist/core/utils/context_builder.js";
import { registerModelRuntimeProvider } from "../dist/core/utils/model_stream.js";
import {
  formatTauUserText,
  getAutoCompactionMetadataFromMessage,
  getCompactionMetadataFromMessage,
  hasAutoCompactionContinuationMetadata,
  prependTauUserMetadata,
  splitTauUserMetadata,
  stripTauUserDisplayText,
  stripTauUserMetadata,
  stripTauUserMetadataFromMessage,
  TAU_USER_METADATA_PREFIX,
} from "../dist/core/utils/user_metadata.js";

describe("core event parser", () => {
  it("strips unknown envelope, event, and nested payload fields", () => {
    expect(
      safeParseCoreEventEnvelope({
        version: 2,
        envelopeExtra: true,
        event: {
          type: "compaction_end",
          reason: "threshold",
          outcome: "compacted",
          eventExtra: true,
          result: {
            summaryHistoryEntryId: "summary-1",
            continuationHistoryEntryId: "continuation-1",
            compactionMessage: "compacted",
            cutType: "turn-boundary",
            retainedMessageCount: 2,
            resultExtra: true,
          },
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        version: 2,
        event: {
          type: "compaction_end",
          reason: "threshold",
          outcome: "compacted",
          result: {
            summaryHistoryEntryId: "summary-1",
            continuationHistoryEntryId: "continuation-1",
            compactionMessage: "compacted",
            cutType: "turn-boundary",
            retainedMessageCount: 2,
          },
        },
      },
    });
  });

  it("parses tool recovery events", () => {
    const message = {
      role: "user",
      content: [{ type: "text", text: "<system>recovery</system>\n" }],
      timestamp: 2,
    };
    const toolResult = {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "bash",
      content: [{ type: "text", text: "done" }],
      isError: false,
      timestamp: 1,
    };

    expect(
      safeParseCoreEventEnvelope({
        version: 2,
        event: {
          type: "tool_recovery",
          historyEntryId: "recovery-1",
          message,
          toolResults: [toolResult],
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        version: 2,
        event: {
          type: "tool_recovery",
          historyEntryId: "recovery-1",
          message,
          toolResults: [toolResult],
        },
      },
    });
  });
});

describe("command registry", () => {
  it("parses and dispatches commands", async () => {
    const registry = createCommandRegistry();
    const calls = [];

    const ctx = {
      help: () => calls.push({ type: "help" }),
      copyText: async () => calls.push({ type: "copyText" }),
      copyCode: async () => calls.push({ type: "copyCode" }),
      newSession: () => calls.push({ type: "new" }),
      rewind: () => calls.push({ type: "rewind" }),
      diff: (argsText) => calls.push({ type: "diff", argsText }),
      compactSummaryOnly: async () => calls.push({ type: "compactSummaryOnly" }),
      compactSummaryAndLast: async () => calls.push({ type: "compactSummaryAndLast" }),
      pruneEarliest: () => calls.push({ type: "pruneEarliest" }),
      pruneLargest: () => calls.push({ type: "pruneLargest" }),
      pruneSmart: () => calls.push({ type: "pruneSmart" }),
      reload: async () => calls.push({ type: "reload" }),
      listen: () => calls.push({ type: "listen" }),
      speak: () => calls.push({ type: "speak" }),
      persona: (id) => calls.push({ type: "persona", id }),
      prompt: (id) => calls.push({ type: "prompt", id }),
      theme: (id) => calls.push({ type: "theme", id }),
      unknown: (raw) => calls.push({ type: "unknown", raw }),
    };

    const rewind = registry.parse("/rewind");
    expect(rewind).toEqual({ type: "rewind" });
    await registry.dispatch(rewind, ctx);

    const copyText = registry.parse("/copy:text");
    expect(copyText).toEqual({ type: "copyText" });
    await registry.dispatch(copyText, ctx);

    const compactSummaryOnly = registry.parse("/compact:summary-only");
    expect(compactSummaryOnly).toEqual({ type: "compactSummaryOnly" });
    await registry.dispatch(compactSummaryOnly, ctx);

    const diff = registry.parse('/diff --staged -- "src/file.ts"');
    expect(diff).toEqual({
      type: "diff",
      argsText: '--staged -- "src/file.ts"',
      extra: '--staged -- "src/file.ts"',
    });
    await registry.dispatch(diff, ctx);

    const pruneSmart = registry.parse("/prune:smart");
    expect(pruneSmart).toEqual({ type: "pruneSmart" });
    await registry.dispatch(pruneSmart, ctx);

    const listen = registry.parse("/listen");
    expect(listen).toEqual({ type: "listen" });
    expect(registry.allowsDuringStreaming(listen)).toBe(true);
    await registry.dispatch(listen, ctx);

    const speak = registry.parse("/speak");
    expect(speak).toEqual({ type: "speak" });
    await registry.dispatch(speak, ctx);

    const unknown = registry.parse("/not-a-command");
    await registry.dispatch(unknown, ctx);

    expect(calls).toContainEqual({ type: "rewind" });
    expect(calls).toContainEqual({ type: "copyText" });
    expect(calls).toContainEqual({ type: "compactSummaryOnly" });
    expect(calls).toContainEqual({ type: "diff", argsText: '--staged -- "src/file.ts"' });
    expect(calls).toContainEqual({ type: "pruneSmart" });
    expect(calls).toContainEqual({ type: "listen" });
    expect(calls).toContainEqual({ type: "speak" });
    expect(calls).toContainEqual({ type: "unknown", raw: "/not-a-command" });
  });
});

describe("tool enablement", () => {
  it("exposes a stable tool list", () => {
    const backend = createLocalToolExecutionBackend();
    const registry = ToolCatalog.createRegistry(backend);

    const allTools = registry.schemas.map((tool) => tool.name).sort();
    const enabled = registry
      .getEnabledToolSchemas()
      .map((tool) => tool.name)
      .sort();

    expect(allTools).not.toContain(TOOL_NAME_READ);
    expect(allTools).not.toContain(TOOL_NAME_GREP);
    expect(allTools).not.toContain(TOOL_NAME_LIST);
    expect(enabled).toEqual(allTools);
  });

  it("fails fast when a persona references an unregistered tool", () => {
    const backend = createLocalToolExecutionBackend();
    const registry = ToolCatalog.createRegistry(backend);

    expect(() => registry.getEnabledToolSchemas([TOOL_NAME_READ])).toThrow(
      "tool 'read' is not registered",
    );
  });
});

describe("core session rewind APIs", () => {
  it("lists user rewind candidates and rewinds by history index", () => {
    const backend = createLocalToolExecutionBackend();
    const toolRegistry = ToolCatalog.createRegistry(backend);
    const session = new CoreSession({
      persona: personas[0],
      systemPrompt: "system",
      subagentPrompts: {},
      toolRegistry,
    });

    session.addUserText(
      "<system>notice one</system>\n<system>notice two</system>\nfirst line\nsecond line",
    );
    session.addMessage({
      role: "assistant",
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      stopReason: "stop",
      timestamp: 1,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      content: [{ type: "text", text: "ok" }],
    });
    session.addUserText("third line");

    const candidates = session.listRewindCandidates();
    expect(candidates.map((candidate) => candidate.text)).toEqual([
      "first line\nsecond line",
      "third line",
    ]);

    const secondCandidate = candidates[1];
    expect(secondCandidate).toBeDefined();
    const rewound = session.rewindToHistoryEntryId(secondCandidate.historyEntryId);
    expect(rewound).toEqual({
      historyEntryId: secondCandidate.historyEntryId,
      text: "third line",
      removedEntryIds: [secondCandidate.historyEntryId],
    });

    const remaining = session.history;
    expect(remaining).toHaveLength(2);
    expect(remaining[0]?.role).toBe("user");
    expect(remaining[1]?.role).toBe("assistant");

    expect(session.rewindToHistoryEntryId("missing-id")).toBeUndefined();
  });

  it("keeps tau metadata in raw history and strips it from visible history", () => {
    const backend = createLocalToolExecutionBackend();
    const toolRegistry = ToolCatalog.createRegistry(backend);
    const session = new CoreSession({
      persona: personas[0],
      systemPrompt: "system",
      subagentPrompts: {},
      toolRegistry,
    });
    const text = prependTauUserMetadata("visible summary", [
      {
        type: "compaction",
        version: 1,
        summary: "summary",
        preservedUserMessages: [],
      },
    ]);

    session.addMessage({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 0,
    });
    const continuationId = session.addMessage(
      buildAutoCompactionContinuationMessage({ cutType: "turn-boundary", now: 1 }),
    );

    expect(session.rawHistory).toHaveLength(2);
    expect(session.rawHistory[0].content[0].text.startsWith(TAU_USER_METADATA_PREFIX)).toBe(true);
    expect(session.history).toHaveLength(1);
    expect(session.history[0].content[0].text).toBe("visible summary");
    expect(session.historyEntries).toHaveLength(1);
    expect(session.historyEntries[0].message.content[0].text).toBe("visible summary");
    expect(session.listRewindCandidates()[0].text).toBe("visible summary");
    expect(session.rewindToHistoryEntryId(continuationId)).toBeUndefined();
    expect(session.rawHistory).toHaveLength(2);
  });

  it("returns cloned public history snapshots", () => {
    const backend = createLocalToolExecutionBackend();
    const toolRegistry = ToolCatalog.createRegistry(backend);
    const session = new CoreSession({
      persona: personas[0],
      systemPrompt: "system",
      subagentPrompts: {},
      toolRegistry,
    });

    session.addUserText("original");

    session.history[0].content[0].text = "mutated history";
    session.rawHistory[0].content[0].text = "mutated raw history";
    session.historyEntries[0].message.content[0].text = "mutated entry";
    session.rawHistoryEntries[0].message.content[0].text = "mutated raw entry";

    expect(session.history[0].content[0].text).toBe("original");
    expect(session.rawHistory[0].content[0].text).toBe("original");
    expect(session.historyEntries[0].message.content[0].text).toBe("original");
    expect(session.rawHistoryEntries[0].message.content[0].text).toBe("original");
  });

  it("does not require nook in restricted registries when nook is configured", async () => {
    const faux = fauxProvider({
      provider: "faux-restricted-nook",
      models: [{ id: "faux-restricted-nook-model" }],
    });
    const unregisterFauxProvider = registerModelRuntimeProvider(faux.provider);

    try {
      faux.setResponses([fauxAssistantMessage("done")]);
      const persona = {
        id: "faux-restricted-nook",
        label: "faux restricted nook",
        model: faux.getModel(),
        systemPrompt: "system",
        settings: { reasoning: "none" },
        skills: "*",
        source: "builtin",
      };
      const session = new CoreSession({
        persona,
        systemPrompt: "system",
        subagentPrompts: {},
        toolRegistry: new ToolRegistry([]),
        config: { nook: { domain: "nook.example.com" } },
      });

      session.addUserText("hello");
      const events = [];
      for await (const event of session.events(new AbortController().signal)) {
        events.push(event);
      }

      expect(events).toContainEqual(expect.objectContaining({ type: "assistant_final" }));
    } finally {
      unregisterFauxProvider();
    }
  });

  it("preserves the session id when compacting manually", async () => {
    const faux = fauxProvider({
      provider: "faux-manual-compact-session-id",
      models: [{ id: "faux-manual-compact-session-id-model" }],
    });
    const unregisterFauxProvider = registerModelRuntimeProvider(faux.provider);

    try {
      faux.setResponses([fauxAssistantMessage(compactionSummary("## Goal\nContinue"))]);
      const persona = {
        id: "faux-manual-compact-session-id",
        label: "faux manual compact session id",
        model: faux.getModel(),
        systemPrompt: "system",
        settings: { reasoning: "none" },
        skills: "*",
        source: "builtin",
      };
      const session = new CoreSession({
        persona,
        systemPrompt: "system",
        subagentPrompts: {},
        toolRegistry: new ToolRegistry([]),
      });

      const sessionId = session.sessionId;
      session.addUserText("remember this");
      session.addMessage(fauxAssistantMessage("remembered"));

      await session.compact({ mode: "only-summary" });

      expect(session.sessionId).toBe(sessionId);
    } finally {
      unregisterFauxProvider();
    }
  });

  it("clamps auto-compaction retention to the threshold budget", async () => {
    const faux = fauxProvider({
      provider: "faux-auto-clamp",
      models: [{ id: "faux-auto-clamp-model", contextWindow: 2000 }],
    });
    const unregisterFauxProvider = registerModelRuntimeProvider(faux.provider);

    try {
      faux.setResponses([
        fauxAssistantMessage(
          compactionSummary("## Goal\nKeep current request", ["old-request", "middle-request"]),
        ),
        fauxAssistantMessage("done"),
      ]);
      const persona = {
        id: "faux-auto-clamp",
        label: "faux auto clamp",
        model: faux.getModel(),
        systemPrompt: "system",
        settings: { reasoning: "none" },
        skills: "*",
        source: "builtin",
      };
      const session = new CoreSession({
        persona,
        systemPrompt: "system",
        subagentPrompts: {},
        toolRegistry: new ToolRegistry([]),
        config: {
          autoCompact: {
            enabled: true,
            reserveTokens: 1500,
            keepRecentTokens: 10000,
          },
        },
      });

      session.addUserText("old request", { historyEntryId: "old-request" });
      session.addMessage(assistantMessageWithUsage("old answer", 1000));
      session.addUserText(`middle request ${"x".repeat(6000)}`, {
        historyEntryId: "middle-request",
      });
      session.addMessage(assistantMessageWithUsage("middle answer", 1000));
      session.addUserText("current request", { historyEntryId: "current-request" });
      const sessionId = session.sessionId;

      const events = [];
      for await (const event of session.events(new AbortController().signal)) {
        events.push(event);
      }

      expect(session.sessionId).toBe(sessionId);

      const compactionEnd = events.find(
        (event) => event.type === "compaction_end" && event.outcome === "compacted",
      );
      expect(compactionEnd).toEqual({
        type: "compaction_end",
        reason: "threshold",
        outcome: "compacted",
        result: expect.objectContaining({
          cutType: "turn-boundary",
          retainedMessageCount: 1,
        }),
      });
      expect(compactionEnd.result.compactionMessage).toContain("<preserved-user-messages>");
      expect(compactionEnd.result.compactionMessage).toContain("old request");
      expect(compactionEnd.result.compactionMessage).toContain("middle request");
    } finally {
      unregisterFauxProvider();
    }
  });

  it("starts streamed tool calls early while preserving sequential execution", async () => {
    const firstCall = fauxToolCall("first_tool", {}, { id: "first-call" });
    const secondCall = fauxToolCall("second_tool", {}, { id: "second-call" });
    const toolMessage = fauxAssistantMessage([firstCall, secondCall], {
      stopReason: "toolUse",
    });
    const finalMessage = fauxAssistantMessage("done");
    let releaseFirst;
    const firstRun = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let releaseModel;
    const modelRun = new Promise((resolve) => {
      releaseModel = resolve;
    });
    let markFirstStarted;
    const firstStarted = new Promise((resolve) => {
      markFirstStarted = resolve;
    });
    let markSecondStarted;
    const secondStarted = new Promise((resolve) => {
      markSecondStarted = resolve;
    });
    let secondHasStarted = false;

    const createDefinition = (name, dispatch) => ({
      schema: {
        name,
        description: "test tool",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      dispatch,
    });
    const toolRegistry = new ToolRegistry([
      createDefinition("first_tool", async (toolCall) => {
        markFirstStarted();
        await firstRun;
        return {
          kind: "single",
          toolResult: {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: "first done" }],
            isError: false,
            timestamp: 2,
          },
        };
      }),
      createDefinition("second_tool", async (toolCall) => {
        secondHasStarted = true;
        markSecondStarted();
        return {
          kind: "single",
          toolResult: {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: "second done" }],
            isError: false,
            timestamp: 3,
          },
        };
      }),
    ]);
    const persona = {
      id: "early-tools",
      label: "early tools",
      model: personas[0].model,
      systemPrompt: "system",
      settings: { reasoning: "none" },
      tools: ["first_tool", "second_tool"],
      skills: "*",
      source: "builtin",
    };
    const session = new CoreSession({
      persona,
      systemPrompt: "system",
      subagentPrompts: {},
      toolRegistry,
    });
    const responses = [toolMessage, finalMessage];
    session.engine.modelRuntime.streamModel = () => {
      const response = responses.shift();
      return {
        async *[Symbol.asyncIterator]() {
          if (response === toolMessage) {
            yield { type: "toolcall_start", contentIndex: 0, partial: toolMessage };
            yield { type: "toolcall_start", contentIndex: 1, partial: toolMessage };
            yield {
              type: "toolcall_end",
              contentIndex: 1,
              toolCall: secondCall,
              partial: toolMessage,
            };
            yield {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall: firstCall,
              partial: toolMessage,
            };
            await modelRun;
          }
        },
        async result() {
          return response;
        },
      };
    };

    session.addUserText("use both tools");
    const events = [];
    let markSecondQueued;
    const secondQueued = new Promise((resolve) => {
      markSecondQueued = resolve;
    });
    const turn = (async () => {
      for await (const event of session.events(new AbortController().signal)) {
        events.push(event);
        if (
          event.type === "tool_ui" &&
          event.uiEvent.type === "tool_call_queued" &&
          event.uiEvent.toolCallId === secondCall.id
        ) {
          markSecondQueued();
        }
      }
    })();

    await Promise.all([firstStarted, secondQueued]);
    expect(
      events
        .filter((event) => event.type === "tool_ui" && event.uiEvent.type === "tool_call_queued")
        .map((event) => event.uiEvent.toolCallId),
    ).toEqual([firstCall.id, secondCall.id]);
    expect(secondHasStarted).toBe(false);
    releaseFirst();
    await secondStarted;
    expect(secondHasStarted).toBe(true);
    expect(events.some((event) => event.type === "assistant_final")).toBe(false);

    releaseModel();
    await turn;

    const relevantEvents = events
      .filter((event) => event.type === "assistant_final" || event.type === "tool_result")
      .map((event) =>
        event.type === "tool_result" ? `${event.type}:${event.message.toolCallId}` : event.type,
      );
    expect(relevantEvents).toEqual([
      "assistant_final",
      "tool_result:first-call",
      "tool_result:second-call",
      "assistant_final",
    ]);
  });

  it("continues from hidden tool recovery context after a terminal model error", async () => {
    const toolCall = fauxToolCall("early_tool", { path: "result.txt" }, { id: "early-call" });
    const errorMessage = fauxAssistantMessage([toolCall], {
      stopReason: "error",
      errorMessage: "network error",
    });
    const finalMessage = fauxAssistantMessage("continued");
    let executions = 0;
    const toolRegistry = new ToolRegistry([
      {
        schema: {
          name: "early_tool",
          description: "test tool",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
        dispatch: async (call) => {
          executions += 1;
          return {
            kind: "single",
            toolResult: {
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text: "created result.txt" }],
              isError: false,
              timestamp: 2,
            },
          };
        },
      },
    ]);
    const session = new CoreSession({
      persona: { ...personas[0], tools: ["early_tool"] },
      systemPrompt: "system",
      subagentPrompts: {},
      toolRegistry,
    });
    const responses = [errorMessage, finalMessage];
    const contexts = [];
    session.engine.modelRuntime.streamModel = (_model, context) => {
      contexts.push(context);
      const response = responses.shift();
      return {
        async *[Symbol.asyncIterator]() {
          if (response === errorMessage) {
            yield { type: "toolcall_start", contentIndex: 0, partial: response };
            yield {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall,
              partial: response,
            };
            yield { type: "error", reason: "error", error: response };
          }
        },
        async result() {
          return response;
        },
      };
    };

    session.addUserText("create the file");
    const events = [];
    for await (const event of session.events(new AbortController().signal)) {
      events.push(event);
    }

    expect(executions).toBe(1);
    expect(events.filter((event) => event.type === "tool_result")).toEqual([]);
    expect(events.filter((event) => event.type === "assistant_final")).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "notice", severity: "error" }),
        expect.objectContaining({
          type: "tool_recovery",
          toolResults: [expect.objectContaining({ toolCallId: "early-call" })],
        }),
      ]),
    );

    const recoveryMessage = session.rawHistory.find(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some(
          (content) => content.type === "text" && content.text.includes("<tool-execution-records>"),
        ),
    );
    expect(recoveryMessage).toBeDefined();
    const recoveryText = recoveryMessage.content.find((content) => content.type === "text").text;
    expect(stripTauUserDisplayText(recoveryText)).toBe("");
    expect(recoveryText).toContain("created result.txt");
    expect(session.rawHistory.some((message) => message.role === "toolResult")).toBe(false);
    expect(session.history.filter((message) => message.role === "user")).toHaveLength(1);
    expect(session.listRewindCandidates()).toEqual([
      expect.objectContaining({ text: "create the file" }),
    ]);
    expect(contexts).toHaveLength(2);
    expect(
      contexts[1].messages.some(
        (message) => message.role === "assistant" && message.stopReason === "error",
      ),
    ).toBe(false);
    expect(
      contexts[1].messages.some(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some(
            (content) =>
              content.type === "text" && content.text.includes("<tool-execution-records>"),
          ),
      ),
    ).toBe(true);
  });

  it("limits hidden tool recovery to one subturn retry", async () => {
    const firstToolCall = fauxToolCall("early_tool", {}, { id: "first-call" });
    const secondToolCall = fauxToolCall("early_tool", {}, { id: "second-call" });
    const responses = [
      {
        toolCall: firstToolCall,
        message: fauxAssistantMessage([firstToolCall], {
          stopReason: "error",
          errorMessage: "first network error",
        }),
      },
      {
        toolCall: secondToolCall,
        message: fauxAssistantMessage([secondToolCall], {
          stopReason: "error",
          errorMessage: "second network error",
        }),
      },
    ];
    let executions = 0;
    const toolRegistry = new ToolRegistry([
      {
        schema: {
          name: "early_tool",
          description: "test tool",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
        dispatch: async (call) => {
          executions += 1;
          return {
            kind: "single",
            toolResult: {
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text: `completed ${call.id}` }],
              isError: false,
              timestamp: executions,
            },
          };
        },
      },
    ]);
    const session = new CoreSession({
      persona: { ...personas[0], tools: ["early_tool"] },
      systemPrompt: "system",
      subagentPrompts: {},
      toolRegistry,
    });
    let modelCalls = 0;
    session.engine.modelRuntime.streamModel = () => {
      const response = responses[modelCalls];
      modelCalls += 1;
      if (!response) {
        throw new Error("unexpected extra recovery subturn");
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "toolcall_start", contentIndex: 0, partial: response.message };
          yield {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: response.toolCall,
            partial: response.message,
          };
          yield { type: "error", reason: "error", error: response.message };
        },
        async result() {
          return response.message;
        },
      };
    };

    session.addUserText("use a tool");
    const events = [];
    for await (const event of session.events(new AbortController().signal)) {
      events.push(event);
    }

    expect(modelCalls).toBe(2);
    expect(executions).toBe(2);
    expect(events.filter((event) => event.type === "assistant_final")).toHaveLength(2);
    expect(events.filter((event) => event.type === "tool_recovery")).toHaveLength(2);
    const recoveryMessages = session.rawHistory.filter(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some(
          (content) => content.type === "text" && content.text.includes("<tool-execution-records>"),
        ),
    );
    expect(recoveryMessages).toHaveLength(2);
    expect(recoveryMessages[0].content[0].text).toContain(
      "Continue the original request using these execution results",
    );
    expect(recoveryMessages[1].content[0].text).toContain(
      "Do not continue the interrupted request unless the user asks",
    );
  });

  it("records streamed tool recovery when a turn is interrupted", async () => {
    const toolCall = fauxToolCall("early_tool", {}, { id: "early-call" });
    const abortedMessage = fauxAssistantMessage([toolCall], {
      stopReason: "aborted",
      errorMessage: "Request was aborted",
    });
    let executions = 0;
    const toolRegistry = new ToolRegistry([
      {
        schema: {
          name: "early_tool",
          description: "test tool",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
        dispatch: async (call, signal) => {
          executions += 1;
          if (!signal.aborted) {
            await new Promise((resolve) =>
              signal.addEventListener("abort", resolve, { once: true }),
            );
          }
          return {
            kind: "single",
            toolResult: {
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text: "cancelled after starting" }],
              isError: true,
              timestamp: 2,
            },
          };
        },
      },
    ]);
    const session = new CoreSession({
      persona: { ...personas[0], tools: ["early_tool"] },
      systemPrompt: "system",
      subagentPrompts: {},
      toolRegistry,
    });
    session.engine.modelRuntime.streamModel = (_model, _context, options) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "toolcall_start", contentIndex: 0, partial: abortedMessage };
        yield {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall,
          partial: abortedMessage,
        };
        if (!options.signal.aborted) {
          await new Promise((resolve) =>
            options.signal.addEventListener("abort", resolve, { once: true }),
          );
        }
        yield { type: "error", reason: "aborted", error: abortedMessage };
      },
      async result() {
        return abortedMessage;
      },
    });

    session.addUserText("use a tool");
    const events = [];
    const runtime = new ConversationTurnRuntime(session);
    const result = await runtime.run({
      onEvent(event) {
        events.push(event);
        if (event.type === "tool_ui" && event.uiEvent.type === "tool_call_queued") {
          runtime.interrupt();
        }
      },
    });

    expect(result).toEqual({ aborted: true });
    expect(executions).toBe(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "assistant_final",
          message: expect.objectContaining({ stopReason: "aborted" }),
        }),
        expect.objectContaining({
          type: "tool_recovery",
          toolResults: [expect.objectContaining({ toolCallId: "early-call" })],
        }),
      ]),
    );
    expect(events.some((event) => event.type === "tool_result")).toBe(false);
    const recoveryMessage = session.rawHistory.find(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some(
          (content) => content.type === "text" && content.text.includes("<tool-execution-records>"),
        ),
    );
    expect(recoveryMessage).toBeDefined();
    expect(recoveryMessage.content[0].text).toContain(
      "Do not continue the interrupted request unless the user asks",
    );
  });

  it("aborts an early tool when the model stream fails", async () => {
    const toolCall = fauxToolCall("early_tool", {}, { id: "early-call" });
    const toolMessage = fauxAssistantMessage([toolCall], { stopReason: "toolUse" });
    let markToolStarted;
    const toolStarted = new Promise((resolve) => {
      markToolStarted = resolve;
    });
    let toolAborted = false;
    const toolRegistry = new ToolRegistry([
      {
        schema: {
          name: "early_tool",
          description: "test tool",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
        dispatch: async (call, signal) => {
          markToolStarted();
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          toolAborted = true;
          return {
            kind: "single",
            toolResult: {
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text: "cancelled" }],
              isError: true,
              timestamp: 2,
            },
          };
        },
      },
    ]);
    const session = new CoreSession({
      persona: { ...personas[0], tools: ["early_tool"] },
      systemPrompt: "system",
      subagentPrompts: {},
      toolRegistry,
    });
    session.engine.modelRuntime.streamModel = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "toolcall_start", contentIndex: 0, partial: toolMessage };
        yield {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall,
          partial: toolMessage,
        };
        await toolStarted;
        throw new Error("model stream failed");
      },
      async result() {
        throw new Error("model stream failed");
      },
    });

    session.addUserText("use a tool");
    const turn = async () => {
      for await (const _event of session.events(new AbortController().signal)) {
      }
    };

    await expect(turn()).rejects.toThrow("model stream failed");
    expect(toolAborted).toBe(true);
  });

  it("keeps reasoning frozen across all subturns in an agent turn", async () => {
    const requestedReasoning = [];
    const toolContextReasoning = [];
    let session;
    const toolRegistry = new ToolRegistry([
      {
        schema: {
          name: "fake_tool",
          description: "test tool",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
        async dispatch(_toolCall, _signal, context) {
          toolContextReasoning.push(context.persona.settings.reasoning);
          session.setReasoning("high");
          return {
            kind: "single",
            toolResult: {
              role: "toolResult",
              toolCallId: "fake-call",
              toolName: "fake_tool",
              content: [{ type: "text", text: "ok" }],
              isError: false,
              timestamp: 2,
            },
          };
        },
      },
    ]);
    const persona = {
      id: "frozen-reasoning",
      label: "frozen reasoning",
      model: personas[0].model,
      systemPrompt: "system",
      settings: { reasoning: "low" },
      tools: ["fake_tool"],
      skills: "*",
      source: "builtin",
    };
    session = new CoreSession({
      persona,
      systemPrompt: "system",
      subagentPrompts: {},
      toolRegistry,
    });
    const responses = [
      fauxAssistantMessage([fauxToolCall("fake_tool", {}, { id: "fake-call" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ];
    session.engine.modelRuntime.streamModel = (_model, _context, options) => {
      requestedReasoning.push(options.reasoning);
      const response = responses.shift();
      return {
        async *[Symbol.asyncIterator]() {
          for (const [contentIndex, content] of response.content.entries()) {
            if (content.type === "toolCall") {
              yield { type: "toolcall_start", contentIndex, partial: response };
              yield { type: "toolcall_end", contentIndex, toolCall: content, partial: response };
            }
          }
        },
        async result() {
          return response;
        },
      };
    };

    session.addUserText("use a tool");
    for await (const _event of session.events(new AbortController().signal)) {
    }

    expect(requestedReasoning).toEqual(["low", "low"]);
    expect(toolContextReasoning).toEqual(["low"]);

    session.addUserText("next turn");
    responses.push(fauxAssistantMessage("next done"));
    for await (const _event of session.events(new AbortController().signal)) {
    }

    expect(requestedReasoning).toEqual(["low", "low", "high"]);
  });

  it("keeps tool dispatch origin tied to the submitted user after auto-compaction", async () => {
    const faux = fauxProvider({
      provider: "faux-auto-origin",
      models: [{ id: "faux-auto-origin-model", contextWindow: 2000 }],
    });
    const unregisterFauxProvider = registerModelRuntimeProvider(faux.provider);

    try {
      faux.setResponses([
        fauxAssistantMessage(compactionSummary("## Goal\nPreserve the request", ["old-request"])),
        fauxAssistantMessage([fauxToolCall("fake_tool", {}, { id: "fake-call" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ]);

      let receivedOriginHistoryEntryId;
      const toolRegistry = new ToolRegistry([
        {
          schema: {
            name: "fake_tool",
            description: "test tool",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
          async dispatch(toolCall, _signal, context) {
            receivedOriginHistoryEntryId = context.originHistoryEntryId;
            return {
              kind: "single",
              toolResult: {
                role: "toolResult",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: [{ type: "text", text: "ok" }],
                isError: false,
                timestamp: 2,
              },
            };
          },
        },
      ]);
      const persona = {
        id: "faux-auto-origin",
        label: "faux auto origin",
        model: faux.getModel(),
        systemPrompt: "system",
        settings: { reasoning: "none" },
        skills: "*",
        source: "builtin",
      };
      const session = new CoreSession({
        persona,
        systemPrompt: "system",
        subagentPrompts: {},
        toolRegistry,
        config: {
          autoCompact: {
            enabled: true,
            reserveTokens: 500,
            keepRecentTokens: 1000,
          },
        },
      });

      session.addUserText(`old request ${"x".repeat(10000)}`, { historyEntryId: "old-request" });
      session.addMessage(assistantMessageWithUsage("old answer", 1600));
      const submittedUserHistoryEntryId = session.addUserText("current request", {
        historyEntryId: "current-request",
      });

      const events = [];
      for await (const event of session.events(new AbortController().signal)) {
        events.push(event);
      }

      expect(events).toContainEqual({
        type: "compaction_end",
        reason: "threshold",
        outcome: "compacted",
        result: expect.objectContaining({ cutType: "turn-boundary" }),
      });
      expect(receivedOriginHistoryEntryId).toBe(submittedUserHistoryEntryId);
    } finally {
      unregisterFauxProvider();
    }
  });
});

describe("core session model notices", () => {
  function getUserText(session, index) {
    const message = session.history[index];
    if (message?.role !== "user") {
      return "";
    }

    const textBlock = message.content.find((block) => block.type === "text");
    return textBlock?.text ?? "";
  }

  it("prepends configured model notice to user messages", () => {
    const backend = createLocalToolExecutionBackend();
    const toolRegistry = ToolCatalog.createRegistry(backend);
    const persona = personas.find((entry) => entry.model.provider === "openai");
    expect(persona).toBeDefined();

    const session = new CoreSession({
      persona,
      systemPrompt: "system",
      subagentPrompts: {},
      toolRegistry,
      config: {
        modelSystemNotices: {
          [`${persona.model.provider}/${persona.model.id}`]: "always use tau tools",
        },
      },
    });

    session.addUserText("hello");

    expect(getUserText(session, 0)).toBe("<system>always use tau tools</system>\nhello");
    expect(session.listRewindCandidates().map((candidate) => candidate.text)).toEqual(["hello"]);
  });

  it("switches notice based on current persona model", () => {
    const backend = createLocalToolExecutionBackend();
    const toolRegistry = ToolCatalog.createRegistry(backend);
    const openaiPersona = personas.find((entry) => entry.model.provider === "openai");
    const anthropicPersona = personas.find((entry) => entry.model.provider === "anthropic");
    expect(openaiPersona).toBeDefined();
    expect(anthropicPersona).toBeDefined();

    const session = new CoreSession({
      persona: openaiPersona,
      systemPrompt: "system",
      subagentPrompts: {},
      toolRegistry,
      config: {
        modelSystemNotices: {
          [`${openaiPersona.model.provider}/${openaiPersona.model.id}`]: "openai notice",
          [`${anthropicPersona.model.provider}/${anthropicPersona.model.id}`]: "anthropic notice",
        },
      },
    });

    session.addUserText("message one");
    session.setPersona(anthropicPersona, "system two", {});
    session.addUserText("message two");

    expect(getUserText(session, 0)).toBe("<system>openai notice</system>\nmessage one");
    expect(getUserText(session, 1)).toBe("<system>anthropic notice</system>\nmessage two");
  });
});

describe("context builder", () => {
  it("renders environment and project context blocks", () => {
    const tag = buildEnvironmentTag({
      datetime: "2025-01-01T00:00:00.000Z",
      cwd: "/repo",
      repoRoot: "/repo",
      platform: "darwin",
      nodeVersion: "v20.0.0",
    });

    expect(tag).toContain("<platform>darwin</platform>");
    expect(tag).toContain("<node>v20.0.0</node>");
    expect(tag).toContain("<repo-root>/repo</repo-root>");

    const readFile = (path) => (path === "/repo/AGENTS.md" ? "# Agents\n" : "");
    const block = buildProjectContextBlock({
      cwd: "/repo",
      home: "/home",
      agentsFiles: ["/repo/AGENTS.md"],
      readFile,
    });

    expect(block).toContain('<file path="/repo/AGENTS.md">');
    expect(block).toContain("# Agents");
  });

  it("renders nested AGENTS.md paths without duplicating injected files", () => {
    const block = buildProjectContextBlock({
      cwd: "/repo",
      home: "/home",
      agentsFiles: ["/repo/AGENTS.md", "/repo/packages/full/AGENTS.md"],
      childAgentsFiles: ["/repo/packages/full/AGENTS.md", "/repo/packages/path-only/AGENTS.md"],
      readFile: (path) => {
        if (path === "/repo/AGENTS.md") return "# Root\n";
        if (path === "/repo/packages/full/AGENTS.md") return "# Full\n";
        return "";
      },
    });

    expect(block).toContain('<file path="/repo/AGENTS.md">');
    expect(block).toContain('<file path="/repo/packages/full/AGENTS.md">');
    expect(block).toContain("Nested AGENTS.md files under the current working directory");
    expect(block).toContain('<file path="/repo/packages/path-only/AGENTS.md" />');
    expect(block).not.toContain('<file path="/repo/packages/full/AGENTS.md" />');
  });
});

describe("runtime prompt bootstrap", () => {
  it("keeps ancestor AGENTS files when resolving prompt context through a command", async () => {
    const persona = {
      id: "test-persona",
      label: "test persona",
      model: personas[0].model,
      systemPrompt: "test prompt",
      settings: {},
      source: "project",
      skills: "*",
    };

    const resolved = await resolveRuntimePromptBootstrap({
      persona,
      discoveredSkills: [],
      cwd: "/workspace/repo",
      home: "/workspace",
      includeAgentContext: true,
      agentContextFiles: [],
      backend: {
        async runNodeScript(_script, args) {
          expect(args[0]).toBe("/workspace/repo");
          return {
            output: JSON.stringify({
              platform: "linux",
              nodeVersion: "v24.0.0",
              repoRoot: "/workspace/repo",
              agentsFiles: [
                { path: "/workspace/repo/AGENTS.md", content: "repo instructions" },
                { path: "/workspace/AGENTS.md", content: "workspace instructions" },
              ],
              childAgentsFiles: ["/workspace/repo/src/AGENTS.md"],
            }),
            exitCode: 0,
          };
        },
      },
    });

    expect(resolved.agentsFiles).toEqual(["/workspace/repo/AGENTS.md", "/workspace/AGENTS.md"]);
    expect(resolved.promptContext.projectContextBlock).toContain("repo instructions");
    expect(resolved.promptContext.projectContextBlock).toContain("workspace instructions");
    expect(resolved.promptContext.projectContextBlock).toContain("/workspace/repo/src/AGENTS.md");
  });

  it("rejects hosted AGENTS symlinks that escape the execution home", async () => {
    const root = mkdtempSync(join(tmpdir(), "tau-hosted-agents-symlink-"));
    const home = join(root, "home");
    const repo = join(home, "repo");
    const outside = join(root, "outside");
    mkdirSync(repo, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "AGENTS.md"), "outside instructions", "utf-8");
    symlinkSync(join(outside, "AGENTS.md"), join(repo, "AGENTS.md"));

    try {
      const resolved = await resolveRuntimePromptBootstrap({
        persona: personas[0],
        discoveredSkills: [],
        cwd: repo,
        home,
        includeAgentContext: true,
        agentContextFiles: [],
        backend: createLocalToolExecutionBackend(),
      });

      expect(resolved.agentsFiles).toEqual([]);
      expect(resolved.promptContext.projectContextBlock).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("session prompt composer", () => {
  it("composes main and subagent prompts", () => {
    const persona = {
      id: "test-persona",
      label: "test persona",
      description: "test",
      model: personas[0].model,
      systemPrompt: "main system prompt",
      settings: {},
      source: "project",
      subagents: {
        default: {},
        researcher: {
          systemPrompt: "research subagent prompt",
          description: "deep research helper",
          launchModels: ["openai/gpt-5.4:high"],
        },
      },
    };

    const result = composeSessionPrompts({
      persona,
      skillsBlock: "### Skills\n\n- skill-a",
      projectContextBlock: '### Project context\n\n<file path="/repo/AGENTS.md">ctx</file>',
      cwd: "/repo",
      datetime: "2026-01-01T00:00:00.000Z",
      platform: "darwin",
      nodeVersion: "v24.0.0",
    });

    expect(result.baseSystemPrompt).toContain("main system prompt");
    expect(result.baseSystemPrompt).toContain("### Skills");
    expect(result.baseSystemPrompt).toContain("### Project context");
    expect(result.baseSystemPrompt).toContain("### Available sub-agents");
    expect(result.baseSystemPrompt).toContain("`researcher`");
    expect(result.baseSystemPrompt).toContain("Launch model overrides");
    expect(result.baseSystemPrompt).toContain("openai/gpt-5.4:high");
    expect(result.baseSystemPrompt).toContain(
      "By default, launch the subagent without a model override unless the user explicitly asks to use a specific model.",
    );

    expect(result.subagentPrompts.default).toContain("<inherited-instructions>");
    expect(result.subagentPrompts.default).toContain("main system prompt");
    expect(result.subagentPrompts.default).not.toContain("{{inherited_instructions}}");
    expect(result.subagentPrompts.default).toContain(
      "You are a subagent supporting the main agent.",
    );
    expect(result.subagentPrompts.researcher).toContain("research subagent prompt");
  });

  it("includes repo root in the environment tag when inside a git repo", () => {
    const gitRootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    expect(gitRootResult.status).toBe(0);
    const gitRoot = (gitRootResult.stdout ?? "").trim();
    expect(gitRoot).not.toBe("");

    const persona = {
      id: "plain-persona",
      label: "plain persona",
      model: personas[0].model,
      systemPrompt: "plain prompt",
      settings: {},
      source: "project",
    };

    const cwd = resolve(gitRoot, "src", "core");

    const result = composeSessionPrompts({
      persona,
      cwd,
      repoRoot: gitRoot,
      datetime: "2026-01-01T00:00:00.000Z",
      platform: "darwin",
      nodeVersion: "v24.0.0",
    });

    expect(result.environmentTag).toContain(`<repo-root>${gitRoot}</repo-root>`);
  });

  it("omits subagent prompts when not applicable", () => {
    const persona = {
      id: "plain-persona",
      label: "plain persona",
      model: personas[0].model,
      systemPrompt: "plain prompt",
      settings: {},
      source: "project",
    };

    const result = composeSessionPrompts({
      persona,
      cwd: "/repo",
      datetime: "2026-01-01T00:00:00.000Z",
      platform: "darwin",
      nodeVersion: "v24.0.0",
    });

    expect(result.baseSystemPrompt).toContain("plain prompt");
    expect(result.subagentPrompts).toEqual({});
  });
});

describe("summary formatting", () => {
  it("omits thinking, uses marker-newline format, and compacts edit calls", () => {
    const history = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 0,
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "hi" },
          {
            type: "toolCall",
            id: "1",
            name: TOOL_NAME_READ,
            arguments: { path: "README.md" },
          },
          {
            type: "toolCall",
            id: "2",
            name: TOOL_NAME_EDIT,
            arguments: {
              path: "src/parser.ts",
              oldText: "const stable = 0;\nconst before = 1;\nreturn stable;",
              newText: "const stable = 0;\nconst after = 2;\nreturn stable;",
            },
          },
        ],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "1",
        toolName: TOOL_NAME_READ,
        content: [{ type: "text", text: "output" }],
        isError: false,
        timestamp: 2,
      },
    ];

    const summary = formatHistoryForCompaction(history);

    expect(summary).toContain("[User]:\nhello");
    expect(summary).toContain("[Assistant]:\nhi");
    expect(summary).toContain(`[Assistant tool calls]:\n${TOOL_NAME_READ}(path="README.md")`);
    expect(summary).toContain(`${TOOL_NAME_EDIT}(path="src/parser.ts")`);
    expect(summary).toContain("const stable = 0;");
    expect(summary).toContain("- const before = 1;");
    expect(summary).toContain("+ const after = 2;");
    expect(summary).toContain("return stable;");
    expect(summary).toContain(`[Tool result]: ${TOOL_NAME_READ} (ok)\noutput`);
    expect(summary).not.toContain("hmm");
    expect(summary).not.toContain('oldText="const before = 1;"');
    expect(summary).not.toContain('newText="const after = 2;"');
  });

  it("includes the session system prompt when provided", () => {
    const history = [userMessage("continue")];

    const summary = formatHistoryForCompaction(history, {
      systemPrompt: "follow AGENTS.md and current instructions",
    });

    expect(summary).toContain("[System prompt]:\nfollow AGENTS.md and current instructions");
    expect(summary).toContain("[User]:\ncontinue");
  });

  it("omits unchanged edit regions only when they are long", () => {
    const unchangedPrefix = Array.from({ length: 12 }, (_, index) => `pre ${index}`);
    const unchangedSuffix = Array.from({ length: 12 }, (_, index) => `post ${index}`);
    const history = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "edit-long",
            name: TOOL_NAME_EDIT,
            arguments: {
              path: "src/example.ts",
              oldText: [...unchangedPrefix, "before", ...unchangedSuffix].join("\n"),
              newText: [...unchangedPrefix, "after", ...unchangedSuffix].join("\n"),
            },
          },
        ],
        timestamp: 0,
      },
    ];

    const summary = formatHistoryForCompaction(history);

    expect(summary).toContain("… 4 unchanged line(s) omitted …");
    expect(summary).toContain("  pre 4");
    expect(summary).not.toContain("  pre 0");
    expect(summary).toContain("  post 7");
    expect(summary).not.toContain("  post 11");
  });

  it("limits unchanged lines between edit hunks to at most 8", () => {
    const middle = Array.from({ length: 14 }, (_, index) => `middle ${index}`);
    const oldText = ["before 1", ...middle, "before 2"].join("\n");
    const newText = ["after 1", ...middle, "after 2"].join("\n");

    const history = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "edit-hunks",
            name: TOOL_NAME_EDIT,
            arguments: {
              path: "src/hunks.ts",
              oldText,
              newText,
            },
          },
        ],
        timestamp: 0,
      },
    ];

    const summary = formatHistoryForCompaction(history);

    expect(summary).toContain("  middle 0");
    expect(summary).toContain("  middle 3");
    expect(summary).toContain("… 6 unchanged line(s) omitted …");
    expect(summary).toContain("  middle 10");
    expect(summary).toContain("  middle 13");
    expect(summary).not.toContain("  middle 4");
    expect(summary).not.toContain("  middle 9");
  });

  it("middle-truncates bash tool results to 4096 tokens", () => {
    const longOutput = "a".repeat(30000);
    const history = [
      {
        role: "toolResult",
        toolCallId: "bash-1",
        toolName: TOOL_NAME_BASH,
        content: [{ type: "text", text: longOutput }],
        isError: false,
        timestamp: 0,
      },
    ];

    const summary = formatHistoryForCompaction(history);

    expect(summary).toContain(`[Tool result]: ${TOOL_NAME_BASH} (ok)`);
    expect(summary).toContain("tokens truncated");
    expect(summary.length).toBeLessThan(longOutput.length);
  });
});

describe("compaction context message", () => {
  it("builds visible compaction summary text", () => {
    const message = buildCompactionUserMessage({
      summary: "## Goal\nShip feature",
      lastAssistantMessage: "Done. Tests passed.",
    });

    expect(message).toContain("<summary>");
    expect(message).toContain("<last-assistant-message-verbatim>");
  });

  it("round-trips tau user metadata", () => {
    const visibleText = buildCompactionUserMessage({ summary: "## Goal\nShip feature" });
    const text = prependTauUserMetadata(visibleText, [
      {
        type: "compaction",
        version: 1,
        summary: "## Goal\nShip feature",
        preservedUserMessages: [{ id: "history-one", text: "ship the feature" }],
      },
    ]);
    const message = {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 0,
    };

    expect(text.startsWith(TAU_USER_METADATA_PREFIX)).toBe(true);
    expect(stripTauUserMetadata(text)).toBe(visibleText);
    expect(stripTauUserDisplayText(text)).toBe(visibleText);
    expect(stripTauUserMetadataFromMessage(message).content[0].text).toBe(visibleText);
    expect(getCompactionMetadataFromMessage(message)).toEqual({
      type: "compaction",
      version: 1,
      summary: "## Goal\nShip feature",
      preservedUserMessages: [{ id: "history-one", text: "ship the feature" }],
    });
  });

  it("strips strict leading hidden system blocks only from display text", () => {
    const text = formatTauUserText({
      text: "\nvisible",
      hiddenSystemMessages: ["notice one", "notice two"],
    });

    expect(stripTauUserMetadata(text)).toBe(
      "<system>notice one</system>\n<system>notice two</system>\n\nvisible",
    );
    expect(stripTauUserDisplayText(text)).toBe("\nvisible");
    expect(stripTauUserDisplayText("<system>notice</system>visible")).toBe(
      "<system>notice</system>visible",
    );
    expect(stripTauUserDisplayText("prefix <system>notice</system>\nvisible")).toBe(
      "prefix <system>notice</system>\nvisible",
    );
  });

  it("fails fast for invalid tau user metadata", () => {
    expect(() =>
      stripTauUserMetadata(`${TAU_USER_METADATA_PREFIX}not-base64\u001evisible`),
    ).toThrow("invalid tau user metadata");

    const encoded = Buffer.from(
      JSON.stringify([{ type: "compaction", version: 2, summary: "summary" }]),
      "utf8",
    ).toString("base64url");
    expect(() =>
      stripTauUserMetadata(`${TAU_USER_METADATA_PREFIX}${encoded}\u001evisible`),
    ).toThrow("invalid tau user metadata: unsupported compaction metadata version");
  });

  it("strips unknown tau user metadata fields", () => {
    const encoded = Buffer.from(
      JSON.stringify([
        {
          type: "compaction",
          version: 1,
          summary: "summary",
          preservedUserMessages: [{ id: "user-1", text: "keep me", extra: true }],
          extra: true,
        },
      ]),
      "utf8",
    ).toString("base64url");

    expect(splitTauUserMetadata(`${TAU_USER_METADATA_PREFIX}${encoded}\u001evisible`)).toEqual({
      metadata: [
        {
          type: "compaction",
          version: 1,
          summary: "summary",
          preservedUserMessages: [{ id: "user-1", text: "keep me" }],
        },
      ],
      visibleText: "visible",
    });
  });

  it("skips hidden auto-continuation messages when preparing manual compaction", () => {
    const continuation = buildAutoCompactionContinuationMessage({
      cutType: "turn-boundary",
      now: 1,
    });
    const history = [continuation, userMessage("new request")];

    const result = prepareSessionCompaction(historyEntries(history), {
      systemPrompt: "project instructions",
    });

    expect(result.messagesToSummarize).toHaveLength(1);
    expect(result.userMessageCandidates).toEqual([
      { id: "entry-1", text: "new request", source: "conversation" },
    ]);
    expect(result.formattedHistory).toContain("[System prompt]:\nproject instructions");
    expect(result.formattedHistory).toContain("new request");
    expect(result.formattedHistory).not.toContain(
      "The conversation context before this point has been compacted",
    );
  });

  it("asks the summarizer to select preserved user message ids", () => {
    const entries = historyEntries([
      userMessage("keep this standing constraint"),
      assistantMessage("done"),
      userMessage("ignore this resolved aside"),
    ]);
    const preparation = prepareSessionCompaction(entries, {
      systemPrompt: "project instructions",
    });

    const prompt = buildSessionCompactionPrompt({ preparation });
    expect(prompt).toContain("<user-message-candidates>");
    expect(prompt).toContain('"id": "entry-0"');
    expect(prompt).toContain('"id": "entry-2"');
    expect(prompt).toContain('[User id="entry-0"]:');
    expect(prompt).toContain('[User id="entry-2"]:');
    expect(prompt).toContain("<preserved-user-message-ids>");

    const parsed = parseCompactionSummaryResponse({
      response: compactionSummary("## Goal\nContinue", ["entry-0"]),
      userMessageCandidates: preparation.userMessageCandidates,
    });

    expect(parsed).toEqual({
      summary: "## Goal\nContinue",
      preservedUserMessages: [{ id: "entry-0", text: "keep this standing constraint" }],
    });
  });

  it("middle-truncates selected preserved user messages by size", () => {
    const first = `first start ${"a".repeat(60000)} first end`;
    const second = `second start ${"b".repeat(120000)} second end`;

    const parsed = parseCompactionSummaryResponse({
      response: compactionSummary("## Goal\nContinue", ["first", "second"]),
      userMessageCandidates: [
        { id: "first", text: first },
        { id: "second", text: second },
      ],
    });

    expect(parsed.preservedUserMessages).toHaveLength(2);
    expect(parsed.preservedUserMessages[0].text).toContain("first start");
    expect(parsed.preservedUserMessages[0].text).toContain("tokens truncated");
    expect(parsed.preservedUserMessages[0].text).toContain("first end");
    expect(parsed.preservedUserMessages[1].text).toContain("second start");
    expect(parsed.preservedUserMessages[1].text).toContain("tokens truncated");
    expect(parsed.preservedUserMessages[1].text).toContain("second end");
    expect(parsed.preservedUserMessages[1].text.length).toBeGreaterThan(
      parsed.preservedUserMessages[0].text.length,
    );
  });

  it("applies model notices to hidden auto-continuation messages", () => {
    const continuation = buildAutoCompactionContinuationMessage({
      cutType: "turn-boundary",
      now: 1,
      modelNotice: "stay concise",
    });

    const text = stripTauUserMetadata(continuation.content[0].text);

    expect(text).toContain("<system>stay concise</system>");
    expect(text).toContain("The conversation context before this point has been compacted");
    expect(hasAutoCompactionContinuationMetadata(continuation)).toBe(true);
  });

  it("uses compaction metadata as previous summary for the next compaction", () => {
    const compactionText = prependTauUserMetadata(
      buildCompactionUserMessage({ summary: "old summary" }),
      [
        {
          type: "compaction",
          version: 1,
          summary: "old summary",
          preservedUserMessages: [{ id: "entry-old", text: "old request" }],
        },
      ],
    );
    const history = [
      {
        role: "user",
        content: [{ type: "text", text: compactionText }],
        timestamp: 0,
      },
      {
        role: "user",
        content: [{ type: "text", text: "new request" }],
        timestamp: 1,
      },
    ];

    const result = prepareSessionCompaction(historyEntries(history), {
      systemPrompt: "project instructions",
    });

    expect(result.previousSummary).toBe("old summary");
    expect(result.messagesToSummarize).toHaveLength(1);
    expect(result.userMessageCandidates).toEqual([
      { id: "entry-old", text: "old request", source: "previous-preserved" },
      { id: "entry-1", text: "new request", source: "conversation" },
    ]);
    expect(result.formattedHistory).toContain("new request");
    expect(result.formattedHistory).not.toContain("old summary");
  });

  it("treats visible compaction text without metadata as ordinary user text", () => {
    const oldVisibleCompactionText = buildCompactionUserMessage({ summary: "old summary" });
    const history = [
      {
        role: "user",
        content: [{ type: "text", text: oldVisibleCompactionText }],
        timestamp: 0,
      },
      {
        role: "user",
        content: [{ type: "text", text: "new request" }],
        timestamp: 1,
      },
    ];

    const result = prepareSessionCompaction(historyEntries(history), {
      systemPrompt: "project instructions",
    });

    expect(result.previousSummary).toBeUndefined();
    expect(result.messagesToSummarize).toHaveLength(2);
    expect(result.userMessageCandidates).toEqual([
      { id: "entry-0", text: oldVisibleCompactionText, source: "conversation" },
      { id: "entry-1", text: "new request", source: "conversation" },
    ]);
    expect(result.formattedHistory).toContain("old summary");
    expect(result.formattedHistory).toContain("new request");
  });

  it("selects auto-compaction user boundaries when the latest turn fits", () => {
    const entries = historyEntries([
      userMessage(`old ${"x".repeat(9000)}`),
      assistantMessage("old answer"),
      userMessage("current request"),
      assistantMessage("current answer"),
    ]);

    const cut = selectAutoCompactionCut(entries, { startIndex: 0, keepRecentTokens: 1000 });

    expect(cut).toEqual({ startIndex: 2, cutType: "turn-boundary" });
  });

  it("splits only inside the oversized latest turn at assistant boundaries", () => {
    const entries = historyEntries([
      userMessage("latest request"),
      assistantMessage("tool call one"),
      toolResultMessage(`large output ${"x".repeat(15000)}`),
      assistantMessage("tool call two"),
      toolResultMessage("small output"),
    ]);

    const cut = selectAutoCompactionCut(entries, { startIndex: 0, keepRecentTokens: 1000 });

    expect(cut).toEqual({ startIndex: 3, cutType: "split-turn" });
    expect(entries[cut.startIndex].message.role).toBe("assistant");
  });

  it("splits at an assistant boundary before an oversized latest tool result", () => {
    const entries = historyEntries([
      userMessage("latest request"),
      assistantMessage("tool call"),
      toolResultMessage(`large output ${"x".repeat(15000)}`),
    ]);

    const cut = selectAutoCompactionCut(entries, { startIndex: 0, keepRecentTokens: 1000 });

    expect(cut).toEqual({ startIndex: 1, cutType: "split-turn" });
  });

  it("keeps an oversized latest user-only turn whole when older history can be compacted", () => {
    const entries = historyEntries([
      userMessage("older request"),
      assistantMessage("older answer"),
      userMessage(`latest request ${"x".repeat(15000)}`),
    ]);

    const cut = selectAutoCompactionCut(entries, { startIndex: 0, keepRecentTokens: 1000 });

    expect(cut).toEqual({ startIndex: 2, cutType: "turn-boundary" });
  });

  it("does not split an oversized latest turn without older history or an assistant boundary", () => {
    const entries = historyEntries([userMessage(`latest request ${"x".repeat(15000)}`)]);

    expect(
      selectAutoCompactionCut(entries, { startIndex: 0, keepRecentTokens: 1000 }),
    ).toBeUndefined();
  });

  it("does not carry hidden auto-continuation messages into repeated auto-compactions", () => {
    const previousSummaryText = prependTauUserMetadata(
      buildCompactionUserMessage({ summary: "old summary" }),
      [
        {
          type: "auto-compaction",
          version: 1,
          summary: "old summary",
          preservedUserMessages: [],
          cutType: "turn-boundary",
          retainedMessageCount: 2,
        },
      ],
    );
    const continuation = buildAutoCompactionContinuationMessage({
      cutType: "turn-boundary",
      now: 2,
    });
    const entries = historyEntries([
      userMessage(previousSummaryText),
      userMessage("current request"),
      continuation,
      assistantMessage("tool call"),
      toolResultMessage(`large output ${"x".repeat(15000)}`),
    ]);

    const preparation = prepareAutoCompaction(entries, {
      keepRecentTokens: 1000,
      systemPrompt: "project instructions",
    });

    expect(preparation.cutType).toBe("split-turn");
    expect(preparation.userMessageCandidates).toEqual([
      { id: "entry-1", text: "current request", source: "conversation" },
    ]);
    expect(preparation.formattedHistory).toContain("current request");
    expect(preparation.formattedHistory).not.toContain(
      "The conversation context before this point has been compacted",
    );
    expect(preparation.retainedEntries.map((entry) => entry.id)).toEqual(["entry-3", "entry-4"]);
    expect(preparation.retainedEntries.some((entry) => entry.message === continuation)).toBe(false);
  });

  it("splits repeated auto-compactions inside an ongoing assistant turn", () => {
    const previousSummaryText = prependTauUserMetadata(
      buildCompactionUserMessage({ summary: "old summary" }),
      [
        {
          type: "auto-compaction",
          version: 1,
          summary: "old summary",
          preservedUserMessages: [],
          cutType: "split-turn",
          retainedMessageCount: 2,
        },
      ],
    );
    const continuation = buildAutoCompactionContinuationMessage({
      cutType: "split-turn",
      now: 2,
    });
    const entries = historyEntries([
      userMessage(previousSummaryText),
      assistantMessage("retained previous tool call"),
      toolResultMessage("small retained output"),
      continuation,
      assistantMessage("next diagnostic tool call"),
      toolResultMessage(`large diagnostic output ${"x".repeat(15000)}`),
      assistantMessage("final small explanation"),
    ]);

    const preparation = prepareAutoCompaction(entries, {
      keepRecentTokens: 1000,
      systemPrompt: "project instructions",
    });

    expect(preparation.cutType).toBe("split-turn");
    expect(preparation.formattedHistory).toContain("retained previous tool call");
    expect(preparation.formattedHistory).toContain("next diagnostic tool call");
    expect(preparation.formattedHistory).not.toContain(
      "The conversation context before this point has been compacted",
    );
    expect(preparation.retainedEntries.map((entry) => entry.id)).toEqual(["entry-6"]);
  });

  it("prepares auto-compaction with auto metadata and hidden continuation messages", () => {
    const previousSummaryText = prependTauUserMetadata(
      buildCompactionUserMessage({ summary: "old summary" }),
      [
        {
          type: "auto-compaction",
          version: 1,
          summary: "old summary",
          preservedUserMessages: [],
          cutType: "turn-boundary",
          retainedMessageCount: 2,
        },
      ],
    );
    const continuation = buildAutoCompactionContinuationMessage({
      cutType: "turn-boundary",
      now: 2,
      subagentStatus: "- agent-1: check tests (name: default, status: running)",
    });
    const entries = historyEntries([
      userMessage(previousSummaryText),
      userMessage("retained old request"),
      continuation,
      userMessage(`new request ${"x".repeat(9000)}`),
      userMessage("current request"),
    ]);

    const preparation = prepareAutoCompaction(entries, {
      keepRecentTokens: 1000,
      systemPrompt: "project instructions",
    });

    expect(preparation.previousSummary).toBe("old summary");
    expect(preparation.userMessageCandidates).toEqual([
      { id: "entry-1", text: "retained old request", source: "conversation" },
      { id: "entry-3", text: `new request ${"x".repeat(9000)}`, source: "conversation" },
    ]);
    expect(preparation.formattedHistory).toContain("retained old request");
    expect(preparation.formattedHistory).toContain("new request");
    expect(preparation.formattedHistory).not.toContain(
      "The conversation context before this point has been compacted",
    );
    expect(preparation.retainedEntries.map((entry) => entry.id)).toEqual(["entry-4"]);
    expect(getAutoCompactionMetadataFromMessage(entries[0].message)).toEqual({
      type: "auto-compaction",
      version: 1,
      summary: "old summary",
      preservedUserMessages: [],
      cutType: "turn-boundary",
      retainedMessageCount: 2,
    });
    expect(stripTauUserMetadata(continuation.content[0].text)).toContain("<active-subagents>");
    expect(stripTauUserMetadata(continuation.content[0].text)).toContain("agent-1");
    expect(hasAutoCompactionContinuationMetadata(continuation)).toBe(true);
  });
});

function compactionSummary(summary, preservedUserMessageIds = []) {
  return `${summary}\n\n<preserved-user-message-ids>\n${JSON.stringify(preservedUserMessageIds)}\n</preserved-user-message-ids>`;
}

function historyEntries(messages) {
  return messages.map((message, index) => ({ id: `entry-${index}`, message }));
}

function userMessage(text) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  };
}

function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 0,
    provider: "test",
    model: "test",
    api: "test",
    stopReason: "stop",
  };
}

function assistantMessageWithUsage(text, totalTokens) {
  return {
    ...assistantMessage(text),
    usage: {
      input: totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function toolResultMessage(text) {
  return {
    role: "toolResult",
    toolCallId: `tool-${text.length}`,
    toolName: TOOL_NAME_BASH,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  };
}
