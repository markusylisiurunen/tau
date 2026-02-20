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
import { prependModelNotice, resolveModelNotice } from "../utils/model_notices.js";
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
  cwd?: string;
  hostCwd?: string;
  home?: string;
  includeAgentContext?: boolean;
  sandboxEnabled?: boolean;
};

export type SessionCompactionOptions = {
  mode: SessionCompactionMode;
  guidance?: string;
  signal?: AbortSignal;
};

export type SessionCompactionResult = {
  compactionMessage: string;
  includedLastAssistant: boolean;
};

export type HistoryEntry = {
  id: string;
  message: Message;
};

export type RewindCandidate = {
  historyEntryId: string;
  text: string;
};

export type RewindResult = {
  historyEntryId: string;
  text: string;
  removedEntryIds: string[];
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
  private cwd: string;
  private hostCwd: string;
  private home: string;
  private includeAgentContext: boolean;
  private sandboxEnabled: boolean;
  private readonly subagentControlPlane: SubagentControlPlane;
  private readonly eventListeners = new Set<(event: CoreEvent) => void>();
  private historyEntries: HistoryEntry[] = [];
  private sessionId = `tau-main-${randomUUID()}`;

  constructor(options: SessionEngineOptions) {
    this.persona = options.persona;
    this.systemPrompt = options.systemPrompt;
    this.subagentPrompts = options.subagentPrompts;
    this.riskLevel = options.riskLevel;
    this.toolRegistry = options.toolRegistry;
    this.config = options.config ?? {};
    this.deps = options.deps ?? createDefaultCoreDeps();
    this.cwd = options.cwd ?? this.deps.env.cwd();
    this.hostCwd = options.hostCwd ?? this.deps.env.cwd();
    this.home = options.home ?? this.deps.env.home();
    this.includeAgentContext = options.includeAgentContext ?? true;
    this.sandboxEnabled = options.sandboxEnabled ?? false;
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
    this.historyEntries = [];
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

  setPromptContext(context: {
    cwd?: string;
    hostCwd?: string;
    home?: string;
    includeAgentContext?: boolean;
    sandboxEnabled?: boolean;
  }): void {
    if (context.cwd !== undefined) {
      this.cwd = context.cwd;
    }
    if (context.hostCwd !== undefined) {
      this.hostCwd = context.hostCwd;
    }
    if (context.home !== undefined) {
      this.home = context.home;
    }
    if (context.includeAgentContext !== undefined) {
      this.includeAgentContext = context.includeAgentContext;
    }
    if (context.sandboxEnabled !== undefined) {
      this.sandboxEnabled = context.sandboxEnabled;
    }
  }

  onEvent(handler: (event: CoreEvent) => void): () => void {
    this.eventListeners.add(handler);
    return () => this.eventListeners.delete(handler);
  }

  async terminateSubagent(id: string): Promise<boolean> {
    const result = await this.subagentControlPlane.terminate(id);
    return Boolean(result);
  }

  addUserText(textForModel: string, options?: { historyEntryId?: string }): string {
    const textWithModelNotice = prependModelNotice(
      textForModel,
      resolveModelNotice(this.config, this.persona.model),
    );

    return this.addMessage(
      {
        role: "user",
        content: [{ type: "text", text: textWithModelNotice }],
        timestamp: this.deps.clock.now(),
      },
      options,
    );
  }

  addMessage(message: Message, options?: { historyEntryId?: string }): string {
    const entry = this.appendHistoryEntry(message, options?.historyEntryId);
    return entry.id;
  }

  replaceMessage(index: number, message: Message): boolean {
    if (index < 0 || index >= this.historyEntries.length) {
      return false;
    }
    const current = this.historyEntries[index];
    if (!current) {
      throw new Error(`history entry missing at index ${index}`);
    }
    this.historyEntries[index] = { ...current, message };
    return true;
  }

  listRewindCandidates(): RewindCandidate[] {
    return this.historyEntries.flatMap((entry) => {
      if (entry.message.role !== "user") {
        return [];
      }
      return [{ historyEntryId: entry.id, text: this.extractRewindUserText(entry.message) }];
    });
  }

  rewindToHistoryEntryId(historyEntryId: string): RewindResult | undefined {
    const historyIndex = this.historyEntries.findIndex((entry) => entry.id === historyEntryId);
    if (historyIndex < 0) {
      return undefined;
    }

    const entry = this.historyEntries[historyIndex];
    if (!entry) {
      throw new Error(`history entry missing at index ${historyIndex}`);
    }
    if (entry.message.role !== "user") {
      return undefined;
    }

    const removedEntryIds = this.historyEntries.slice(historyIndex).map((item) => item.id);
    this.historyEntries = this.historyEntries.slice(0, historyIndex);

    return {
      historyEntryId: entry.id,
      text: this.extractRewindUserText(entry.message),
      removedEntryIds,
    };
  }

  get history(): readonly Message[] {
    return this.historyEntries.map((entry) => entry.message);
  }

  get historyEntriesSnapshot(): readonly HistoryEntry[] {
    return this.historyEntries;
  }

  get sessionIdValue(): string {
    return this.sessionId;
  }

  async compact(options: SessionCompactionOptions): Promise<SessionCompactionResult> {
    const preparation = prepareSessionCompaction(this.history);
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
      {
        reasoning: "high",
        sessionId: `tau-summary-${randomUUID()}`,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(apiKey && { apiKey }),
      },
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

  private appendHistoryEntry(message: Message, preferredId?: string): HistoryEntry {
    const id = this.createHistoryEntryId(preferredId);
    const entry: HistoryEntry = { id, message };
    this.historyEntries.push(entry);
    return entry;
  }

  private createHistoryEntryId(preferredId?: string): string {
    if (preferredId !== undefined) {
      const preferred = preferredId.trim();
      if (!preferred) {
        throw new Error("history entry id must not be empty");
      }
      if (this.historyEntries.some((entry) => entry.id === preferred)) {
        throw new Error(`history entry id '${preferred}' already exists`);
      }
      return preferred;
    }

    let generated = `history-${randomUUID()}`;
    while (this.historyEntries.some((entry) => entry.id === generated)) {
      generated = `history-${randomUUID()}`;
    }
    return generated;
  }

  private extractUserText(message: Message): string {
    if (typeof message.content === "string") {
      return message.content.trim();
    }

    const parts: string[] = [];
    for (const block of message.content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block.type === "text") {
        parts.push(block.text ?? "");
      }
    }

    return parts.join("\n\n").trim();
  }

  private extractRewindUserText(message: Message): string {
    return this.stripLeadingSystemNotices(this.extractUserText(message));
  }

  private stripLeadingSystemNotices(text: string): string {
    let remaining = text.trim();

    while (remaining.startsWith("<system>")) {
      const end = remaining.indexOf("</system>");
      if (end < 0) {
        break;
      }
      remaining = remaining.slice(end + "</system>".length).trimStart();
    }

    return remaining.trim();
  }

  private emitSubagentEvent(event: SubagentUiEvent): void {
    const subagentId = this.getSubagentEventId(event);
    const originHistoryEntryId = this.subagentControlPlane.getOriginHistoryEntryId(subagentId);
    const coreEvent: CoreSubagentUiEvent = {
      type: "subagent_ui",
      event,
      originHistoryEntryId,
    };
    this.emitEvent(coreEvent);
  }

  private emitEvent(event: CoreEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private getSubagentEventId(event: SubagentUiEvent): string {
    switch (event.type) {
      case "subagent_spawned":
      case "subagent_finished":
        return event.state.id;
      case "subagent_progress":
      case "subagent_emit_output":
      case "subagent_abort_requested":
        return event.id;
    }
  }

  private getCurrentTurnUserHistoryEntryId(): string {
    for (let i = this.historyEntries.length - 1; i >= 0; i -= 1) {
      const entry = this.historyEntries[i]!;
      if (entry.message.role === "user") {
        return entry.id;
      }
    }

    throw new Error("cannot process turn without a user history entry");
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
    const turnUserHistoryEntryId = this.getCurrentTurnUserHistoryEntryId();

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
        history: [...this.history],
        systemPrompt: this.systemPrompt,
        riskLevel: this.riskLevel,
        turnUserHistoryEntryId,
        cwd: this.cwd,
        hostCwd: this.hostCwd,
        home: this.home,
        includeAgentContext: this.includeAgentContext,
        sandboxEnabled: this.sandboxEnabled,
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
          const historyEntryId = this.addMessage(event.message, {
            historyEntryId: event.message.toolCallId,
          });
          const coreEvent: CoreEvent = {
            ...event,
            historyEntryId,
          };
          this.emitEvent(coreEvent);
          yield coreEvent;
          continue;
        }
        this.emitEvent(event);
        yield event;
      }
    }

    if (subturns >= MAX_ASSISTANT_SUBTURNS) {
      const event: CoreEvent = {
        type: "notice",
        severity: "warn",
        text: `stopped after ${MAX_ASSISTANT_SUBTURNS} tool subturns to avoid an infinite loop.`,
      };
      this.emitEvent(event);
      yield event;
    }
  }

  private async *runSingleSubturn(
    signal: AbortSignal,
  ): AsyncGenerator<CoreEvent, { finalMessage?: AssistantMessage }, void> {
    const historyEntryId = this.createHistoryEntryId();
    const startEvent: CoreEvent = { type: "assistant_start", historyEntryId };
    this.emitEvent(startEvent);
    yield startEvent;
    const tools = this.getEnabledToolSchemas();

    const context: Context = {
      systemPrompt: this.systemPrompt,
      messages: [...this.history],
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
      const stream = runModelSubturn({
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

      let finalMessage: AssistantMessage | undefined;
      while (true) {
        const next = await stream.next();
        if (next.done) {
          finalMessage = next.value;
          break;
        }

        if (next.value.type === "assistant_partial") {
          const event: CoreEvent = {
            type: "assistant_partial",
            historyEntryId,
            snapshot: next.value.snapshot,
          };
          this.emitEvent(event);
          yield event;
          continue;
        }

        this.emitEvent(next.value);
        yield next.value;
      }

      if (!finalMessage) {
        return { finalMessage: undefined };
      }

      this.addMessage(finalMessage, { historyEntryId });
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
      const event: CoreEvent = { type: "assistant_final", historyEntryId, message: finalMessage };
      this.emitEvent(event);
      yield event;
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
