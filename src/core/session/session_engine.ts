import { randomUUID } from "node:crypto";
import type {
  AssistantMessage,
  Context,
  KnownProvider,
  Message,
  ToolCall,
} from "@mariozechner/pi-ai";
import type { Config } from "../config.js";
import { getApiKeyForProvider } from "../config.js";
import type { ToolDispatchContext, ToolRegistry } from "../tools/registry.js";
import type { Persona, RiskLevel } from "../types.js";
import { shouldRetryFlexAfterResponse } from "../utils/flex_retry.js";
import type { TauStreamOptions } from "../utils/streaming_settings.js";
import { parseStreamingSettings } from "../utils/streaming_settings.js";
import { type RunnerEvent, runModelSubturn, runToolCalls } from "./runner.js";

const MAX_ASSISTANT_SUBTURNS = 128;

export type EngineAssistantStartEvent = {
  type: "assistant_start";
};

export type EngineAssistantFinalEvent = {
  type: "assistant_final";
  message: AssistantMessage;
};

export type EngineEvent = RunnerEvent | EngineAssistantStartEvent | EngineAssistantFinalEvent;

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

      const enabledTools = this.getEnabledToolSchemas();
      const dispatchContext: ToolDispatchContext = {
        persona: this.persona,
        config: this.config,
        history: [...this.messages],
        systemPrompt: this.systemPrompt,
        toolRegistry: this.toolRegistry,
      };

      for await (const event of runToolCalls({
        toolCalls,
        toolRegistry: this.toolRegistry,
        enabledTools,
        riskLevel: this.riskLevel,
        signal,
        dispatchContext,
      })) {
        if (event.type === "tool_result") {
          this.messages.push(event.message);
        }
        yield event;
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

    try {
      const finalMessage = yield* runModelSubturn({
        model: this.persona.model,
        context,
        streamOptions: baseOptions,
        signal,
        emitPartials: true,
        retry: {
          notice: {
            text: "flex tier request failed, retrying without service tier.",
            severity: "info",
          },
          shouldRetryAfterResponse: ({ finalMessage, didEmitAnyOutput }) =>
            shouldRetryFlexAfterResponse({
              modelApi: this.persona.model.api,
              serviceTier: baseOptions.serviceTier,
              signal,
              didEmitAnyOutput,
              stopReason: finalMessage.stopReason,
            }),
        },
      });

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
