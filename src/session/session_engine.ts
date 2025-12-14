import type {
  AssistantMessage,
  Context,
  KnownProvider,
  Message,
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

const MAX_ASSISTANT_SUBTURNS = 64;

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

  private getStreamingSettings(persona: Persona) {
    const settings = { ...persona.settings };
    // ChatApp already clamps persona.reasoning to allowed values; keep engine minimal.
    if (settings.reasoning === undefined) {
      delete (settings as Record<string, unknown>).reasoning;
    }
    return settings;
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

    // Step 4: Multiplex task UI events in parallel
    if (taskExecutions.length > 0 && !signal.aborted) {
      yield* this.multiplexTaskUiEvents(taskExecutions, signal);
    }

    // Step 5: Wait for all task runs to settle before starting non-task tools
    if (taskExecutions.length > 0 && !signal.aborted) {
      const runPromises = taskExecutions.map((te) => te.runPromise);
      const results = await Promise.allSettled(runPromises);

      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        const taskExec = taskExecutions[i]!;

        if (result.status === "fulfilled") {
          const { toolResult, uiEvent } = result.value;
          resultsByIndex.set(taskExec.index, toolResult);
          if (uiEvent) {
            yield { type: "tool_ui", uiEvent };
          }
        } else {
          // Task promise rejected; create error result
          const errorMsg =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          const toolError = createToolError(
            taskExec.toolCall,
            `Task execution failed: ${errorMsg}`,
          );
          resultsByIndex.set(taskExec.index, toolError);
          yield {
            type: "notice",
            severity: "error",
            text: `Task '${taskExec.toolCall.id}' execution failed: ${errorMsg}`,
          };
        }
      }
    }

    // Step 6: Execute non-task tools sequentially
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

    // Step 7: Append all results to conversation history in original order
    for (let i = 0; i < toolCalls.length; i++) {
      const toolResult = resultsByIndex.get(i);
      if (toolResult) {
        this.messages.push(toolResult);
        yield { type: "tool_result", message: toolResult };
      }
    }
  }

  private async *multiplexTaskUiEvents(
    taskExecutions: Array<{
      uiEventsIterable?: AsyncIterable<ToolUiEvent>;
    }>,
    signal: AbortSignal,
  ): AsyncGenerator<EngineEvent> {
    const iterables = taskExecutions
      .filter((te) => te.uiEventsIterable)
      .map((te) => te.uiEventsIterable!);

    if (iterables.length === 0) {
      return;
    }

    type ToolUiIterator = AsyncIterator<ToolUiEvent>;

    const makeNext = (iterator: ToolUiIterator) =>
      iterator
        .next()
        .then((result) => ({ iterator, result }))
        .catch(() => ({
          iterator,
          result: { done: true, value: undefined } as IteratorResult<ToolUiEvent>,
        }));

    const pending = new Map<ToolUiIterator, ReturnType<typeof makeNext>>();

    for (const iterable of iterables) {
      const iterator = iterable[Symbol.asyncIterator]();
      pending.set(iterator, makeNext(iterator));
    }

    while (pending.size > 0 && !signal.aborted) {
      const { iterator, result } = await Promise.race([...pending.values()]);
      pending.delete(iterator);

      if (result.done) {
        continue;
      }

      yield { type: "tool_ui", uiEvent: result.value };

      if (!signal.aborted) {
        pending.set(iterator, makeNext(iterator));
      }
    }
  }
}
