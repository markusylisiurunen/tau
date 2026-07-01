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
import type { RiskLevel } from "../types.js";
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
  maxRetries?: number;
  delayMs?: number;
};

export type RunModelSubturnOptions = {
  model: Model<Api>;
  context: Context;
  modelRuntime: ModelRuntime;
  streamOptions: TauStreamOptions;
  signal: AbortSignal;
  emitPartials?: boolean;
  retry?: RetryOptions;
};

export async function* runModelSubturn(
  options: RunModelSubturnOptions,
): AsyncGenerator<ModelRunnerEvent, AssistantMessage, void> {
  const {
    model,
    context,
    modelRuntime,
    streamOptions,
    signal,
    emitPartials = false,
    retry,
  } = options;

  const runAttempt = async function* (
    attemptOptions: TauStreamOptions,
  ): AsyncGenerator<ModelRunnerEvent, AssistantMessage, void> {
    const stream = modelRuntime.streamModel(model, context, attemptOptions);
    const accumulator = emitPartials ? new MessageAccumulator() : undefined;
    let lastPartialEmittedAt = 0;
    let hasPendingPartial = false;

    const emitPartialIfPending = async function* (): AsyncGenerator<ModelRunnerEvent, void, void> {
      if (!accumulator || !hasPendingPartial) {
        return;
      }
      const snapshot = accumulator.snapshot;
      hasPendingPartial = false;
      if (!snapshot.hasTextStarted && !snapshot.hasAnyThinking) {
        return;
      }
      yield { type: "assistant_partial", snapshot };
      lastPartialEmittedAt = Date.now();
    };

    try {
      for await (const event of stream) {
        if (accumulator) {
          accumulator.processEvent(event as AssistantMessageEvent);
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
      if (attempt < maxRetries && retry?.shouldRetryAfterError?.({ error: result, model })) {
        attempt += 1;
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
      if (attempt < maxRetries && retry?.shouldRetryAfterError?.({ error, model })) {
        attempt += 1;
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
  enabledTools: Tool[];
  riskLevel: RiskLevel;
  signal: AbortSignal;
  dispatchContext: ToolDispatchContext;
  toolErrorMessages?: {
    notEnabled?: (toolCall: ToolCall) => string;
    unsupported?: (toolCall: ToolCall) => string;
  };
};

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
    riskLevel,
    signal,
    dispatchContext,
    toolErrorMessages,
  } = options;
  const enabledToolNames = new Set(enabledTools.map((tool) => tool.name));

  // Step 1: Validate all tools and create result buffer.
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

    const def = toolRegistry.get(toolCall.name);
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

  // Step 2: Execute tools in original order.
  for (const entry of validToolCalls) {
    if (signal.aborted) break;

    const { index, toolCall, def } = entry;
    let result: ToolDispatchResult | ToolDispatchResultWithPhases;
    try {
      result = await def.dispatch(toolCall, riskLevel, signal, dispatchContext);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const toolError = createToolError(
        toolCall,
        `Tool '${toolCall.name}' dispatch failed: ${errorMsg}`,
      );
      resultsByIndex.set(index, toolError);
      yield {
        type: "notice",
        severity: "error",
        text: `Tool '${toolCall.name}' (${toolCall.id}) dispatch failed: ${errorMsg}`,
      };
      continue;
    }

    if (result.kind === "phased") {
      if (result.startedUiEvent) {
        yield { type: "tool_ui", uiEvent: result.startedUiEvent };
      }

      const phasedResult = yield* runPhasedToolResult(result);
      const { toolResult, uiEvent } = phasedResult;
      resultsByIndex.set(index, toolResult);
      if (uiEvent) {
        yield { type: "tool_ui", uiEvent };
      }
    } else {
      const { toolResult, uiEvent } = result;
      resultsByIndex.set(index, toolResult);
      if (uiEvent) {
        yield { type: "tool_ui", uiEvent };
      }
    }
  }

  // Step 6: Append all results to conversation history in original order.
  for (let i = 0; i < toolCalls.length; i++) {
    const toolResult = resultsByIndex.get(i);
    if (toolResult) {
      yield { type: "tool_result", message: toolResult };
    }
  }
}
