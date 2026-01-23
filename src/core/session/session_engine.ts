import { randomUUID } from "node:crypto";
import type {
  AssistantMessage,
  Context,
  KnownProvider,
  Message,
  ToolCall,
} from "@mariozechner/pi-ai";
import { formatCodexAuthError } from "../auth/auth_messages.js";
import { getAuthPath } from "../auth/auth_paths.js";
import { AuthStorage } from "../auth/auth_storage.js";
import { type CredentialResolver, createCredentialResolver } from "../auth/credential_resolver.js";
import type { Config } from "../config/index.js";
import type { CoreEvent } from "../events/types.js";
import type { CoreDeps } from "../runtime/deps.js";
import { createDefaultCoreDeps } from "../runtime/deps.js";
import type { ToolDispatchContext, ToolRegistry } from "../tools/registry.js";
import type { Persona, RiskLevel } from "../types.js";
import { shouldAutoRetry } from "../utils/auto_retry.js";
import { CODEX_ORIGINATOR, CODEX_USER_AGENT } from "../utils/codex.js";
import type { TauStreamOptions } from "../utils/streaming_settings.js";
import { parseStreamingSettings } from "../utils/streaming_settings.js";
import { runModelSubturn, runToolCalls } from "./runner.js";

const MAX_ASSISTANT_SUBTURNS = 200;

export type SessionEngineOptions = {
  persona: Persona;
  systemPrompt: string;
  riskLevel: RiskLevel;
  toolRegistry: ToolRegistry;
  config?: Config;
  deps?: CoreDeps;
};

export class SessionEngine {
  private persona: Persona;
  private systemPrompt: string;
  private riskLevel: RiskLevel;
  private readonly toolRegistry: ToolRegistry;
  private config: Config;
  private readonly deps: CoreDeps;
  private readonly credentialResolver: CredentialResolver;
  private readonly authPath: string;
  private messages: Message[] = [];
  private sessionId = `tau-main-${randomUUID()}`;

  constructor(options: SessionEngineOptions) {
    this.persona = options.persona;
    this.systemPrompt = options.systemPrompt;
    this.riskLevel = options.riskLevel;
    this.toolRegistry = options.toolRegistry;
    this.config = options.config ?? {};
    this.deps = options.deps ?? createDefaultCoreDeps();
    this.authPath = getAuthPath(this.deps.env.home());
    const authStorage = new AuthStorage(this.authPath);
    this.credentialResolver = createCredentialResolver({
      authStorage,
      getConfig: () => this.config,
    });
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

  setConfig(config: Config): void {
    this.config = config;
  }

  addUserText(textForModel: string): void {
    this.messages.push({
      role: "user",
      content: [{ type: "text", text: textForModel }],
      timestamp: this.deps.clock.now(),
    });
  }

  addMessage(message: Message): void {
    this.messages.push(message);
  }

  get history(): readonly Message[] {
    return this.messages;
  }

  get sessionIdValue(): string {
    return this.sessionId;
  }

  private getStreamingSettings(persona: Persona): TauStreamOptions {
    const merged = { ...persona.settings } as Record<string, unknown>;
    return parseStreamingSettings(merged);
  }

  private getEnabledToolSchemas() {
    return this.toolRegistry.getEnabledToolSchemas(this.persona.tools);
  }

  async *processTurn(signal: AbortSignal): AsyncGenerator<CoreEvent> {
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
        authPath: this.authPath,
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
  ): AsyncGenerator<CoreEvent, { finalMessage?: AssistantMessage }, void> {
    yield { type: "assistant_start" };
    const tools = this.getEnabledToolSchemas();

    const context: Context = {
      systemPrompt: this.systemPrompt,
      messages: this.messages,
      tools,
    };

    let apiKey: string | undefined;
    try {
      apiKey = await this.credentialResolver.getApiKey(
        this.persona.model.provider as KnownProvider,
        { sessionId: this.sessionId },
      );
    } catch (error) {
      if (this.persona.model.provider === "openai-codex") {
        throw new Error(formatCodexAuthError(this.authPath, (error as Error)?.message));
      }
      throw error;
    }

    if (!apiKey && this.persona.model.provider === "openai-codex") {
      throw new Error(formatCodexAuthError(this.authPath));
    }
    const baseOptions: TauStreamOptions = {
      ...this.getStreamingSettings(this.persona),
      signal,
      sessionId: this.sessionId,
      ...(apiKey && { apiKey }),
    };

    if (this.persona.model.provider === "openai-codex") {
      baseOptions.headers = {
        ...baseOptions.headers,
        originator: CODEX_ORIGINATOR,
        "User-Agent": CODEX_USER_AGENT,
      };
    }

    try {
      const finalMessage = yield* runModelSubturn({
        model: this.persona.model,
        context,
        streamOptions: baseOptions,
        signal,
        emitPartials: true,
        retry: {
          shouldRetryAfterError: ({ error, model }) => shouldAutoRetry({ model, error }),
          maxRetries: 1,
          delayMs: 3000,
          notice: { text: "auto-retrying after transient error", severity: "warn" },
        },
      });

      this.messages.push(finalMessage);
      yield { type: "assistant_final", message: finalMessage };
      return { finalMessage };
    } catch (err) {
      if (!signal.aborted) {
        try {
          await this.credentialResolver.noteProviderError?.(
            this.persona.model.provider as KnownProvider,
            {
              sessionId: this.sessionId,
              error: err,
            },
          );
        } catch {}
      }
      if (signal.aborted) {
        return { finalMessage: undefined };
      }
      throw err;
    }
  }
}
