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
import type { ToolDispatchContext, ToolRegistry } from "../tools/registry.js";
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
  uiEvent: import("../tools/registry.js").ToolUiEvent;
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

      const enabledTools = this.persona.tools ?? this.toolRegistry.schemas;
      const enabledToolNames = new Set(enabledTools.map((t) => t.name));
      const dispatchContext: ToolDispatchContext = { persona: this.persona, config: this.config };

      for (const toolCall of toolCalls) {
        if (signal.aborted) break;

        if (!enabledToolNames.has(toolCall.name)) {
          const msg = `tool '${toolCall.name}' is not enabled for the current persona.`;
          const toolError = createToolError(toolCall, msg);
          this.messages.push(toolError);
          yield { type: "notice", severity: "error", text: msg };
          continue;
        }

        const def = this.toolRegistry.get(toolCall.name);
        if (!def) {
          const msg = `tool '${toolCall.name}' is not supported by tau.`;
          const toolError = createToolError(toolCall, msg);
          this.messages.push(toolError);
          yield { type: "notice", severity: "error", text: msg };
          continue;
        }

        const result = await def.dispatch(toolCall, this.riskLevel, signal, dispatchContext);

        // Check if this is a two-phase result
        if (result.kind === "phased") {
          // Two-phase: emit started UI immediately if present
          if (result.startedUiEvent) {
            yield { type: "tool_ui", uiEvent: result.startedUiEvent };
          }

          // If the tool provides streaming UI updates, emit them while it runs.
          const runPromise = result.run;
          if (result.uiEvents) {
            for await (const uiEvent of result.uiEvents) {
              if (signal.aborted) break;
              yield { type: "tool_ui", uiEvent };
            }
          }

          // Wait for the actual execution to complete
          const { toolResult, uiEvent } = await runPromise;
          this.messages.push(toolResult);
          yield { type: "tool_result", message: toolResult };
          if (uiEvent) {
            yield { type: "tool_ui", uiEvent };
          }
        } else {
          // Single-phase: behave as before
          const { toolResult, uiEvent } = result;
          this.messages.push(toolResult);
          yield { type: "tool_result", message: toolResult };
          if (uiEvent) {
            yield { type: "tool_ui", uiEvent };
          }
        }
      }
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
}
