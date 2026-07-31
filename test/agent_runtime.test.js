import { fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime, createAgentSpec } from "../dist/core/index.js";
import { personas } from "../dist/core/personas.js";
import { ToolRegistry } from "../dist/core/tools/registry.js";

function createPersona(overrides = {}) {
  return {
    ...personas[0],
    id: "runtime-test",
    label: "runtime test",
    systemPrompt: "system",
    settings: { reasoning: "medium" },
    tools: undefined,
    subagents: undefined,
    ...overrides,
  };
}

function createAssistant(persona, content, options = {}) {
  return {
    role: "assistant",
    api: persona.model.api,
    provider: persona.model.provider,
    model: persona.model.id,
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    stopReason: options.stopReason ?? "stop",
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    usage: options.usage ?? {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: options.timestamp ?? Date.now(),
  };
}

function createStream(events, result, error) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
      if (error) throw error;
    },
    async result() {
      if (error) throw error;
      return result;
    },
  };
}

function createTool(name, execute) {
  return {
    schema: {
      name,
      description: `${name} test tool`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    describe: () => ({ headerTarget: name }),
    execute,
  };
}

function createRuntime(options = {}) {
  const persona = options.persona ?? createPersona();
  const tools = new ToolRegistry(options.tools ?? []);
  const events = [];
  const eventSink = options.eventSink ?? (async (event) => events.push(event));
  const autoCompact = options.config?.autoCompact ?? { enabled: false };
  const spec = createAgentSpec({
    model: {
      model: persona.model,
      stream: () => {
        throw new Error("model stream was not configured");
      },
      noteProviderError: async () => {},
      cleanupSession: () => {},
    },
    attribution: {
      personaId: persona.id,
      reasoningEffort: persona.settings.reasoning ?? "none",
    },
    systemPrompt: options.systemPrompt ?? "system",
    tools,
    streamOptions: { reasoning: persona.settings.reasoning },
    compactionPolicy: {
      enabled: autoCompact.enabled ?? true,
      reserveTokens: autoCompact.reserveTokens ?? 16_384,
      keepRecentTokens: autoCompact.keepRecentTokens ?? 20_000,
    },
  });
  if (options.retryPolicy) spec.retryPolicy = options.retryPolicy;
  if (options.maxModelSubturns) spec.maxModelSubturns = options.maxModelSubturns;
  const runtime = new AgentRuntime({
    spec,
    eventSink,
    ...(options.getCompactionContext ? { getCompactionContext: options.getCompactionContext } : {}),
  });
  return { runtime, events, persona, spec };
}

function setStreams(runtime, streams) {
  const streamModel = vi.fn(() => {
    const stream = streams.shift();
    if (!stream) throw new Error("unexpected model call");
    return stream;
  });
  runtime.spec.model.stream = streamModel;
  runtime.spec.model.noteProviderError = vi.fn(async () => {});
  return streamModel;
}

describe("AgentRuntime", () => {
  it("commits user input durably and awaits its sink before model work", async () => {
    let releaseUserEvent;
    const userEventGate = new Promise((resolve) => {
      releaseUserEvent = resolve;
    });
    const events = [];
    const { runtime, persona } = createRuntime({
      eventSink: async (event) => {
        events.push(event);
        if (event.type === "user_message") await userEventGate;
      },
    });
    const streamModel = setStreams(runtime, [createStream([], createAssistant(persona, "done"))]);

    const turn = runtime.submit("hello", { historyEntryId: "user-1" });
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(runtime.state).toMatchObject({
      revision: 1,
      historyEntries: [{ id: "user-1", message: { role: "user" } }],
    });
    expect(streamModel).not.toHaveBeenCalled();

    releaseUserEvent();
    await turn;
    expect(streamModel).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual([
      "user_message",
      "turn_started",
      "assistant_start",
      "assistant_final",
      "usage_checkpoint",
      "turn_finished",
    ]);
  });

  it("retains accepted input when the event sink fails and aborts later delivery", async () => {
    const sinkError = new Error("projection failed");
    const eventSink = vi.fn(async (event) => {
      if (event.type === "assistant_start") throw sinkError;
    });
    const { runtime, persona } = createRuntime({ eventSink });
    const streamModel = setStreams(runtime, [
      createStream([], createAssistant(persona, "must not commit")),
    ]);

    await expect(runtime.submit("persist me")).rejects.toBe(sinkError);

    expect(runtime.status).toBe("idle");
    expect(runtime.rawHistory).toHaveLength(1);
    expect(runtime.rawHistory[0].role).toBe("user");
    expect(streamModel).not.toHaveBeenCalled();
    expect(eventSink.mock.calls.map(([event]) => event.type)).toEqual([
      "user_message",
      "turn_started",
      "assistant_start",
    ]);
  });

  it("emits provisional identities without arguments and discards unfinished calls", async () => {
    const { runtime, persona, events } = createRuntime();
    const oldCall = fauxToolCall("write", { path: "partial-secret" }, { id: "old-call" });
    const newCall = fauxToolCall("bash", { command: "partial-secret" }, { id: "new-call" });
    const oldPartial = createAssistant(persona, [oldCall], { stopReason: "toolUse" });
    const newPartial = createAssistant(persona, [newCall], { stopReason: "toolUse" });
    setStreams(runtime, [
      createStream(
        [
          { type: "toolcall_start", contentIndex: 0, partial: oldPartial },
          { type: "toolcall_delta", contentIndex: 0, delta: "secret", partial: newPartial },
        ],
        undefined,
        new Error("stream failed"),
      ),
    ]);

    await expect(runtime.submit("inspect")).rejects.toThrow("stream failed");

    const provisional = events.filter((event) => event.type === "tool_call_streaming");
    expect(provisional).toEqual([
      expect.objectContaining({
        toolCallId: "old-call",
        toolName: "write",
        contentIndex: 0,
      }),
      expect.objectContaining({
        toolCallId: "new-call",
        toolName: "bash",
        contentIndex: 0,
        replacesToolCallId: "old-call",
      }),
    ]);
    for (const event of provisional) {
      expect(event).not.toHaveProperty("arguments");
      expect(JSON.stringify(event)).not.toContain("partial-secret");
    }
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_call_discarded", toolCallId: "new-call" }),
    );
  });

  it("admits streamed calls immediately, executes sequentially, and commits canonically", async () => {
    const firstCall = fauxToolCall("first_tool", {}, { id: "first-call" });
    const secondCall = fauxToolCall("second_tool", {}, { id: "second-call" });
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted;
    const firstStarted = new Promise((resolve) => {
      markFirstStarted = resolve;
    });
    let markSecondStarted;
    const secondStarted = new Promise((resolve) => {
      markSecondStarted = resolve;
    });
    let releaseModel;
    const modelGate = new Promise((resolve) => {
      releaseModel = resolve;
    });
    const tools = [
      createTool("first_tool", async () => {
        markFirstStarted();
        await firstGate;
        return { content: [{ type: "text", text: "first done" }], outcome: "succeeded" };
      }),
      createTool("second_tool", async () => {
        markSecondStarted();
        return { content: [{ type: "text", text: "second done" }], outcome: "succeeded" };
      }),
    ];
    const { runtime, persona, events } = createRuntime({ tools });
    const toolMessage = createAssistant(persona, [firstCall, secondCall], {
      stopReason: "toolUse",
    });
    setStreams(runtime, [
      {
        async *[Symbol.asyncIterator]() {
          yield { type: "toolcall_start", contentIndex: 0, partial: toolMessage };
          yield {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: firstCall,
            partial: toolMessage,
          };
          yield { type: "toolcall_start", contentIndex: 1, partial: toolMessage };
          yield {
            type: "toolcall_end",
            contentIndex: 1,
            toolCall: secondCall,
            partial: toolMessage,
          };
          await modelGate;
        },
        async result() {
          return toolMessage;
        },
      },
      createStream([], createAssistant(persona, "done")),
    ]);

    const turn = runtime.submit("use both");
    await firstStarted;
    await vi.waitFor(() =>
      expect(
        events
          .filter((event) => event.type === "tool_call_admitted")
          .map((event) => event.toolCall.id),
      ).toEqual(["first-call", "second-call"]),
    );
    expect(events.some((event) => event.type === "assistant_final")).toBe(false);

    releaseFirst();
    await secondStarted;
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === "tool_run_finished")).toHaveLength(2),
    );
    expect(events.some((event) => event.type === "assistant_final")).toBe(false);
    expect(
      events
        .filter(
          (event) =>
            event.type === "tool_call_admitted" ||
            event.type === "tool_run_started" ||
            event.type === "tool_run_finished",
        )
        .map((event) => `${event.type}:${event.toolCall?.id ?? event.toolCallId}`),
    ).toEqual([
      "tool_call_admitted:first-call",
      "tool_run_started:first-call",
      "tool_call_admitted:second-call",
      "tool_run_finished:first-call",
      "tool_run_started:second-call",
      "tool_run_finished:second-call",
    ]);
    releaseModel();
    await turn;

    expect(
      events
        .filter((event) => event.type === "assistant_final" || event.type === "tool_result")
        .map((event) =>
          event.type === "tool_result" ? `tool:${event.message.toolCallId}` : "assistant",
        ),
    ).toEqual(["assistant", "tool:first-call", "tool:second-call", "assistant"]);
    expect(runtime.rawHistory.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "assistant",
    ]);
  });

  it("keeps rejected tool calls semantically blocked through result commit", async () => {
    const { runtime, persona, events } = createRuntime();
    const call = {
      id: "missing-call",
      type: "toolCall",
      name: "missing_tool",
      arguments: {},
    };
    const toolMessage = createAssistant(persona, [call], { stopReason: "toolUse" });
    setStreams(runtime, [
      createStream(
        [
          { type: "toolcall_start", contentIndex: 0, partial: toolMessage },
          { type: "toolcall_end", contentIndex: 0, toolCall: call, partial: toolMessage },
        ],
        toolMessage,
      ),
      createStream([], createAssistant(persona, "continued")),
    ]);

    await runtime.submit("use missing tool");

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_run_blocked",
        toolCallId: call.id,
        toolName: call.name,
      }),
    );
    expect(
      events.some((event) => event.type === "tool_run_finished" && event.toolCallId === call.id),
    ).toBe(false);
    expect(runtime.rawHistory.find((message) => message.role === "toolResult")).toMatchObject({
      toolCallId: call.id,
      isError: true,
    });
  });

  it("applies event-sink backpressure to tool lifecycle and owned activity", async () => {
    let releaseRunStart;
    const runStartGate = new Promise((resolve) => {
      releaseRunStart = resolve;
    });
    let runStartReachedSink = false;
    let releaseActivity;
    const activityGate = new Promise((resolve) => {
      releaseActivity = resolve;
    });
    let activityReachedSink = false;
    let toolStarted = false;
    let toolProgressed = false;
    const events = [];
    const call = fauxToolCall("activity_tool", {}, { id: "activity-call" });
    const tool = createTool("activity_tool", async (_toolCall, context) => {
      toolStarted = true;
      await context.emitActivity({
        type: "tool_call_blocked",
        toolCallId: call.id,
        toolName: call.name,
        headerTarget: call.name,
        reason: "activity",
      });
      toolProgressed = true;
      return { content: [{ type: "text", text: "done" }], outcome: "succeeded" };
    });
    const { runtime, persona } = createRuntime({
      tools: [tool],
      eventSink: async (event) => {
        events.push(event);
        if (event.type === "tool_run_started") {
          runStartReachedSink = true;
          await runStartGate;
        }
        if (event.type === "tool_activity" && event.activity.reason === "activity") {
          activityReachedSink = true;
          await activityGate;
        }
      },
    });
    const toolMessage = createAssistant(persona, [call], { stopReason: "toolUse" });
    setStreams(runtime, [
      createStream(
        [
          { type: "toolcall_start", contentIndex: 0, partial: toolMessage },
          { type: "toolcall_end", contentIndex: 0, toolCall: call, partial: toolMessage },
        ],
        toolMessage,
      ),
      createStream([], createAssistant(persona, "finished")),
    ]);

    const turn = runtime.submit("run activity");
    await vi.waitFor(() => expect(runStartReachedSink).toBe(true));
    expect(toolStarted).toBe(false);
    releaseRunStart();
    await vi.waitFor(() => expect(activityReachedSink).toBe(true));
    expect(toolStarted).toBe(true);
    expect(toolProgressed).toBe(false);
    releaseActivity();
    await turn;
    expect(toolProgressed).toBe(true);
    expect(events.findIndex((event) => event.type === "tool_activity")).toBeLessThan(
      events.findIndex((event) => event.type === "tool_result"),
    );
  });

  it("emits typed retry events and retries only before tool admission", async () => {
    const { runtime, persona, events, spec } = createRuntime();
    spec.retryPolicy.delayMs = 0;
    const retryable = createAssistant(persona, "", {
      stopReason: "error",
      errorMessage: "rate limit exceeded",
    });
    setStreams(runtime, [
      createStream([], retryable),
      createStream([], createAssistant(persona, "recovered")),
    ]);

    await runtime.submit("retry safely");

    expect(events).toContainEqual({ type: "model_retry_scheduled", attempt: 1, delayMs: 0 });
    expect(events).toContainEqual({ type: "model_retry_started", attempt: 1 });
    expect(runtime.rawHistory).toHaveLength(2);
    expect(runtime.rawHistory.at(-1).content[0].text).toBe("recovered");
  });

  it("recovers after admitted tool work without executing the tool twice", async () => {
    const call = fauxToolCall("side_effect", {}, { id: "side-effect-1" });
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "completed" }],
      outcome: "succeeded",
    }));
    const { runtime, persona, events } = createRuntime({
      tools: [createTool("side_effect", execute)],
    });
    const failed = createAssistant(persona, [call], {
      stopReason: "error",
      errorMessage: "connection reset",
    });
    setStreams(runtime, [
      createStream(
        [
          { type: "toolcall_start", contentIndex: 0, partial: failed },
          { type: "toolcall_end", contentIndex: 0, toolCall: call, partial: failed },
        ],
        failed,
      ),
      createStream([], createAssistant(persona, "recovered response")),
    ]);

    await runtime.submit("perform once");

    expect(execute).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === "tool_recovery")).toHaveLength(1);
    expect(events.filter((event) => event.type === "model_retry_scheduled")).toHaveLength(0);
    expect(runtime.rawHistory.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(JSON.stringify(runtime.rawHistory[2])).toContain("completed");
  });

  it("reconciles iterator failures after tool admission without duplicating execution", async () => {
    const call = fauxToolCall("side_effect", {}, { id: "iterator-failure-call" });
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "completed" }],
      outcome: "succeeded",
    }));
    const { runtime, persona, events } = createRuntime({
      tools: [createTool("side_effect", execute)],
    });
    const partial = createAssistant(persona, [call], { stopReason: "toolUse" });
    setStreams(runtime, [
      createStream(
        [
          { type: "toolcall_start", contentIndex: 0, partial },
          { type: "toolcall_end", contentIndex: 0, toolCall: call, partial },
        ],
        undefined,
        new Error("transport disconnected"),
      ),
      createStream([], createAssistant(persona, "recovered response")),
    ]);

    await runtime.submit("perform once");

    expect(execute).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === "tool_recovery")).toHaveLength(1);
    expect(runtime.rawHistory.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(JSON.stringify(runtime.rawHistory[2])).toContain("completed");
  });

  it("blocks a turn when required automatic compaction fails after input commit", async () => {
    const model = { ...personas[0].model, contextWindow: 100 };
    const persona = createPersona({ model });
    const { runtime, events } = createRuntime({
      persona,
      config: {
        autoCompact: { enabled: true, reserveTokens: 10, keepRecentTokens: 20 },
      },
    });
    const first = createAssistant(persona, "first response", {
      usage: {
        input: 89,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 91,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const streamModel = setStreams(runtime, [
      createStream([], first),
      createStream([], undefined, new Error("summary unavailable")),
    ]);

    await runtime.submit("first request");
    const result = await runtime.submit("second request");

    expect(result).toEqual({
      aborted: false,
      blocked: { reason: "auto-compaction-failed", message: "summary unavailable" },
    });
    expect(events).toContainEqual({ type: "compaction_start", reason: "threshold" });
    expect(events).toContainEqual({
      type: "compaction_end",
      reason: "threshold",
      outcome: "failed",
      errorMessage: "summary unavailable",
    });
    expect(runtime.rawHistory.at(-1).content[0].text).toBe("second request");
    expect(streamModel).toHaveBeenCalledTimes(2);
  });

  it("injects dynamic supervisor context into automatic compaction", async () => {
    const model = { ...personas[0].model, contextWindow: 100 };
    const persona = createPersona({ model });
    const { runtime } = createRuntime({
      persona,
      config: {
        autoCompact: { enabled: true, reserveTokens: 10, keepRecentTokens: 20 },
      },
      getCompactionContext: () =>
        "<active-subagents>\n- child-1: running repository scan\n</active-subagents>",
    });
    const first = createAssistant(persona, "first response", {
      usage: {
        input: 89,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 91,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const streamModel = setStreams(runtime, [
      createStream([], first),
      createStream(
        [],
        createAssistant(
          persona,
          "summary\n\n<preserved-user-message-ids>\n[]\n</preserved-user-message-ids>",
        ),
      ),
      createStream([], createAssistant(persona, "after compaction")),
    ]);

    await runtime.submit("first request");
    await runtime.submit("second request");

    expect(JSON.stringify(streamModel.mock.calls[2][0])).toContain(
      "<active-subagents>\\n- child-1: running repository scan\\n</active-subagents>",
    );
  });

  it("inherits stream options and cleans up manual compaction sessions", async () => {
    const { runtime, persona, spec } = createRuntime();
    const modelNotice = "agent-only notice";
    spec.modelNotice = modelNotice;
    spec.streamOptions.temperature = 0.25;
    const streamModel = setStreams(runtime, [
      createStream([], createAssistant(persona, "first response")),
      createStream(
        [],
        createAssistant(
          persona,
          "summary\n\n<preserved-user-message-ids>\n[]\n</preserved-user-message-ids>",
        ),
      ),
    ]);
    const cleanupSession = vi.fn();
    spec.model.cleanupSession = cleanupSession;

    await runtime.submit("first request");
    expect(JSON.stringify(runtime.rawHistory)).toContain(modelNotice);
    await runtime.compact({ mode: "summary-only" });

    expect(JSON.stringify(streamModel.mock.calls[0][0])).toContain(modelNotice);
    expect(JSON.stringify(streamModel.mock.calls[1][0])).toContain(modelNotice);
    expect(streamModel.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        temperature: 0.25,
        reasoning: "high",
        sessionId: expect.stringMatching(/^summary-/),
      }),
    );
    expect(cleanupSession).toHaveBeenCalledWith(streamModel.mock.calls[1][1].sessionId);
  });

  it("does not report compaction failure after a committed success event cannot be delivered", async () => {
    const events = [];
    const { runtime, persona } = createRuntime({
      eventSink: async (event) => {
        events.push(event);
        if (event.type === "compaction_end" && event.outcome === "compacted") {
          throw new Error("sink unavailable");
        }
      },
    });
    setStreams(runtime, [
      createStream([], createAssistant(persona, "first response")),
      createStream(
        [],
        createAssistant(
          persona,
          "summary\n\n<preserved-user-message-ids>\n[]\n</preserved-user-message-ids>",
        ),
      ),
    ]);

    await runtime.submit("first request");
    await expect(runtime.compact({ mode: "summary-only" })).rejects.toThrow("sink unavailable");

    expect(events.filter((event) => event.type === "compaction_end")).toEqual([
      expect.objectContaining({ type: "compaction_end", outcome: "compacted" }),
    ]);
    expect(runtime.rawHistory).toHaveLength(1);
  });

  it("rejects both steering promises when the active event sink fails", async () => {
    let rejectAssistantFinal = false;
    const { runtime, persona } = createRuntime({
      eventSink: async (event) => {
        if (rejectAssistantFinal && event.type === "assistant_final") {
          throw new Error("sink failed");
        }
      },
    });
    let releaseModel;
    const modelGate = new Promise((resolve) => {
      releaseModel = resolve;
    });
    setStreams(runtime, [
      {
        async *[Symbol.asyncIterator]() {
          await modelGate;
          yield* [];
        },
        async result() {
          return createAssistant(persona, "first");
        },
      },
    ]);

    const turn = runtime.submit("original");
    await vi.waitFor(() => expect(runtime.status).toBe("running"));
    const steering = runtime.steer("change direction");
    rejectAssistantFinal = true;
    releaseModel();

    await expect(turn).rejects.toThrow("sink failed");
    await expect(steering.applied).rejects.toThrow("sink failed");
    await expect(steering.result).rejects.toThrow("sink failed");
  });

  it("batches steering at a boundary and captures the latest spec for the resulting turn", async () => {
    const call = fauxToolCall("boundary_tool", {}, { id: "boundary-call" });
    let releaseTool;
    const toolGate = new Promise((resolve) => {
      releaseTool = resolve;
    });
    let markToolStarted;
    const toolStarted = new Promise((resolve) => {
      markToolStarted = resolve;
    });
    const tool = createTool("boundary_tool", async () => {
      markToolStarted();
      await toolGate;
      return { content: [{ type: "text", text: "done" }], outcome: "succeeded" };
    });
    const firstPersona = createPersona({ id: "first-persona" });
    const secondPersona = createPersona({
      id: "second-persona",
      model: { ...firstPersona.model, id: `${firstPersona.model.id}-next` },
      settings: { reasoning: "high" },
    });
    const { runtime, events } = createRuntime({ persona: firstPersona, tools: [tool] });
    const toolMessage = createAssistant(firstPersona, [call], { stopReason: "toolUse" });
    const models = [];
    runtime.spec.model.stream = () => {
      models.push(firstPersona.model.id);
      return createStream(
        [
          { type: "toolcall_start", contentIndex: 0, partial: toolMessage },
          { type: "toolcall_end", contentIndex: 0, toolCall: call, partial: toolMessage },
        ],
        toolMessage,
      );
    };

    const firstTurn = runtime.submit("original");
    await toolStarted;
    const steerOne = runtime.steer("change direction");
    const steerTwo = runtime.steer("also inspect docs");
    const secondSpec = {
      ...runtime.spec,
      model: { ...runtime.spec.model, model: secondPersona.model },
      attribution: { personaId: secondPersona.id, reasoningEffort: "high" },
      systemPrompt: "new system",
      tools: new ToolRegistry([tool]),
    };
    secondSpec.model.stream = () => {
      models.push(secondPersona.model.id);
      return createStream([], createAssistant(secondPersona, "steered"));
    };
    runtime.updateSpec(secondSpec);
    releaseTool();

    const initialResult = await firstTurn;
    const [firstAssociation, secondAssociation] = await Promise.all([
      steerOne.result,
      steerTwo.result,
    ]);

    expect(firstAssociation).toEqual(secondAssociation);
    expect(initialResult.finalMessage).toBe(toolMessage);
    expect(firstAssociation.result.finalMessage.content[0].text).toBe("steered");
    expect(models).toEqual([firstPersona.model.id, secondPersona.model.id]);
    const steeringMessage = runtime.rawHistoryEntriesSnapshot.find(
      (entry) => entry.id === firstAssociation.historyEntryId,
    ).message.content[0].text;
    expect(steeringMessage).toContain("<system>");
    expect(steeringMessage).toContain("change direction");
    expect(steeringMessage).toContain("also inspect docs");
    expect(events.filter((event) => event.type === "turn_started")).toHaveLength(2);
    expect(events.findLast((event) => event.type === "assistant_final")).toMatchObject({
      personaId: "second-persona",
      reasoningEffort: "high",
    });
  });

  it("cancels unapplied steering and removes the pending boundary stop", async () => {
    let releaseModel;
    const modelGate = new Promise((resolve) => {
      releaseModel = resolve;
    });
    const { runtime, persona, events } = createRuntime();
    const streamModel = setStreams(runtime, [
      {
        async *[Symbol.asyncIterator]() {
          await modelGate;
          yield* [];
        },
        async result() {
          return createAssistant(persona, "done");
        },
      },
    ]);

    const turn = runtime.submit("original");
    await vi.waitFor(() => expect(runtime.status).toBe("running"));
    const steering = runtime.steer("cancel me");
    expect(runtime.cancelSteering()).toEqual([{ id: steering.id, text: "cancel me" }]);
    await expect(steering.applied).rejects.toThrow("steering submission was cancelled");
    await expect(steering.result).rejects.toThrow("steering submission was cancelled");
    releaseModel();
    await turn;

    expect(streamModel).toHaveBeenCalledOnce();
    expect(events.findLast((event) => event.type === "turn_finished")).toMatchObject({
      outcome: "completed",
    });
  });

  it("rewinds through an awaited durable event and rejects active turns", async () => {
    let releaseModel;
    const modelGate = new Promise((resolve) => {
      releaseModel = resolve;
    });
    const { runtime, persona, events } = createRuntime();
    const rewindId = await runtime.commitUserText("rewind me");
    const result = await runtime.rewindToHistoryEntryId(rewindId);

    expect(result).toEqual({
      historyEntryId: rewindId,
      text: "rewind me",
      removedEntryIds: [rewindId],
    });
    expect(events.at(-1)).toEqual({
      type: "history_rewound",
      ...result,
      revision: runtime.state.revision,
    });

    setStreams(runtime, [
      {
        async *[Symbol.asyncIterator]() {
          await modelGate;
          yield* [];
        },
        async result() {
          return createAssistant(persona, "done");
        },
      },
    ]);
    const turn = runtime.submit("active");
    await vi.waitFor(() => expect(runtime.status).toBe("running"));
    await expect(
      runtime.rewindToHistoryEntryId(runtime.state.historyEntries[0].id),
    ).rejects.toThrow("cannot rewind a running agent");
    releaseModel();
    await turn;
  });

  it("interrupts active model streaming", async () => {
    const { runtime, persona } = createRuntime();
    runtime.spec.model.stream = vi.fn((_context, options) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) =>
          options.signal.addEventListener("abort", resolve, { once: true }),
        );
      },
      async result() {
        return createAssistant(persona, "interrupted", { stopReason: "aborted" });
      },
    }));

    const turn = runtime.submit("wait");
    await vi.waitFor(() => expect(runtime.status).toBe("running"));
    expect(runtime.interrupt()).toBe(true);
    await expect(turn).resolves.toMatchObject({ aborted: true });
  });

  it("settles queued tools as cancelled when a turn is interrupted", async () => {
    const firstCall = fauxToolCall("queued_tool", {}, { id: "queued-first" });
    const secondCall = fauxToolCall("queued_tool", {}, { id: "queued-second" });
    const execute = vi.fn(async (call, context) => {
      if (call.id === firstCall.id) {
        await new Promise((resolve) =>
          context.signal.addEventListener("abort", resolve, { once: true }),
        );
      }
      return {
        content: [{ type: "text", text: "cancelled" }],
        outcome: context.signal.aborted ? "cancelled" : "succeeded",
      };
    });
    const { runtime, persona, events } = createRuntime({
      tools: [createTool("queued_tool", execute)],
    });
    const partial = createAssistant(persona, [firstCall, secondCall], {
      stopReason: "toolUse",
    });
    runtime.spec.model.stream = vi.fn((_context, options) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "toolcall_start", contentIndex: 0, partial };
        yield { type: "toolcall_end", contentIndex: 0, toolCall: firstCall, partial };
        yield { type: "toolcall_start", contentIndex: 1, partial };
        yield { type: "toolcall_end", contentIndex: 1, toolCall: secondCall, partial };
        await new Promise((resolve) =>
          options.signal.addEventListener("abort", resolve, { once: true }),
        );
      },
      async result() {
        return createAssistant(persona, [firstCall, secondCall], { stopReason: "aborted" });
      },
    }));

    const turn = runtime.submit("run tools");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    runtime.interrupt();
    await turn;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      events
        .filter((event) => event.type === "tool_run_finished")
        .map((event) => [event.toolCallId, event.outcome]),
    ).toEqual([
      [firstCall.id, "cancelled"],
      [secondCall.id, "cancelled"],
    ]);
    expect(events.find((event) => event.type === "tool_recovery").toolResults).toHaveLength(2);
  });

  it("interrupts active tool execution through the narrow execution-local context", async () => {
    let executionContext;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const call = fauxToolCall("blocking_tool", {}, { id: "blocking-call" });
    const tool = createTool(
      "blocking_tool",
      async (_toolCall, context) =>
        await new Promise((resolve) => {
          executionContext = context;
          markStarted();
          context.signal.addEventListener(
            "abort",
            () =>
              resolve({
                content: [{ type: "text", text: "cancelled" }],
                outcome: "failed",
              }),
            { once: true },
          );
        }),
    );
    const { runtime, persona, events } = createRuntime({ tools: [tool] });
    const toolMessage = createAssistant(persona, [call], { stopReason: "toolUse" });
    setStreams(runtime, [
      createStream(
        [
          { type: "toolcall_start", contentIndex: 0, partial: toolMessage },
          { type: "toolcall_end", contentIndex: 0, toolCall: call, partial: toolMessage },
        ],
        toolMessage,
      ),
    ]);

    const turn = runtime.submit("block");
    await started;
    expect(Object.keys(executionContext).sort()).toEqual([
      "agentId",
      "assistantMessageId",
      "emitActivity",
      "signal",
      "turnId",
    ]);
    expect(executionContext.agentId).toBe(runtime.agentIdValue);
    expect(executionContext.assistantMessageId).toBe(
      events.find((event) => event.type === "assistant_start").historyEntryId,
    );
    expect(runtime.interrupt()).toBe(true);
    await expect(turn).resolves.toMatchObject({ aborted: true });

    expect(runtime.status).toBe("idle");
    expect(events.findLast((event) => event.type === "turn_finished")).toMatchObject({
      outcome: "interrupted",
    });
  });

  it("restores durable state without hidden usage-validity flags", async () => {
    const { runtime, persona } = createRuntime();
    setStreams(runtime, [createStream([], createAssistant(persona, "saved"))]);
    await runtime.submit("persisted");
    const state = runtime.snapshot();

    expect(state).not.toHaveProperty("autoCompactionUsageInvalidated");
    const restored = new AgentRuntime({
      spec: runtime.spec,
      state,
      eventSink: async () => {},
    });
    expect(restored.snapshot()).toEqual(state);
    expect(restored.status).toBe("idle");
  });
});
