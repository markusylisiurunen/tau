import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { CoreNoticeEvent, RunnerEvent as CoreRunnerEvent } from "../events/types.js";
import type {
  ToolDefinition,
  ToolDispatchContext,
  ToolDispatchResult,
  ToolRegistry,
  ToolUiEvent,
} from "../tools/registry.js";
import type { RiskLevel } from "../types.js";
import { createToolError } from "../utils/messages.js";
import { streamModel } from "../utils/model_stream.js";
import type { TauStreamOptions } from "../utils/streaming_settings.js";
import { MessageAccumulator } from "./message_accumulator.js";

export type RunnerEvent = CoreRunnerEvent;

export type FlexRetryOptions = {
  notice?: { text: string; severity?: CoreNoticeEvent["severity"] };
  shouldRetryAfterError?: (args: { error: unknown }) => boolean;
  shouldRetryAfterResponse?: (args: {
    finalMessage: AssistantMessage;
    didEmitAnyOutput: boolean;
  }) => boolean;
};

export type RunModelSubturnOptions = {
  model: Model<Api>;
  context: Context;
  streamOptions: TauStreamOptions;
  signal: AbortSignal;
  emitPartials?: boolean;
  retry?: FlexRetryOptions;
};

export async function* runModelSubturn(
  options: RunModelSubturnOptions,
): AsyncGenerator<RunnerEvent, AssistantMessage, void> {
  const { model, context, streamOptions, signal, emitPartials = false, retry } = options;

  const runAttempt = async function* (
    attemptOptions: TauStreamOptions,
  ): AsyncGenerator<
    RunnerEvent,
    { finalMessage: AssistantMessage; didEmitAnyOutput: boolean },
    void
  > {
    const stream = streamModel(model, context, attemptOptions);
    const accumulator = emitPartials ? new MessageAccumulator() : undefined;
    let didEmitAnyOutput = false;

    for await (const event of stream) {
      if (accumulator) {
        accumulator.processEvent(event as AssistantMessageEvent);
      }

      if (event.type === "text_delta" || event.type.startsWith("thinking_")) {
        didEmitAnyOutput = true;
        if (accumulator) {
          yield { type: "assistant_partial", snapshot: accumulator.snapshot };
        }
      }
    }

    const finalMessage = await stream.result();
    return { finalMessage, didEmitAnyOutput };
  };

  const retryNotice = retry?.notice
    ? {
        type: "notice" as const,
        severity: retry.notice.severity ?? "info",
        text: retry.notice.text,
      }
    : undefined;

  let didRetry = false;
  let finalMessage: AssistantMessage;
  let didEmitAnyOutput = false;

  try {
    ({ finalMessage, didEmitAnyOutput } = yield* runAttempt(streamOptions));
  } catch (error) {
    if (retry?.shouldRetryAfterError?.({ error })) {
      didRetry = true;
      if (retryNotice) {
        yield retryNotice;
      }
      ({ finalMessage, didEmitAnyOutput } = yield* runAttempt({
        ...streamOptions,
        serviceTier: undefined,
      }));
    } else {
      throw error;
    }
  }

  if (!didRetry && retry?.shouldRetryAfterResponse?.({ finalMessage, didEmitAnyOutput }) === true) {
    didRetry = true;
    if (retryNotice) {
      yield retryNotice;
    }
    ({ finalMessage, didEmitAnyOutput } = yield* runAttempt({
      ...streamOptions,
      serviceTier: undefined,
    }));
  }

  return finalMessage;
}

export type RunToolCallsOptions = {
  toolCalls: ToolCall[];
  toolRegistry: ToolRegistry;
  enabledTools: Tool[];
  riskLevel: RiskLevel;
  signal: AbortSignal;
  dispatchContext?: ToolDispatchContext;
  toolErrorMessages?: {
    notEnabled?: (toolCall: ToolCall) => string;
    unsupported?: (toolCall: ToolCall) => string;
  };
};

export async function* runToolCalls(
  options: RunToolCallsOptions,
): AsyncGenerator<RunnerEvent, void, void> {
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
        `tool '${toolCall.name}' is not enabled for this session.`;
      const toolError = createToolError(toolCall, msg);
      resultsByIndex.set(i, toolError);
      yield { type: "notice", severity: "error", text: msg };
      continue;
    }

    const def = toolRegistry.get(toolCall.name);
    if (!def) {
      const msg =
        toolErrorMessages?.unsupported?.(toolCall) ??
        `tool '${toolCall.name}' is not supported by tau.`;
      const toolError = createToolError(toolCall, msg);
      resultsByIndex.set(i, toolError);
      yield { type: "notice", severity: "error", text: msg };
      continue;
    }

    validToolCalls.push({ index: i, toolCall, def });
  }

  // Step 2: Execute tools in original order, only parallelizing adjacent task/fork calls.
  const taskLikeToolNames = new Set(["task", "fork"]);

  let i = 0;
  while (i < validToolCalls.length && !signal.aborted) {
    const entry = validToolCalls[i]!;

    if (taskLikeToolNames.has(entry.toolCall.name)) {
      // Collect a contiguous block of task-like calls.
      const block: typeof validToolCalls = [];
      while (i < validToolCalls.length) {
        const nextEntry = validToolCalls[i]!;
        if (!taskLikeToolNames.has(nextEntry.toolCall.name)) break;
        block.push(nextEntry);
        i++;
      }

      interface TaskExecution {
        index: number;
        toolCall: ToolCall;
        startedUiEvent?: ToolUiEvent;
        uiEventsIterable?: AsyncIterable<ToolUiEvent>;
        runPromise: Promise<ToolDispatchResult>;
      }

      const taskExecutions: TaskExecution[] = [];

      for (const { index, toolCall, def } of block) {
        if (signal.aborted) break;

        const result = await def.dispatch(toolCall, riskLevel, signal, dispatchContext);

        if (result.kind === "phased") {
          taskExecutions.push({
            index,
            toolCall,
            startedUiEvent: result.startedUiEvent,
            uiEventsIterable: result.uiEvents,
            runPromise: result.run,
          });

          if (result.startedUiEvent) {
            yield { type: "tool_ui", uiEvent: result.startedUiEvent };
          }
        } else {
          // Single-phase task (unlikely but handle it).
          const { toolResult, uiEvent } = result;
          resultsByIndex.set(index, toolResult);
          if (uiEvent) {
            yield { type: "tool_ui", uiEvent };
          }
        }
      }

      if (taskExecutions.length > 0 && !signal.aborted) {
        yield* streamAndFinalizeTaskCalls(taskExecutions, resultsByIndex, signal);
      }

      continue;
    }

    // Non-task tools execute sequentially.
    const { index, toolCall, def } = entry;
    const result = await def.dispatch(toolCall, riskLevel, signal, dispatchContext);

    if (result.kind === "phased") {
      if (result.startedUiEvent) {
        yield { type: "tool_ui", uiEvent: result.startedUiEvent };
      }

      if (result.uiEvents) {
        for await (const uiEvent of result.uiEvents) {
          if (signal.aborted) break;
          yield { type: "tool_ui", uiEvent };
        }
      }

      const { toolResult, uiEvent } = await result.run;
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

    i++;
  }

  // Step 6: Append all results to conversation history in original order.
  for (let i = 0; i < toolCalls.length; i++) {
    const toolResult = resultsByIndex.get(i);
    if (toolResult) {
      yield { type: "tool_result", message: toolResult };
    }
  }
}

async function* streamAndFinalizeTaskCalls(
  taskExecutions: Array<{
    index: number;
    toolCall: ToolCall;
    uiEventsIterable?: AsyncIterable<ToolUiEvent>;
    runPromise: Promise<ToolDispatchResult>;
  }>,
  resultsByIndex: Map<number, ToolResultMessage>,
  signal: AbortSignal,
): AsyncGenerator<RunnerEvent, void, void> {
  type ToolUiIterator = AsyncIterator<ToolUiEvent>;

  type TaskExec = (typeof taskExecutions)[number];

  type PendingRace =
    | {
        kind: "ui";
        iterator: ToolUiIterator;
        taskExec: TaskExec;
        result: IteratorResult<ToolUiEvent>;
      }
    | {
        kind: "completion";
        taskExec: TaskExec;
        settled: PromiseSettledResult<ToolDispatchResult>;
      };

  const makeUiNext = (iterator: ToolUiIterator, taskExec: TaskExec): Promise<PendingRace> =>
    iterator
      .next()
      .then((result) => ({ kind: "ui", iterator, taskExec, result }) satisfies PendingRace)
      .catch(
        () =>
          ({
            kind: "ui",
            iterator,
            taskExec,
            result: { done: true, value: undefined } as IteratorResult<ToolUiEvent>,
          }) satisfies PendingRace,
      );

  const makeCompletion = (taskExec: TaskExec): Promise<PendingRace> =>
    taskExec.runPromise
      .then(
        (value) =>
          ({
            kind: "completion",
            taskExec,
            settled: { status: "fulfilled", value },
          }) satisfies PendingRace,
      )
      .catch(
        (reason) =>
          ({
            kind: "completion",
            taskExec,
            settled: { status: "rejected", reason },
          }) satisfies PendingRace,
      );

  const uiPending = new Map<ToolUiIterator, Promise<PendingRace>>();
  const completionPending = new Map<TaskExec, Promise<PendingRace>>();

  for (const taskExec of taskExecutions) {
    if (!taskExec.uiEventsIterable) {
      completionPending.set(taskExec, makeCompletion(taskExec));
      continue;
    }

    const iterator = taskExec.uiEventsIterable[Symbol.asyncIterator]();
    uiPending.set(iterator, makeUiNext(iterator, taskExec));
  }

  while ((uiPending.size > 0 || completionPending.size > 0) && !signal.aborted) {
    const next = await Promise.race<PendingRace>([
      ...uiPending.values(),
      ...completionPending.values(),
    ]);

    if (next.kind === "ui") {
      uiPending.delete(next.iterator);

      if (next.result.done) {
        if (!completionPending.has(next.taskExec)) {
          completionPending.set(next.taskExec, makeCompletion(next.taskExec));
        }
        continue;
      }

      yield { type: "tool_ui", uiEvent: next.result.value };

      if (!signal.aborted) {
        uiPending.set(next.iterator, makeUiNext(next.iterator, next.taskExec));
      }
      continue;
    }

    completionPending.delete(next.taskExec);

    if (next.settled.status === "fulfilled") {
      const { toolResult, uiEvent } = next.settled.value;
      resultsByIndex.set(next.taskExec.index, toolResult);
      if (uiEvent) {
        yield { type: "tool_ui", uiEvent };
      }
      continue;
    }

    const errorMsg =
      next.settled.reason instanceof Error
        ? next.settled.reason.message
        : String(next.settled.reason);
    const toolName = next.taskExec.toolCall.name;
    const toolError = createToolError(
      next.taskExec.toolCall,
      `${toolName} execution failed: ${errorMsg}`,
    );
    resultsByIndex.set(next.taskExec.index, toolError);
    yield {
      type: "notice",
      severity: "error",
      text: `${toolName} '${next.taskExec.toolCall.id}' execution failed: ${errorMsg}`,
    };
  }

  // Drain any remaining pending completions if signal was aborted.
  for (const [taskExec, promise] of completionPending.entries()) {
    const next = await promise;

    if (next.kind !== "completion") continue;

    if (next.settled.status === "fulfilled") {
      const { toolResult, uiEvent } = next.settled.value;
      resultsByIndex.set(taskExec.index, toolResult);
      if (uiEvent) {
        yield { type: "tool_ui", uiEvent };
      }
    } else {
      const errorMsg =
        next.settled.reason instanceof Error
          ? next.settled.reason.message
          : String(next.settled.reason);
      const toolName = taskExec.toolCall.name;
      const toolError = createToolError(
        taskExec.toolCall,
        `${toolName} execution failed: ${errorMsg}`,
      );
      resultsByIndex.set(taskExec.index, toolError);
      yield {
        type: "notice",
        severity: "error",
        text: `${toolName} '${taskExec.toolCall.id}' execution failed: ${errorMsg}`,
      };
    }
  }
}
