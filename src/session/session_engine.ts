import type {
  AssistantMessage,
  Context,
  KnownProvider,
  Message,
  SimpleStreamOptions,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { Config } from "../config.js";
import { getApiKeyForProvider } from "../config.js";
import { formatSubagentsForPrompt } from "../subagents/registry.js";
import type {
  ToolDefinition,
  ToolDispatchContext,
  ToolDispatchResult,
  ToolRegistry,
  ToolUiEvent,
} from "../tools/registry.js";
import type { Persona, RiskLevel } from "../types.js";
import { createToolError } from "../utils/messages.js";
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
  baseSystemPrompt: string;
  riskLevel: RiskLevel;
  toolRegistry: ToolRegistry;
  config?: Config;
};

export class SessionEngine {
  private persona: Persona;
  private baseSystemPrompt: string;
  private riskLevel: RiskLevel;
  private readonly toolRegistry: ToolRegistry;
  private config: Config;
  private messages: Message[] = [];

  constructor(options: SessionEngineOptions) {
    this.persona = options.persona;
    this.baseSystemPrompt = options.baseSystemPrompt;
    this.riskLevel = options.riskLevel;
    this.toolRegistry = options.toolRegistry;
    this.config = options.config ?? {};
  }

  reset(): void {
    this.messages = [];
  }

  setPersona(persona: Persona, baseSystemPrompt: string): void {
    this.persona = persona;
    this.baseSystemPrompt = baseSystemPrompt;
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

  addUserMessage(message: Message): void {
    this.messages.push(message);
  }

  get history(): readonly Message[] {
    return this.messages;
  }

  private getStreamingSettings(persona: Persona): SimpleStreamOptions {
    const merged = { ...persona.settings } as Record<string, unknown>;
    const reasoning = persona.settings.reasoning;

    // pi-ai uses undefined for "no reasoning".
    if (reasoning === undefined || reasoning === "none") {
      delete merged.reasoning;
    } else {
      merged.reasoning = reasoning;
    }

    return merged as unknown as SimpleStreamOptions;
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
    const tools = this.persona.tools ?? this.toolRegistry.schemas;

    let systemPrompt = this.baseSystemPrompt;
    const subagentInfo = formatSubagentsForPrompt(this.persona);
    if (subagentInfo) {
      systemPrompt += subagentInfo;
    }

    const context: Context = {
      systemPrompt,
      messages: this.messages,
      tools,
    };

    const apiKey = getApiKeyForProvider(this.config, this.persona.model.provider as KnownProvider);
    const stream = streamSimple(this.persona.model, context, {
      ...this.getStreamingSettings(this.persona),
      signal,
      ...(apiKey && { apiKey }),
    });

    const accumulator = new MessageAccumulator();
    try {
      for await (const event of stream) {
        accumulator.processEvent(event);
        if (event.type === "text_delta" || event.type.startsWith("thinking_")) {
          yield { type: "assistant_partial", snapshot: accumulator.snapshot };
        }
      }

      const finalMessage = await stream.result();
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
    const enabledTools = this.persona.tools ?? this.toolRegistry.schemas;
    const enabledToolNames = new Set(enabledTools.map((t) => t.name));
    const dispatchContext: ToolDispatchContext = { persona: this.persona, config: this.config };

    // Step 1: Validate all tools and create result buffer
    const resultsByIndex = new Map<number, ToolResultMessage>();
    const validToolCalls: Array<{ index: number; toolCall: ToolCall; def: ToolDefinition }> = [];

    for (let i = 0; i < toolCalls.length; i++) {
      if (signal.aborted) break;

      const toolCall = toolCalls[i]!;

      if (!enabledToolNames.has(toolCall.name)) {
        const msg = `tool '${toolCall.name}' is not enabled for the current persona.`;
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

    // Step 2: Separate task and non-task tools
    const taskCalls = validToolCalls.filter((v) => v.toolCall.name === "task");
    const nonTaskCalls = validToolCalls.filter((v) => v.toolCall.name !== "task");

    // Step 3: Start all task calls and begin streaming their UI
    interface TaskExecution {
      index: number;
      toolCall: ToolCall;
      startedUiEvent?: ToolUiEvent;
      uiEventsIterable?: AsyncIterable<ToolUiEvent>;
      runPromise: Promise<ToolDispatchResult>;
    }

    const taskExecutions: TaskExecution[] = [];

    for (const { index, toolCall, def } of taskCalls) {
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

    // Step 4: Stream task UI events in parallel and finalize each task as it completes.
    if (taskExecutions.length > 0 && !signal.aborted) {
      yield* this.streamAndFinalizeTaskCalls(taskExecutions, resultsByIndex, signal);
    }

    // Step 5: Execute non-task tools sequentially
    for (const { index, toolCall, def } of nonTaskCalls) {
      if (signal.aborted) break;

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
      const toolError = createToolError(
        next.taskExec.toolCall,
        `Task execution failed: ${errorMsg}`,
      );
      resultsByIndex.set(next.taskExec.index, toolError);
      yield {
        type: "notice",
        severity: "error",
        text: `Task '${next.taskExec.toolCall.id}' execution failed: ${errorMsg}`,
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
        const toolError = createToolError(
          next.taskExec.toolCall,
          `Task execution failed: ${errorMsg}`,
        );
        resultsByIndex.set(next.taskExec.index, toolError);
        yield {
          type: "notice",
          severity: "error",
          text: `Task '${next.taskExec.toolCall.id}' execution failed: ${errorMsg}`,
        };
      }
    }
  }
}
