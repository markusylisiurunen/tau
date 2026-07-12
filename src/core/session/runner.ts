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
  RunnerToolResultEvent,
} from "../events/types.js";
import type {
  ToolDefinition,
  ToolDispatchContext,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolRegistry,
} from "../tools/registry.js";
import { createToolError } from "../utils/messages.js";
import type { ModelRuntime } from "../utils/model_stream.js";
import type { TauStreamOptions } from "../utils/streaming_settings.js";
import { MessageAccumulator } from "./message_accumulator.js";

const ASSISTANT_PARTIAL_MIN_INTERVAL_MS = 33;

export type ModelRunnerEvent = CoreNoticeEvent | RunnerAssistantPartialEvent;
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

export async function* runModelSubturn(
  options: RunModelSubturnOptions,
): AsyncGenerator<ModelRunnerEvent, AssistantMessage, void> {
  const { model, context, modelRuntime, streamOptions, signal, emitPartials, retry } = options;

  let hasEmittedToolCall = false;

  const runAttempt = async function* (
    attemptOptions: TauStreamOptions,
  ): AsyncGenerator<ModelRunnerEvent, AssistantMessage, void> {
    const stream = modelRuntime.streamModel(model, context, attemptOptions);
    const accumulator = emitPartials ? new MessageAccumulator() : undefined;
    let lastPartialEmittedAt = 0;
    let hasPendingPartial = false;
    let emittedToolCallCount = 0;
    const toolCallOrder: number[] = [];
    const completedToolCalls = new Map<
      number,
      Extract<AssistantMessageEvent, { type: "toolcall_end" }>
    >();

    const emitPartialIfPending = async function* (): AsyncGenerator<ModelRunnerEvent, void, void> {
      if (!accumulator || !hasPendingPartial) {
        return;
      }
      const snapshot = accumulator.snapshot;
      hasPendingPartial = false;
      if (!snapshot.hasTextStarted && !snapshot.hasAnyThinking && snapshot.toolCalls.length === 0) {
        return;
      }
      if (snapshot.toolCalls.length > emittedToolCallCount) {
        hasEmittedToolCall = true;
        emittedToolCallCount = snapshot.toolCalls.length;
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
          if (toolCallOrder.includes(event.contentIndex)) {
            throw new Error(`model stream started tool call index ${event.contentIndex} twice`);
          }
          toolCallOrder.push(event.contentIndex);
          toolCallOrder.sort((left, right) => left - right);
          continue;
        }

        if (event.type === "toolcall_end") {
          if (!accumulator) {
            continue;
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
            accumulator.processEvent(completed);
            hasPendingPartial = true;
            yield* emitPartialIfPending();
          }
        }
      }
    } catch (error) {
      yield* emitPartialIfPending();
      throw error;
    }

    yield* emitPartialIfPending();
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
        !hasEmittedToolCall &&
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
        !hasEmittedToolCall &&
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

  enqueue(toolCall: ToolCall): void {
    if (this.finished) {
      throw new Error("cannot enqueue a tool call after finishing the runner");
    }

    this.execution = this.execution.then(async () => {
      for await (const event of runToolCalls({
        ...this.options,
        toolCalls: [toolCall],
        signal: this.signal,
      })) {
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter.resolve({ done: false, value: event });
        } else {
          this.events.push(event);
        }
      }
    });
    void this.execution.catch((error: unknown) => {
      this.failure = { error };
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(error);
      }
    });
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

type PhasedToolRaceResult =
  | { type: "run"; result: ToolDispatchResult }
  | { type: "run_error"; error: unknown }
  | { type: "ui"; result: IteratorResult<CoreToolUiEvent["uiEvent"]> }
  | { type: "ui_error"; error: unknown };

async function* runPhasedToolResult(
  result: ToolDispatchResultWithPhases,
): AsyncGenerator<ToolRunnerEvent, ToolDispatchResult, void> {
  if (!result.uiEvents) {
    return await result.run;
  }

  const iterator = result.uiEvents[Symbol.asyncIterator]();
  let runSettled = false;
  let uiSettled = false;
  let finalResult: ToolDispatchResult | undefined;
  let runPromise: Promise<PhasedToolRaceResult> | undefined = result.run.then(
    (value) => ({ type: "run", result: value }),
    (error: unknown) => ({ type: "run_error", error }),
  );
  let uiPromise: Promise<PhasedToolRaceResult> | undefined = iterator.next().then(
    (value) => ({ type: "ui", result: value }),
    (error: unknown) => ({ type: "ui_error", error }),
  );

  while (!runSettled) {
    const pending = [runPromise, uiPromise].filter(
      (promise): promise is Promise<PhasedToolRaceResult> => Boolean(promise),
    );
    const next = await Promise.race(pending);

    switch (next.type) {
      case "run":
        runSettled = true;
        finalResult = next.result;
        break;
      case "run_error":
        runSettled = true;
        await iterator.return?.();
        throw next.error;
      case "ui":
        if (next.result.done) {
          uiSettled = true;
          uiPromise = undefined;
        } else {
          yield { type: "tool_ui", uiEvent: next.result.value };
          uiPromise = iterator.next().then(
            (value) => ({ type: "ui", result: value }),
            (error: unknown) => ({ type: "ui_error", error }),
          );
        }
        break;
      case "ui_error":
        uiSettled = true;
        uiPromise = undefined;
        yield {
          type: "notice",
          severity: "warn",
          text: `tool UI update stream failed: ${next.error instanceof Error ? next.error.message : String(next.error)}`,
        };
        break;
    }

    if (uiSettled) {
      uiPromise = undefined;
    }
    if (runSettled) {
      runPromise = undefined;
    }
  }

  if (!uiSettled) {
    await iterator.return?.();
  }

  if (!finalResult) {
    throw new Error("phased tool completed without a result");
  }
  return finalResult;
}

export async function* runToolCalls(
  options: RunToolCallsOptions,
): AsyncGenerator<ToolRunnerEvent, void, void> {
  const {
    toolCalls,
    toolRegistry,
    enabledTools,
    extraToolDefinitions = [],
    signal,
    dispatchContext,
    toolErrorMessages,
  } = options;
  const enabledToolNames = new Set(enabledTools.map((tool) => tool.name));

  const resultsByIndex = new Map<number, ToolResultMessage>();
  const validToolCalls: Array<{ index: number; toolCall: ToolCall; def: ToolDefinition }> = [];

  for (let i = 0; i < toolCalls.length; i++) {
    if (signal.aborted) break;

    const toolCall = toolCalls[i]!;

    if (!enabledToolNames.has(toolCall.name)) {
      const msg =
        toolErrorMessages?.notEnabled?.(toolCall) ??
        `Tool '${toolCall.name}' is not enabled for this session.`;
      const toolError = createToolError(toolCall, msg);
      resultsByIndex.set(i, toolError);
      yield { type: "notice", severity: "error", text: msg };
      continue;
    }

    const def =
      toolRegistry.get(toolCall.name) ??
      extraToolDefinitions.find((definition) => definition.schema.name === toolCall.name);
    if (!def) {
      const msg =
        toolErrorMessages?.unsupported?.(toolCall) ??
        `Tool '${toolCall.name}' is not supported by tau.`;
      const toolError = createToolError(toolCall, msg);
      resultsByIndex.set(i, toolError);
      yield { type: "notice", severity: "error", text: msg };
      continue;
    }

    validToolCalls.push({ index: i, toolCall, def });
  }

  for (const { toolCall } of validToolCalls) {
    if (signal.aborted) break;
    yield {
      type: "tool_ui",
      uiEvent: {
        type: "tool_call_queued",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        headerTarget: toolCall.name,
      },
    };
  }

  for (const entry of validToolCalls) {
    if (signal.aborted) break;

    const { index, toolCall, def } = entry;
    try {
      const dispatched = await def.dispatch(toolCall, signal, dispatchContext);
      if (dispatched.kind === "phased" && dispatched.startedUiEvent) {
        yield { type: "tool_ui", uiEvent: dispatched.startedUiEvent };
      }
      const result =
        dispatched.kind === "phased" ? yield* runPhasedToolResult(dispatched) : dispatched;
      const { toolResult, uiEvent } = result;
      resultsByIndex.set(index, toolResult);
      if (uiEvent) {
        yield { type: "tool_ui", uiEvent };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const toolError = createToolError(
        toolCall,
        `Tool '${toolCall.name}' execution failed: ${errorMsg}`,
      );
      resultsByIndex.set(index, toolError);
      yield {
        type: "notice",
        severity: "error",
        text: `Tool '${toolCall.name}' (${toolCall.id}) execution failed: ${errorMsg}`,
      };
    }
  }

  for (let i = 0; i < toolCalls.length; i++) {
    const toolResult = resultsByIndex.get(i);
    if (toolResult) {
      yield { type: "tool_result", message: toolResult };
    }
  }
}
