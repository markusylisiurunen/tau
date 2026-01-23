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
  ToolDispatchResultWithPhases,
  ToolRegistry,
} from "../tools/registry.js";
import type { RiskLevel } from "../types.js";
import { createToolError } from "../utils/messages.js";
import { streamModel } from "../utils/model_stream.js";
import type { TauStreamOptions } from "../utils/streaming_settings.js";
import { MessageAccumulator } from "./message_accumulator.js";

export type RunnerEvent = CoreRunnerEvent;

export type RetryOptions = {
  notice?: { text: string; severity?: CoreNoticeEvent["severity"] };
  shouldRetryAfterError?: (args: { error: unknown; model: Model<Api> }) => boolean;
  maxRetries?: number;
  delayMs?: number;
};

export type RunModelSubturnOptions = {
  model: Model<Api>;
  context: Context;
  streamOptions: TauStreamOptions;
  signal: AbortSignal;
  emitPartials?: boolean;
  retry?: RetryOptions;
};

export async function* runModelSubturn(
  options: RunModelSubturnOptions,
): AsyncGenerator<RunnerEvent, AssistantMessage, void> {
  const { model, context, streamOptions, signal, emitPartials = false, retry } = options;

  const runAttempt = async function* (
    attemptOptions: TauStreamOptions,
  ): AsyncGenerator<RunnerEvent, AssistantMessage, void> {
    const stream = streamModel(model, context, attemptOptions);
    const accumulator = emitPartials ? new MessageAccumulator() : undefined;

    for await (const event of stream) {
      if (accumulator) {
        accumulator.processEvent(event as AssistantMessageEvent);
      }

      if (event.type === "text_delta" || event.type.startsWith("thinking_")) {
        if (accumulator) {
          yield { type: "assistant_partial", snapshot: accumulator.snapshot };
        }
      }
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
        attempt < maxRetries &&
        retry?.shouldRetryAfterError?.({ error: result, model })
      ) {
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

  // Step 2: Execute tools in original order.
  for (const entry of validToolCalls) {
    if (signal.aborted) break;

    const { index, toolCall, def } = entry;
    let result: ToolDispatchResult | ToolDispatchResultWithPhases;
    try {
      result = await def.dispatch(toolCall, riskLevel, signal, dispatchContext);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const toolError = createToolError(toolCall, `${toolCall.name} dispatch failed: ${errorMsg}`);
      resultsByIndex.set(index, toolError);
      yield {
        type: "notice",
        severity: "error",
        text: `${toolCall.name} '${toolCall.id}' dispatch failed: ${errorMsg}`,
      };
      continue;
    }

    if (result.kind === "phased") {
      if (result.startedUiEvent) {
        yield { type: "tool_ui", uiEvent: result.startedUiEvent };
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
  }

  // Step 6: Append all results to conversation history in original order.
  for (let i = 0; i < toolCalls.length; i++) {
    const toolResult = resultsByIndex.get(i);
    if (toolResult) {
      yield { type: "tool_result", message: toolResult };
    }
  }
}
