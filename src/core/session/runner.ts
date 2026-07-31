import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  RunnerAssistantPartialEvent,
  RunnerToolCallDiscardedEvent,
  RunnerToolCallStreamingEvent,
  RunnerToolResultEvent,
} from "../agent/events.js";
import type {
  AgentTool,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolRegistry,
  ToolUiEvent,
} from "../tools/registry.js";
import type { TauStreamOptions } from "../utils/streaming_settings.js";
import { MessageAccumulator } from "./message_accumulator.js";

const ASSISTANT_PARTIAL_MIN_INTERVAL_MS = 33;

type NoticeEvent = Extract<AgentEvent, { type: "notice" }>;
type ModelRetryEvent = Extract<
  AgentEvent,
  { type: "model_retry_scheduled" | "model_retry_started" }
>;
type ToolActivityAgentEvent = {
  type: "tool_activity";
  activity: ToolUiEvent;
};
type ToolRunAgentEvent = Extract<
  AgentEvent,
  {
    type: "tool_run_queued" | "tool_run_blocked" | "tool_run_started" | "tool_run_finished";
  }
>;
type AcknowledgedToolRunnerEvent = (ToolActivityAgentEvent | ToolRunAgentEvent) & {
  acknowledge: (error?: Error) => void;
};

export type ModelRunnerEvent =
  | NoticeEvent
  | ModelRetryEvent
  | RunnerAssistantPartialEvent
  | RunnerToolCallStreamingEvent
  | RunnerToolCallDiscardedEvent;
export type ToolRunnerEvent =
  | NoticeEvent
  | ToolActivityAgentEvent
  | ToolRunAgentEvent
  | AcknowledgedToolRunnerEvent
  | RunnerToolResultEvent;
export type RunnerEvent = ModelRunnerEvent | ToolRunnerEvent;

export type RetryOptions = {
  notice?: { text: string; severity?: NoticeEvent["severity"] };
  shouldRetryAfterError?: (args: { error: unknown; model: Model<Api> }) => boolean;
  onRetry?: () => void;
  maxRetries?: number;
  delayMs?: number;
};

export type RunModelSubturnOptions = {
  model: Model<Api>;
  context: Context;
  streamModel: (context: Context, options: TauStreamOptions) => AssistantMessageEventStream;
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
  const { model, context, streamModel, streamOptions, signal, emitPartials, retry } = options;

  let hasEmittedCompletedToolCall = false;

  const runAttempt = async function* (
    attemptOptions: TauStreamOptions,
  ): AsyncGenerator<ModelRunnerEvent, AssistantMessage, void> {
    const stream = streamModel(context, attemptOptions);
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
        yield { type: "model_retry_scheduled", attempt, delayMs };
        if (retryNotice) {
          yield retryNotice;
        }
        await waitForRetry();
        if (signal.aborted) {
          throw new Error("Request was aborted");
        }
        yield { type: "model_retry_started", attempt };
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
        yield { type: "model_retry_scheduled", attempt, delayMs };
        if (retryNotice) {
          yield retryNotice;
        }
        await waitForRetry();
        if (signal.aborted) {
          throw new Error("Request was aborted");
        }
        yield { type: "model_retry_started", attempt };
        continue;
      }
      throw error;
    }
  }
}

export type SequentialToolCallRunnerOptions = {
  toolRegistry: ToolRegistry;
  executionContext: Omit<ToolExecutionContext, "signal" | "emitActivity">;
  now?: () => number;
};

type PreparedToolCall =
  | {
      type: "ready";
      toolCall: ToolCall;
      definition: AgentTool;
    }
  | {
      type: "rejected";
      toolCall: ToolCall;
      message: string;
    };

function prepareToolCall(
  toolCall: ToolCall,
  options: SequentialToolCallRunnerOptions,
): PreparedToolCall {
  const definition = options.toolRegistry.get(toolCall.name);
  if (!definition) {
    return {
      type: "rejected",
      toolCall,
      message: `Tool '${toolCall.name}' is not available for this turn.`,
    };
  }

  return { type: "ready", toolCall, definition };
}

function createToolQueuedEvent(
  prepared: Extract<PreparedToolCall, { type: "ready" }>,
): ToolActivityAgentEvent {
  const { toolCall, definition } = prepared;
  return {
    type: "tool_activity",
    activity: {
      type: "tool_call_queued",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      ...definition.describe(toolCall),
    },
  };
}

function createToolBlockedEvent(toolCall: ToolCall, reason: string): ToolActivityAgentEvent {
  return {
    type: "tool_activity",
    activity: {
      type: "tool_call_blocked",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      headerTarget: toolCall.name,
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
  private readonly pendingAcknowledgements = new Set<(error?: Error) => void>();
  private completion?: Promise<void>;
  private finished = false;
  private closed = false;
  private failure?: { error: unknown };
  private acknowledgementFailure?: Error;

  constructor(
    private readonly options: SequentialToolCallRunnerOptions,
    private readonly signal: AbortSignal,
  ) {}

  prepare(toolCall: ToolCall): {
    lifecycleEvent: ToolRunAgentEvent;
    activityEvent: ToolActivityAgentEvent;
    start: () => void;
  } {
    return this.prepareAdmission(prepareToolCall(toolCall, this.options));
  }

  prepareRejected(
    toolCall: ToolCall,
    message: string,
  ): {
    lifecycleEvent: ToolRunAgentEvent;
    activityEvent: ToolActivityAgentEvent;
    start: () => void;
  } {
    return this.prepareAdmission({ type: "rejected", toolCall, message });
  }

  private prepareAdmission(prepared: PreparedToolCall): {
    lifecycleEvent: ToolRunAgentEvent;
    activityEvent: ToolActivityAgentEvent;
    start: () => void;
  } {
    const timestamp = this.options.now?.() ?? Date.now();
    return {
      lifecycleEvent:
        prepared.type === "ready"
          ? {
              type: "tool_run_queued",
              toolCallId: prepared.toolCall.id,
              toolName: prepared.toolCall.name,
              timestamp,
            }
          : {
              type: "tool_run_blocked",
              toolCallId: prepared.toolCall.id,
              toolName: prepared.toolCall.name,
              reason: prepared.message,
              timestamp,
            },
      activityEvent:
        prepared.type === "ready"
          ? createToolQueuedEvent(prepared)
          : createToolBlockedEvent(prepared.toolCall, prepared.message),
      start: () => this.enqueuePrepared(prepared),
    };
  }

  private enqueuePrepared(prepared: PreparedToolCall): void {
    if (this.finished) {
      throw new Error("cannot enqueue a tool call after finishing the runner");
    }

    this.execution = this.execution.then(async () => {
      if (prepared.type === "ready" && this.signal.aborted) {
        const completed = completeToolRun(
          prepared.toolCall,
          {
            content: [{ type: "text", text: "Tool execution was cancelled before it started." }],
            outcome: "cancelled",
          },
          this.options.now?.() ?? Date.now(),
        );
        await this.publishAwaited({
          type: "tool_run_finished",
          toolCallId: prepared.toolCall.id,
          toolName: prepared.toolCall.name,
          outcome: completed.outcome,
          timestamp: completed.message.timestamp,
        });
        this.publish({ type: "tool_result", message: completed.message });
        return;
      }
      if (prepared.type === "ready") {
        await this.publishAwaited({
          type: "tool_run_started",
          toolCallId: prepared.toolCall.id,
          toolName: prepared.toolCall.name,
          timestamp: this.options.now?.() ?? Date.now(),
        });
      }
      const execution = runPreparedToolCall(
        prepared,
        this.signal,
        this.options.executionContext,
        this.options.now,
      );
      while (true) {
        const next = await execution.next();
        if (next.done) {
          if (prepared.type === "ready") {
            await this.publishAwaited({
              type: "tool_run_finished",
              toolCallId: prepared.toolCall.id,
              toolName: prepared.toolCall.name,
              outcome: next.value.outcome,
              timestamp: next.value.message.timestamp,
            });
          }
          this.publish({ type: "tool_result", message: next.value.message });
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

  private async publishAwaited(event: ToolRunAgentEvent): Promise<void> {
    let acknowledge: (error?: Error) => void = () => {};
    const acknowledged = new Promise<void>((resolve, reject) => {
      acknowledge = (error) => (error ? reject(error) : resolve());
    });
    this.publish({ ...event, acknowledge });
    await acknowledged;
  }

  cancelPendingAcknowledgements(error: Error): void {
    this.acknowledgementFailure = error;
    for (const acknowledge of [...this.pendingAcknowledgements]) {
      acknowledge(error);
    }
  }

  private publish(event: ToolRunnerEvent): void {
    if ("acknowledge" in event) {
      const originalAcknowledge = event.acknowledge;
      let acknowledged = false;
      const acknowledge = (error?: Error) => {
        if (acknowledged) return;
        acknowledged = true;
        this.pendingAcknowledgements.delete(acknowledge);
        originalAcknowledge(error);
      };
      this.pendingAcknowledgements.add(acknowledge);
      event = { ...event, acknowledge };
      if (this.acknowledgementFailure) {
        acknowledge(this.acknowledgementFailure);
      }
    }

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

type CompletedToolRun = {
  message: ToolResultMessage;
  outcome: ToolExecutionOutcome["outcome"];
};

function completeToolRun(
  toolCall: ToolCall,
  outcome: ToolExecutionOutcome,
  timestamp: number,
): CompletedToolRun {
  return {
    message: {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: structuredClone(outcome.content),
      isError: outcome.outcome !== "succeeded",
      timestamp,
    },
    outcome: outcome.outcome,
  };
}

async function* runPreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal,
  executionContext: Omit<ToolExecutionContext, "signal" | "emitActivity">,
  now: () => number = Date.now,
): AsyncGenerator<ToolRunnerEvent, CompletedToolRun, void> {
  if (prepared.type === "rejected") {
    yield { type: "notice", severity: "error", text: prepared.message };
    return completeToolRun(
      prepared.toolCall,
      { content: [{ type: "text", text: prepared.message }], outcome: "blocked" },
      now(),
    );
  }

  const { toolCall, definition } = prepared;
  try {
    const activities: Array<{
      activity: ToolUiEvent;
      resolve: () => void;
      reject: (error: Error) => void;
    }> = [];
    let wake: (() => void) | undefined;
    let outcome: Awaited<ReturnType<AgentTool["execute"]>> | undefined;
    let executionError: unknown;
    let settled = false;
    const execution = definition
      .execute(toolCall, {
        ...executionContext,
        signal,
        emitActivity: (activity) =>
          new Promise<void>((resolve, reject) => {
            activities.push({ activity, resolve, reject });
            wake?.();
          }),
      })
      .then(
        (result) => {
          outcome = result;
        },
        (error: unknown) => {
          executionError = error;
        },
      )
      .finally(() => {
        settled = true;
        wake?.();
      });

    try {
      while (!settled || activities.length > 0) {
        const next = activities.shift();
        if (next) {
          let acknowledge: (error?: Error) => void = () => {};
          const acknowledged = new Promise<void>((resolve, reject) => {
            acknowledge = (error) => (error ? reject(error) : resolve());
          });
          yield { type: "tool_activity", activity: next.activity, acknowledge };
          try {
            await acknowledged;
            next.resolve();
          } catch (error) {
            next.reject(error instanceof Error ? error : new Error(String(error)));
            throw error;
          }
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (settled || activities.length > 0) resolve();
        });
        wake = undefined;
      }
      await execution;
    } finally {
      const error = new Error(`tool activity for '${toolCall.name}' was cancelled`);
      for (const pending of activities.splice(0)) pending.reject(error);
    }

    if (executionError) throw executionError;
    if (!outcome) throw new Error(`tool '${toolCall.name}' returned no outcome`);
    return completeToolRun(toolCall, outcome, now());
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    yield {
      type: "notice",
      severity: "error",
      text: `Tool '${toolCall.name}' (${toolCall.id}) execution failed: ${errorMessage}`,
    };
    return completeToolRun(
      toolCall,
      {
        content: [
          { type: "text", text: `Tool '${toolCall.name}' execution failed: ${errorMessage}` },
        ],
        outcome: signal.aborted ? "cancelled" : "failed",
      },
      now(),
    );
  }
}
