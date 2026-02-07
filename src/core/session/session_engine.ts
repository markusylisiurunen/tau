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
import type { CoreEvent, CoreSubagentUiEvent } from "../events/types.js";
import type { CoreDeps } from "../runtime/deps.js";
import { createDefaultCoreDeps } from "../runtime/deps.js";
import { SubagentControlPlane } from "../subagents/control_plane.js";
import type { SubagentUiEvent } from "../subagents/types.js";
import type { ToolDispatchContext, ToolRegistry } from "../tools/registry.js";
import type { Persona, RiskLevel } from "../types.js";
import { appendUsageLogEntry, getUsageCostTotal, getUsageTotals } from "../usage/logs.js";
import { shouldAutoRetry } from "../utils/auto_retry.js";
import { CODEX_ORIGINATOR, CODEX_USER_AGENT } from "../utils/codex.js";
import { extractAssistantText } from "../utils/messages.js";
import { streamModel } from "../utils/model_stream.js";
import type { TauStreamOptions } from "../utils/streaming_settings.js";
import { parseStreamingSettings } from "../utils/streaming_settings.js";
import {
  buildSessionCompactionMessage,
  buildSessionCompactionPrompt,
  COMPACTION_SUMMARIZATION_SYSTEM_PROMPT,
  prepareSessionCompaction,
  type SessionCompactionMode,
} from "./compaction.js";
import { runModelSubturn, runToolCalls } from "./runner.js";

const MAX_ASSISTANT_SUBTURNS = 200;

export type SessionEngineOptions = {
  persona: Persona;
  systemPrompt: string;
  subagentPrompts: Record<string, string>;
  riskLevel: RiskLevel;
  toolRegistry: ToolRegistry;
  config?: Config;
  deps?: CoreDeps;
};

export type SessionCompactionOptions = {
  mode: SessionCompactionMode;
  guidance?: string;
};

export type SessionCompactionResult = {
  compactionMessage: string;
  includedLastAssistant: boolean;
};

export class SessionEngine {
  private persona: Persona;
  private systemPrompt: string;
  private subagentPrompts: Record<string, string>;
  private riskLevel: RiskLevel;
  private readonly toolRegistry: ToolRegistry;
  private config: Config;
  private readonly deps: CoreDeps;
  private readonly credentialResolver: CredentialResolver;
  private readonly authPath: string;
  private readonly subagentControlPlane: SubagentControlPlane;
  private readonly subagentListeners = new Set<(event: CoreSubagentUiEvent) => void>();
  private messages: Message[] = [];
  private sessionId = `tau-main-${randomUUID()}`;

  constructor(options: SessionEngineOptions) {
    this.persona = options.persona;
    this.systemPrompt = options.systemPrompt;
    this.subagentPrompts = options.subagentPrompts;
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
    this.subagentControlPlane = new SubagentControlPlane({
      onEvent: (event) => this.emitSubagentEvent(event),
    });
  }

  reset(): void {
    this.messages = [];
    this.sessionId = `tau-main-${randomUUID()}`;
    this.subagentControlPlane.reset();
  }

  setPersona(
    persona: Persona,
    systemPrompt: string,
    subagentPrompts: Record<string, string>,
  ): void {
    this.persona = persona;
    this.systemPrompt = systemPrompt;
    this.subagentPrompts = subagentPrompts;
  }

  setRiskLevel(level: RiskLevel): void {
    this.riskLevel = level;
  }

  setConfig(config: Config): void {
    this.config = config;
  }

  onSubagentEvent(handler: (event: CoreSubagentUiEvent) => void): () => void {
    this.subagentListeners.add(handler);
    return () => this.subagentListeners.delete(handler);
  }

  async terminateSubagent(id: string): Promise<boolean> {
    const result = await this.subagentControlPlane.terminate(id);
    return Boolean(result);
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

  replaceMessage(index: number, message: Message): boolean {
    if (index < 0 || index >= this.messages.length) {
      return false;
    }
    this.messages[index] = message;
    return true;
  }

  get history(): readonly Message[] {
    return this.messages;
  }

  get sessionIdValue(): string {
    return this.sessionId;
  }

  async compact(options: SessionCompactionOptions): Promise<SessionCompactionResult> {
    const preparation = prepareSessionCompaction(this.messages);
    if (!preparation) {
      throw new Error("no conversation to compact.");
    }

    const summaryPrompt = buildSessionCompactionPrompt({
      preparation,
      guidance: options.guidance,
    });

    const apiKey = await this.resolveApiKeyForCurrentPersona();
    const stream = streamModel(
      this.persona.model,
      {
        systemPrompt: COMPACTION_SUMMARIZATION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: summaryPrompt }],
            timestamp: this.deps.clock.now(),
          },
        ],
      },
      { reasoning: "high", sessionId: `tau-summary-${randomUUID()}`, ...(apiKey && { apiKey }) },
    );

    const final = await stream.result();
    const summary = extractAssistantText(final).trim();
    if (!summary) {
      throw new Error("summarization returned an empty response.");
    }

    const { compactionMessage, includedLastAssistant } = buildSessionCompactionMessage({
      summary,
      mode: options.mode,
      messagesToSummarize: preparation.messagesToSummarize,
    });

    this.reset();
    this.addUserText(compactionMessage);

    return {
      compactionMessage,
      includedLastAssistant,
    };
  }

  private emitSubagentEvent(event: SubagentUiEvent): void {
    const coreEvent: CoreSubagentUiEvent = { type: "subagent_ui", event };
    for (const listener of this.subagentListeners) {
      listener(coreEvent);
    }
  }

  private getStreamingSettings(persona: Persona): TauStreamOptions {
    const merged = { ...persona.settings } as Record<string, unknown>;
    return parseStreamingSettings(merged);
  }

  private getEnabledToolSchemas() {
    return this.toolRegistry.getEnabledToolSchemas(this.persona.tools);
  }

  private async resolveApiKeyForCurrentPersona(): Promise<string | undefined> {
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

    return apiKey;
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
        riskLevel: this.riskLevel,
        subagentPrompts: this.subagentPrompts,
        toolRegistry: this.toolRegistry,
        authPath: this.authPath,
        subagentControlPlane: this.subagentControlPlane,
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

    const apiKey = await this.resolveApiKeyForCurrentPersona();
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
      appendUsageLogEntry({
        timestamp: finalMessage.timestamp,
        sessionId: this.sessionId,
        personaId: this.persona.id,
        provider: finalMessage.provider,
        model: finalMessage.model,
        api: finalMessage.api,
        reasoningEffort: this.persona.settings.reasoning ?? "none",
        usage: getUsageTotals(finalMessage.usage),
        cost: { total: getUsageCostTotal(finalMessage.usage) },
        agent: { type: "main" },
      });
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
