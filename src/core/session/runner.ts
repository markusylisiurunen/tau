import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type {
  CoreNoticeEvent,
  CoreToolUiEvent,
  RunnerAssistantPartialEvent,
  RunnerToolCallDiscardedEvent,
  RunnerToolCallStreamingEvent,
  RunnerToolResultEvent,
} from "../events/types.js";
import type { ToolDefinition, ToolDispatchContext, ToolRegistry } from "../tools/registry.js";
import { createToolError } from "../utils/messages.js";
import type { ModelRuntime } from "../utils/model_stream.js";
import type { TauStreamOptions } from "../utils/streaming_settings.js";
import { MessageAccumulator } from "./message_accumulator.js";

const ASSISTANT_PARTIAL_MIN_INTERVAL_MS = 33;
export const MAX_MODEL_SUBTURNS = 1024;

export type ModelRunnerEvent =
  | CoreNoticeEvent
  | RunnerAssistantPartialEvent
  | RunnerToolCallStreamingEvent
  | RunnerToolCallDiscardedEvent;
export type ToolRunnerEvent = CoreNoticeEvent | CoreToolUiEvent | RunnerToolResultEvent;
export type RunnerEvent = ModelRunnerEvent | ToolRunnerEvent;

export type RetryOptions = {
  notice?: { text: string; severity?: CoreNoticeEvent["severity"] };
  shouldRetryAfterError?: (args: { error: unknown; model: Model<Api> }) => boolean;
  onRetry?: () => void;
  maxRetries?: number;
  delayMs?: number;
};

export type RunModelSubturnOptions = {
  model: Model<Api>;
  context: Context;
  modelRuntime: ModelRuntime;
  streamOptions: TauStreamOptions;
  signal: AbortSignal;
  emitPartials: boolean;
  retry?: RetryOptions;
};

type StreamingToolCallIdentity = {
  toolCallId: string;
  toolName: string;
};

function getStreamingToolCallIdentity(
  event: Extract<
    AssistantMessageEvent,
    { type: "toolcall_start" | "toolcall_delta" | "toolcall_end" }
  >,
): StreamingToolCallIdentity | undefined {
  const content = event.partial.content[event.contentIndex];
  if (content?.type !== "toolCall" || !content.id.trim() || !content.name.trim()) {
    return undefined;
  }
  return { toolCallId: content.id, toolName: content.name };
}

export async function* runModelSubturn(
  options: RunModelSubturnOptions,
): AsyncGenerator<ModelRunnerEvent, AssistantMessage, void> {
  const { model, context, modelRuntime, streamOptions, signal, emitPartials, retry } = options;

  let hasEmittedCompletedToolCall = false;

  const runAttempt = async function* (
    attemptOptions: TauStreamOptions,
  ): AsyncGenerator<ModelRunnerEvent, AssistantMessage, void> {
    const stream = modelRuntime.streamModel(model, context, attemptOptions);
    const accumulator = emitPartials ? new MessageAccumulator() : undefined;
    let lastPartialEmittedAt = 0;
    let hasPendingPartial = false;
    let emittedCompletedToolCallCount = 0;
    const toolCallOrder: number[] = [];
    const completedToolCalls = new Map<
      number,
      Extract<AssistantMessageEvent, { type: "toolcall_end" }>
    >();
    const streamingToolCalls = new Map<number, StreamingToolCallIdentity>();

    const trackStreamingToolCall = (
      event: Extract<
        AssistantMessageEvent,
        { type: "toolcall_start" | "toolcall_delta" | "toolcall_end" }
      >,
    ): RunnerToolCallStreamingEvent | RunnerToolCallDiscardedEvent | undefined => {
      const contentIndex = event.contentIndex;
      const current = streamingToolCalls.get(contentIndex);
      const next = getStreamingToolCallIdentity(event);
      if (
        current &&
        next &&
        current.toolCallId === next.toolCallId &&
        current.toolName === next.toolName
      ) {
        return undefined;
      }

      const duplicate = next
        ? [...streamingToolCalls].some(
            ([index, identity]) =>
              index !== contentIndex && identity.toolCallId === next.toolCallId,
          )
        : false;
      if (!next || duplicate) {
        if (!current) {
          return undefined;
        }
        streamingToolCalls.delete(contentIndex);
        return { type: "tool_call_discarded", toolCallId: current.toolCallId, contentIndex };
      }

      streamingToolCalls.set(contentIndex, next);
      return { type: "tool_call_streaming", ...next, contentIndex };
    };

    const discardStreamingToolCalls = (): RunnerToolCallDiscardedEvent[] => {
      const events = [...streamingToolCalls]
        .sort(([left], [right]) => left - right)
        .map(([contentIndex, identity]) => ({
          type: "tool_call_discarded" as const,
          toolCallId: identity.toolCallId,
          contentIndex,
        }));
      streamingToolCalls.clear();
      return events;
    };

    const emitPartialIfPending = async function* (): AsyncGenerator<ModelRunnerEvent, void, void> {
      if (!accumulator || !hasPendingPartial) {
        return;
      }
      const snapshot = accumulator.snapshot;
      hasPendingPartial = false;
      if (!snapshot.hasTextStarted && !snapshot.hasAnyThinking && snapshot.toolCalls.length === 0) {
        return;
      }
      if (snapshot.toolCalls.length > emittedCompletedToolCallCount) {
        hasEmittedCompletedToolCall = true;
        emittedCompletedToolCallCount = snapshot.toolCalls.length;
      }
      yield { type: "assistant_partial", snapshot };
      lastPartialEmittedAt = Date.now();
    };

    try {
      for await (const event of stream) {
        if (accumulator && event.type !== "toolcall_end") {
          accumulator.processEvent(event);
        }

        if (event.type === "text_delta" || event.type.startsWith("thinking_")) {
          if (accumulator) {
            hasPendingPartial = true;
            const now = Date.now();
            if (
              lastPartialEmittedAt === 0 ||
              now - lastPartialEmittedAt >= ASSISTANT_PARTIAL_MIN_INTERVAL_MS
            ) {
              yield* emitPartialIfPending();
            }
          }
          continue;
        }

        if (event.type === "toolcall_start") {
          yield* emitPartialIfPending();
          if (!accumulator) {
            continue;
          }
          const streamingEvent = trackStreamingToolCall(event);
          if (streamingEvent) {
            yield streamingEvent;
          }
          if (toolCallOrder.includes(event.contentIndex)) {
            throw new Error(`model stream started tool call index ${event.contentIndex} twice`);
          }
          toolCallOrder.push(event.contentIndex);
          toolCallOrder.sort((left, right) => left - right);
          continue;
        }

        if (event.type === "toolcall_delta") {
          if (!accumulator) {
            continue;
          }
          const streamingEvent = trackStreamingToolCall(event);
          if (streamingEvent) {
            yield streamingEvent;
          }
          continue;
        }

        if (event.type === "toolcall_end") {
          if (!accumulator) {
            continue;
          }
          const streamingEvent = trackStreamingToolCall(event);
          if (streamingEvent) {
            yield streamingEvent;
          }
          if (!toolCallOrder.includes(event.contentIndex)) {
            throw new Error(
              `model stream completed tool call at index ${event.contentIndex} without starting it`,
            );
          }
          completedToolCalls.set(event.contentIndex, event);

          while (toolCallOrder.length > 0) {
            const contentIndex = toolCallOrder[0]!;
            const completed = completedToolCalls.get(contentIndex);
            if (!completed) {
              break;
            }
            toolCallOrder.shift();
            completedToolCalls.delete(contentIndex);
            streamingToolCalls.delete(contentIndex);
            accumulator.processEvent(completed);
            hasPendingPartial = true;
            yield* emitPartialIfPending();
          }
        }
      }
    } catch (error) {
      yield* emitPartialIfPending();
      for (const discarded of discardStreamingToolCalls()) {
        yield discarded;
      }
      throw error;
    }

    yield* emitPartialIfPending();
    for (const discarded of discardStreamingToolCalls()) {
      yield discarded;
    }
    return await stream.result();
  };

  const retryNotice = retry?.notice
    ? {
        type: "notice" as const,
        severity: retry.notice.severity ?? "info",
        text: retry.notice.text,
      }
    : undefined;
  const maxRetries = retry?.maxRetries ?? 1;
  const delayMs = retry?.delayMs ?? 0;

  const waitForRetry = async () => {
    if (delayMs <= 0 || signal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (timer) {
          clearTimeout(timer);
        }
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      signal.addEventListener("abort", onAbort);
    });
  };

  let attempt = 0;

  while (true) {
    try {
      const result = yield* runAttempt(streamOptions);
      if (
        !hasEmittedCompletedToolCall &&
        attempt < maxRetries &&
        retry?.shouldRetryAfterError?.({ error: result, model })
      ) {
        attempt += 1;
        retry?.onRetry?.();
        if (retryNotice) {
          yield retryNotice;
        }
        await waitForRetry();
        if (signal.aborted) {
          throw new Error("Request was aborted");
        }
        continue;
      }
      return result;
    } catch (error) {
      if (
        !hasEmittedCompletedToolCall &&
        attempt < maxRetries &&
        retry?.shouldRetryAfterError?.({ error, model })
      ) {
        attempt += 1;
        retry?.onRetry?.();
        if (retryNotice) {
          yield retryNotice;
        }
        await waitForRetry();
        if (signal.aborted) {
          throw new Error("Request was aborted");
        }
        continue;
      }
      throw error;
    }
  }
}

export type RunToolCallsOptions = {
  toolCalls: ToolCall[];
  toolRegistry: ToolRegistry;
  extraToolDefinitions?: ToolDefinition[];
  enabledTools: Tool[];
  signal: AbortSignal;
  dispatchContext: ToolDispatchContext;
  toolErrorMessages?: {
    notEnabled?: (toolCall: ToolCall) => string;
    unsupported?: (toolCall: ToolCall) => string;
  };
};

export type SequentialToolCallRunnerOptions = Omit<RunToolCallsOptions, "toolCalls" | "signal">;

type ToolCallPreparationOptions = Pick<
  RunToolCallsOptions,
  "toolRegistry" | "extraToolDefinitions" | "enabledTools" | "toolErrorMessages"
>;

type PreparedToolCall =
  | {
      type: "ready";
      toolCall: ToolCall;
      definition: ToolDefinition;
    }
  | {
      type: "rejected";
      message: string;
      result: ToolResultMessage;
    };

function prepareToolCall(
  toolCall: ToolCall,
  options: ToolCallPreparationOptions,
): PreparedToolCall {
  if (!options.enabledTools.some((tool) => tool.name === toolCall.name)) {
    const message =
      options.toolErrorMessages?.notEnabled?.(toolCall) ??
      `Tool '${toolCall.name}' is not enabled for this session.`;
    return {
      type: "rejected",
      message,
      result: createToolError(toolCall, message),
    };
  }

  const definition =
    options.toolRegistry.get(toolCall.name) ??
    options.extraToolDefinitions?.find((candidate) => candidate.schema.name === toolCall.name);
  if (!definition) {
    const message =
      options.toolErrorMessages?.unsupported?.(toolCall) ??
      `Tool '${toolCall.name}' is not supported by tau.`;
    return {
      type: "rejected",
      message,
      result: createToolError(toolCall, message),
    };
  }

  return { type: "ready", toolCall, definition };
}

function createToolQueuedEvent(
  prepared: Extract<PreparedToolCall, { type: "ready" }>,
  context: ToolDispatchContext,
): CoreToolUiEvent {
  const { toolCall, definition } = prepared;
  return {
    type: "tool_ui",
    uiEvent: {
      type: "tool_call_queued",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      headerTarget: definition.getDisplayTarget(toolCall, context),
      ...(definition.getCodePreview ? { code: definition.getCodePreview(toolCall, context) } : {}),
    },
  };
}

function createToolBlockedEvent(
  result: Pick<ToolResultMessage, "toolCallId" | "toolName">,
  reason: string,
): CoreToolUiEvent {
  return {
    type: "tool_ui",
    uiEvent: {
      type: "tool_call_blocked",
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      headerTarget: result.toolName,
      reason,
    },
  };
}

export class SequentialToolCallRunner implements AsyncIterable<ToolRunnerEvent> {
  private readonly events: ToolRunnerEvent[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<ToolRunnerEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private execution: Promise<void> = Promise.resolve();
  private completion?: Promise<void>;
  private finished = false;
  private closed = false;
  private failure?: { error: unknown };

  constructor(
    private readonly options: SequentialToolCallRunnerOptions,
    private readonly signal: AbortSignal,
  ) {}

  enqueue(toolCall: ToolCall): CoreToolUiEvent {
    const prepared = prepareToolCall(toolCall, this.options);
    this.enqueuePrepared(prepared);
    return prepared.type === "ready"
      ? createToolQueuedEvent(prepared, this.options.dispatchContext)
      : createToolBlockedEvent(prepared.result, prepared.message);
  }

  enqueueRejected(toolCall: ToolCall, message: string): CoreToolUiEvent {
    const result = createToolError(toolCall, message);
    this.enqueuePrepared({ type: "rejected", message, result });
    return createToolBlockedEvent(result, message);
  }

  private enqueuePrepared(prepared: PreparedToolCall): void {
    if (this.finished) {
      throw new Error("cannot enqueue a tool call after finishing the runner");
    }

    this.execution = this.execution.then(async () => {
      if (this.signal.aborted) {
        return;
      }
      const execution = runPreparedToolCall(prepared, this.signal, this.options.dispatchContext);
      while (true) {
        const next = await execution.next();
        if (next.done) {
          this.publish({ type: "tool_result", message: next.value });
          return;
        }
        this.publish(next.value);
      }
    });
    void this.execution.catch((error: unknown) => {
      this.failure = { error };
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(error);
      }
    });
  }

  private publish(event: ToolRunnerEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: event });
    } else {
      this.events.push(event);
    }
  }

  finish(): Promise<void> {
    if (!this.completion) {
      this.finished = true;
      this.completion = this.execution.then(() => {
        this.closed = true;
        for (const waiter of this.waiters.splice(0)) {
          waiter.resolve({ done: true, value: undefined });
        }
      });
    }
    return this.completion;
  }

  next(): Promise<IteratorResult<ToolRunnerEvent>> {
    const event = this.events.shift();
    if (event) {
      return Promise.resolve({ done: false, value: event });
    }
    if (this.failure) {
      return Promise.reject(this.failure.error);
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<ToolRunnerEvent> {
    return this;
  }
}

async function* runPreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal,
  dispatchContext: ToolDispatchContext,
): AsyncGenerator<ToolRunnerEvent, ToolResultMessage, void> {
  if (prepared.type === "rejected") {
    yield { type: "notice", severity: "error", text: prepared.message };
    return prepared.result;
  }

  const { toolCall, definition } = prepared;
  try {
    const dispatch = await definition.dispatch(toolCall, signal, dispatchContext);
    if (dispatch.startedUiEvent) {
      yield { type: "tool_ui", uiEvent: dispatch.startedUiEvent };
    }
    const result = await dispatch.run;
    if (result.uiEvent) {
      yield { type: "tool_ui", uiEvent: result.uiEvent };
    }
    return result.toolResult;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    yield {
      type: "notice",
      severity: "error",
      text: `Tool '${toolCall.name}' (${toolCall.id}) execution failed: ${errorMessage}`,
    };
    return createToolError(toolCall, `Tool '${toolCall.name}' execution failed: ${errorMessage}`);
  }
}

export async function* runToolCalls(
  options: RunToolCallsOptions,
): AsyncGenerator<ToolRunnerEvent, void, void> {
  const { toolCalls, signal, dispatchContext, ...preparationOptions } = options;
  const preparedCalls: PreparedToolCall[] = [];
  for (const toolCall of toolCalls) {
    if (signal.aborted) {
      break;
    }
    preparedCalls.push(prepareToolCall(toolCall, preparationOptions));
  }
  const resultsByIndex = new Map<number, ToolResultMessage>();

  for (const [index, prepared] of preparedCalls.entries()) {
    if (signal.aborted) {
      break;
    }
    if (prepared.type !== "rejected") {
      continue;
    }
    resultsByIndex.set(index, prepared.result);
    yield createToolBlockedEvent(prepared.result, prepared.message);
    yield { type: "notice", severity: "error", text: prepared.message };
  }

  for (const prepared of preparedCalls) {
    if (signal.aborted) {
      break;
    }
    if (prepared.type === "ready") {
      yield createToolQueuedEvent(prepared, dispatchContext);
    }
  }

  for (const [index, prepared] of preparedCalls.entries()) {
    if (signal.aborted) {
      break;
    }
    if (prepared.type === "rejected") {
      continue;
    }
    resultsByIndex.set(index, yield* runPreparedToolCall(prepared, signal, dispatchContext));
  }

  for (const [index] of toolCalls.entries()) {
    const result = resultsByIndex.get(index);
    if (result) {
      yield { type: "tool_result", message: result };
    }
  }
}
