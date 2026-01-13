import { randomUUID } from "node:crypto";
import type {
  AssistantMessage,
  Context,
  KnownProvider,
  Message,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { Config } from "../config.js";
import { getApiKeyForProvider } from "../config.js";
import type {
  ToolDefinition,
  ToolDispatchContext,
  ToolDispatchResult,
  ToolRegistry,
  ToolUiEvent,
} from "../tools/registry.js";
import type { Persona, RiskLevel } from "../types.js";
import { createToolError } from "../utils/messages.js";
import { streamModel } from "../utils/model_stream.js";
import type { TauStreamOptions } from "../utils/streaming_settings.js";
import { parseStreamingSettings } from "../utils/streaming_settings.js";
import { type AssistantPartialSnapshot, MessageAccumulator } from "./message_accumulator.js";

const MAX_ASSISTANT_SUBTURNS = 128;

export type EngineNoticeEvent = {
  type: "notice";
  severity: "info" | "warn" | "error";
  text: string;
};

export type EngineAssistantPartialEvent = {
  type: "assistant_partial";
  snapshot: AssistantPartialSnapshot;
};

export type EngineAssistantStartEvent = {
  type: "assistant_start";
};

export type EngineAssistantFinalEvent = {
  type: "assistant_final";
  message: AssistantMessage;
};

export type EngineToolUiEvent = {
  type: "tool_ui";
  uiEvent: ToolUiEvent;
};

export type EngineToolResultEvent = {
  type: "tool_result";
  message: ToolResultMessage;
};

export type EngineEvent =
  | EngineNoticeEvent
  | EngineAssistantStartEvent
  | EngineAssistantPartialEvent
  | EngineAssistantFinalEvent
  | EngineToolUiEvent
  | EngineToolResultEvent;

export type SessionEngineOptions = {
  persona: Persona;
  systemPrompt: string;
  riskLevel: RiskLevel;
  toolRegistry: ToolRegistry;
  config?: Config;
};

export class SessionEngine {
  private persona: Persona;
  private systemPrompt: string;
  private riskLevel: RiskLevel;
  private readonly toolRegistry: ToolRegistry;
  private config: Config;
  private messages: Message[] = [];
  private sessionId = `tau-main-${randomUUID()}`;

  constructor(options: SessionEngineOptions) {
    this.persona = options.persona;
    this.systemPrompt = options.systemPrompt;
    this.riskLevel = options.riskLevel;
    this.toolRegistry = options.toolRegistry;
    this.config = options.config ?? {};
  }

  reset(): void {
    this.messages = [];
    this.sessionId = `tau-main-${randomUUID()}`;
  }

  setPersona(persona: Persona, systemPrompt: string): void {
    this.persona = persona;
    this.systemPrompt = systemPrompt;
  }

  setRiskLevel(level: RiskLevel): void {
    this.riskLevel = level;
  }

  addUserText(textForModel: string): void {
    this.messages.push({
      role: "user",
      content: [{ type: "text", text: textForModel }],
      timestamp: Date.now(),
    });
  }

  addMessage(message: Message): void {
    this.messages.push(message);
  }

  get history(): readonly Message[] {
    return this.messages;
  }

  private getStreamingSettings(persona: Persona): TauStreamOptions {
    const merged = { ...persona.settings } as Record<string, unknown>;
    return parseStreamingSettings(merged);
  }

  private getEnabledToolSchemas() {
    return this.toolRegistry.getEnabledToolSchemas(this.riskLevel, this.persona.tools);
  }

  async *processTurn(signal: AbortSignal): AsyncGenerator<EngineEvent> {
    let subturns = 0;

    while (subturns < MAX_ASSISTANT_SUBTURNS && !signal.aborted) {
      subturns += 1;
      const { finalMessage } = yield* this.runSingleSubturn(signal);

      if (signal.aborted) {
        break;
      }

      if (!finalMessage || finalMessage.stopReason !== "toolUse") {
        break;
      }

      const toolCalls = finalMessage.content.filter((c): c is ToolCall => c.type === "toolCall");
      if (!toolCalls.length) {
        break;
      }

      yield* this.executeToolCalls(toolCalls, signal);
    }

    if (subturns >= MAX_ASSISTANT_SUBTURNS) {
      yield {
        type: "notice",
        severity: "warn",
        text: `stopped after ${MAX_ASSISTANT_SUBTURNS} tool subturns to avoid an infinite loop.`,
      };
    }
  }

  private async *runSingleSubturn(
    signal: AbortSignal,
  ): AsyncGenerator<EngineEvent, { finalMessage?: AssistantMessage }, void> {
    yield { type: "assistant_start" };
    const tools = this.getEnabledToolSchemas();

    const context: Context = {
      systemPrompt: this.systemPrompt,
      messages: this.messages,
      tools,
    };

    const apiKey = getApiKeyForProvider(this.config, this.persona.model.provider as KnownProvider);
    const baseOptions: TauStreamOptions = {
      ...this.getStreamingSettings(this.persona),
      signal,
      sessionId: this.sessionId,
      ...(apiKey && { apiKey }),
    };

    const model = this.persona.model;

    const runAttempt = async function* (
      options: TauStreamOptions,
    ): AsyncGenerator<
      EngineEvent,
      { finalMessage: AssistantMessage; didEmitAnyOutput: boolean },
      void
    > {
      const stream = streamModel(model, context, options);
      const accumulator = new MessageAccumulator();
      let didEmitAnyOutput = false;

      for await (const event of stream) {
        accumulator.processEvent(event);
        if (event.type === "text_delta" || event.type.startsWith("thinking_")) {
          didEmitAnyOutput = true;
          yield { type: "assistant_partial", snapshot: accumulator.snapshot };
        }
      }

      const finalMessage = await stream.result();
      return { finalMessage, didEmitAnyOutput };
    };

    const shouldRetryFlex = (
      options: TauStreamOptions,
      didEmitAnyOutput: boolean,
      msg?: AssistantMessage,
    ) =>
      this.persona.model.api === "openai-responses" &&
      options.serviceTier === "flex" &&
      !didEmitAnyOutput &&
      msg?.stopReason === "error" &&
      !signal.aborted;

    try {
      let { finalMessage, didEmitAnyOutput } = yield* runAttempt(baseOptions);

      if (shouldRetryFlex(baseOptions, didEmitAnyOutput, finalMessage)) {
        yield {
          type: "notice",
          severity: "info",
          text: "flex tier request failed, retrying without service tier.",
        };

        ({ finalMessage } = yield* runAttempt({
          ...baseOptions,
          serviceTier: undefined,
        }));
      }

      this.messages.push(finalMessage);
      yield { type: "assistant_final", message: finalMessage };
      return { finalMessage };
    } catch (err) {
      if (signal.aborted) {
        return { finalMessage: undefined };
      }
      throw err;
    }
  }

  private async *executeToolCalls(
    toolCalls: ToolCall[],
    signal: AbortSignal,
  ): AsyncGenerator<EngineEvent> {
    const enabledTools = this.getEnabledToolSchemas();
    const enabledToolNames = new Set(enabledTools.map((t) => t.name));
    const dispatchContext: ToolDispatchContext = {
      persona: this.persona,
      config: this.config,
      history: [...this.messages],
      systemPrompt: this.systemPrompt,
      toolRegistry: this.toolRegistry,
    };

    // Step 1: Validate all tools and create result buffer
    const resultsByIndex = new Map<number, ToolResultMessage>();
    const validToolCalls: Array<{ index: number; toolCall: ToolCall; def: ToolDefinition }> = [];

    for (let i = 0; i < toolCalls.length; i++) {
      if (signal.aborted) break;

      const toolCall = toolCalls[i]!;

      if (!enabledToolNames.has(toolCall.name)) {
        const msg = `tool '${toolCall.name}' is not enabled for the current risk level.`;
        const toolError = createToolError(toolCall, msg);
        resultsByIndex.set(i, toolError);
        yield { type: "notice", severity: "error", text: msg };
        continue;
      }

      const def = this.toolRegistry.get(toolCall.name);
      if (!def) {
        const msg = `tool '${toolCall.name}' is not supported by tau.`;
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

          const result = await def.dispatch(toolCall, this.riskLevel, signal, dispatchContext);

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
            // Single-phase task (unlikely but handle it)
            const { toolResult, uiEvent } = result;
            resultsByIndex.set(index, toolResult);
            if (uiEvent) {
              yield { type: "tool_ui", uiEvent };
            }
          }
        }

        if (taskExecutions.length > 0 && !signal.aborted) {
          yield* this.streamAndFinalizeTaskCalls(taskExecutions, resultsByIndex, signal);
        }

        continue;
      }

      // Non-task tools execute sequentially.
      const { index, toolCall, def } = entry;
      const result = await def.dispatch(toolCall, this.riskLevel, signal, dispatchContext);

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

    // Step 6: Append all results to conversation history in original order
    for (let i = 0; i < toolCalls.length; i++) {
      const toolResult = resultsByIndex.get(i);
      if (toolResult) {
        this.messages.push(toolResult);
        yield { type: "tool_result", message: toolResult };
      }
    }
  }

  private async *streamAndFinalizeTaskCalls(
    taskExecutions: Array<{
      index: number;
      toolCall: ToolCall;
      uiEventsIterable?: AsyncIterable<ToolUiEvent>;
      runPromise: Promise<ToolDispatchResult>;
    }>,
    resultsByIndex: Map<number, ToolResultMessage>,
    signal: AbortSignal,
  ): AsyncGenerator<EngineEvent> {
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

    // Drain any remaining pending completions if signal was aborted
    for (const [taskExec, promise] of completionPending.entries()) {
      const next = await promise;

      if (next.kind !== "completion") continue;

      if (next.settled.status === "fulfilled") {
        const { toolResult, uiEvent } = next.settled.value;
        resultsByIndex.set(next.taskExec.index, toolResult);
        if (uiEvent) {
          yield { type: "tool_ui", uiEvent };
        }
      } else {
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
    }
  }
}
