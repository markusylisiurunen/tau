import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
  type AssistantMessage,
  type Context,
  cleanupSessionResources,
  type Message,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { getAuthPath } from "../auth/auth_paths.js";
import { AuthStorage } from "../auth/auth_storage.js";
import {
  type Config,
  type NormalizedAutoCompactConfig,
  normalizeAutoCompactConfig,
} from "../config/index.js";
import { resolveConfigLevels } from "../config/paths.js";
import type { CoreCompactionResult, CoreEvent, CoreSubagentUiEvent } from "../events/types.js";
import { loadModelResolver, type ModelResolver } from "../models/catalog.js";
import type { CoreDeps } from "../runtime/deps.js";
import { createDefaultCoreDeps } from "../runtime/deps.js";
import { SubagentControlPlane } from "../subagents/control_plane.js";
import type { SubagentUiEvent } from "../subagents/types.js";
import type { ToolDefinition, ToolDispatchContext, ToolRegistry } from "../tools/registry.js";
import { TOOL_NAME_NOOK } from "../tools/tool_names.js";
import type { Persona, ReasoningEffort } from "../types.js";
import { appendUsageLogEntry, getUsageCostTotal, getUsageTotals } from "../usage/logs.js";
import { shouldAutoRetry } from "../utils/auto_retry.js";
import { CODEX_ORIGINATOR, CODEX_USER_AGENT } from "../utils/codex.js";
import { buildCompactionUserMessage } from "../utils/compact.js";
import { extractAssistantText } from "../utils/messages.js";
import { prependModelNotice, resolveModelNotice } from "../utils/model_notices.js";
import { ModelRuntime } from "../utils/model_stream.js";
import type { TauStreamOptions } from "../utils/streaming_settings.js";
import { parseStreamingSettings } from "../utils/streaming_settings.js";
import {
  getAutoCompactionMetadataFromMessage,
  hasAutoCompactionContinuationMetadata,
  prependTauUserMetadata,
  stripTauUserDisplayText,
  stripTauUserMetadata,
  stripTauUserMetadataFromMessage,
} from "../utils/user_metadata.js";
import {
  buildAutoCompactionContinuationMessage,
  buildAutoCompactionPrompt,
  buildCompactionSummary,
  buildSessionCompactionMessage,
  buildSessionCompactionPrompt,
  COMPACTION_SUMMARIZATION_SYSTEM_PROMPT,
  parseCompactionSummaryResponse,
  prepareAutoCompaction,
  prepareSessionCompaction,
  type SessionCompactionMode,
} from "./compaction.js";
import {
  buildSmartPruneSystemPrompt,
  clampPruneReasoning,
  parseSmartPruneResponse,
  prepareSessionSmartPrunePrompt,
  pruneSessionHistory,
  type SessionPruneOptions,
  type SessionPruneResult,
} from "./pruning.js";
import { runModelSubturn, runToolCalls } from "./runner.js";

const MAX_ASSISTANT_SUBTURNS = 200;

export type SessionEngineOptions = {
  persona: Persona;
  systemPrompt: string;
  subagentPrompts: Record<string, string>;
  toolRegistry: ToolRegistry;
  clientToolDefinitions?: (sessionId: string) => ToolDefinition[];
  config?: Config;
  deps?: CoreDeps;
  cwd?: string;
  home?: string;
  includeAgentContext?: boolean;
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

export type { SessionPruneOptions, SessionPruneResult };

export type AutoCompactionBlockedTurn = {
  reason: "auto-compaction-failed";
  message: string;
};

export type ProcessTurnResult = {
  aborted: boolean;
  blocked?: AutoCompactionBlockedTurn;
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

type SessionTurnSettings = {
  persona: Persona;
  streamOptions: TauStreamOptions;
  reasoningEffort: ReasoningEffort | "none";
  clientToolDefinitions: ToolDefinition[];
};

export class SessionEngine {
  private persona: Persona;
  private systemPrompt: string;
  private subagentPrompts: Record<string, string>;
  private readonly toolRegistry: ToolRegistry;
  private readonly clientToolDefinitions?: (sessionId: string) => ToolDefinition[];
  private config: Config;
  private readonly deps: CoreDeps;
  private readonly authPath: string;
  private readonly modelRuntime: ModelRuntime;
  private cwd: string;
  private home: string;
  private includeAgentContext: boolean;
  private modelResolver: ModelResolver;
  private readonly subagentControlPlane: SubagentControlPlane;
  private readonly eventListeners = new Set<(event: CoreEvent) => void>();
  private readonly subagentEventListeners = new Set<(event: CoreSubagentUiEvent) => void>();
  private historyEntries: HistoryEntry[] = [];
  private sessionId: string = randomUUID();

  constructor(options: SessionEngineOptions) {
    this.persona = options.persona;
    this.systemPrompt = options.systemPrompt;
    this.subagentPrompts = options.subagentPrompts;
    this.toolRegistry = options.toolRegistry;
    this.clientToolDefinitions = options.clientToolDefinitions;
    this.config = options.config ?? {};
    this.deps = options.deps ?? createDefaultCoreDeps();
    this.cwd = options.cwd ?? this.deps.env.cwd();
    this.home = options.home ?? this.deps.env.home();
    this.includeAgentContext = options.includeAgentContext ?? true;
    this.modelResolver = this.createDispatchModelResolver();
    this.authPath = getAuthPath(this.deps.env.home());
    this.modelRuntime = new ModelRuntime({
      authStorage: new AuthStorage(this.authPath),
      getConfig: () => this.config,
      authPath: this.authPath,
      env: this.deps.env.env(),
    });
    this.subagentControlPlane = new SubagentControlPlane({
      onEvent: (event) => this.emitSubagentEvent(event),
    });
  }

  reset(): void {
    this.closeProviderSessions();
    this.historyEntries = [];
    this.sessionId = randomUUID();
    this.subagentControlPlane.reset();
  }

  restoreState(input: { sessionId: string; historyEntries: readonly HistoryEntry[] }): void {
    this.closeProviderSessions();
    this.historyEntries = input.historyEntries.map((entry) => ({
      id: entry.id,
      message: structuredClone(entry.message),
    }));
    this.sessionId = input.sessionId;
    this.subagentControlPlane.reset();
  }

  private replaceHistoryEntries(entries: readonly HistoryEntry[]): void {
    this.closeProviderSessions();
    this.historyEntries = entries.map((entry) => ({
      id: entry.id,
      message: structuredClone(entry.message),
    }));
  }

  dispose(): void {
    this.closeProviderSessions();
    this.subagentControlPlane.reset();
  }

  private closeProviderSessions(): void {
    cleanupSessionResources(this.sessionId);
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

  setReasoning(reasoning: ReasoningEffort): void {
    this.persona = {
      ...this.persona,
      settings: {
        ...this.persona.settings,
        reasoning,
      },
    };
  }

  setConfig(config: Config): void {
    this.config = config;
    this.modelResolver = this.createDispatchModelResolver();
  }

  setPromptContext(context: { cwd?: string; home?: string; includeAgentContext?: boolean }): void {
    if (context.cwd !== undefined) {
      this.cwd = context.cwd;
    }
    if (context.home !== undefined) {
      this.home = context.home;
    }
    if (context.includeAgentContext !== undefined) {
      this.includeAgentContext = context.includeAgentContext;
    }

    this.modelResolver = this.createDispatchModelResolver();
  }

  onEvent(handler: (event: CoreEvent) => void): () => void {
    this.eventListeners.add(handler);
    return () => this.eventListeners.delete(handler);
  }

  onSubagentEvent(handler: (event: CoreSubagentUiEvent) => void): () => void {
    this.subagentEventListeners.add(handler);
    return () => this.subagentEventListeners.delete(handler);
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

  replaceMessageById(historyEntryId: string, message: Message): boolean {
    const index = this.historyEntries.findIndex((entry) => entry.id === historyEntryId);
    if (index < 0) {
      return false;
    }
    this.historyEntries[index] = { ...this.historyEntries[index]!, message };
    return true;
  }

  listRewindCandidates(): RewindCandidate[] {
    return this.historyEntries.flatMap((entry, index) => {
      if (entry.message.role !== "user" || !this.isVisibleRewindCandidate(index)) {
        return [];
      }
      return [{ historyEntryId: entry.id, text: this.extractRewindUserText(entry.message) }];
    });
  }

  private isVisibleRewindCandidate(index: number): boolean {
    const entry = this.historyEntries[index];
    if (!entry || hasAutoCompactionContinuationMetadata(entry.message)) {
      return false;
    }

    for (let i = index - 1; i >= 0; i -= 1) {
      const message = this.historyEntries[i]!.message;
      if (hasAutoCompactionContinuationMetadata(message)) {
        return true;
      }
      const metadata = getAutoCompactionMetadataFromMessage(message);
      if (metadata) {
        return false;
      }
    }

    return true;
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
    if (entry.message.role !== "user" || hasAutoCompactionContinuationMetadata(entry.message)) {
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
    return this.visibleHistoryEntries.map((entry) =>
      structuredClone(stripTauUserMetadataFromMessage(entry.message)),
    );
  }

  private get modelHistory(): readonly Message[] {
    return this.historyEntries.map((entry) => stripTauUserMetadataFromMessage(entry.message));
  }

  private get visibleHistoryEntries(): readonly HistoryEntry[] {
    return this.historyEntries.filter(
      (entry) => !hasAutoCompactionContinuationMetadata(entry.message),
    );
  }

  get rawHistory(): readonly Message[] {
    return this.historyEntries.map((entry) => structuredClone(entry.message));
  }

  get rawHistoryEntriesSnapshot(): readonly HistoryEntry[] {
    return this.historyEntries.map((entry) => ({
      id: entry.id,
      message: structuredClone(entry.message),
    }));
  }

  get historyEntriesSnapshot(): readonly HistoryEntry[] {
    return this.visibleHistoryEntries.map((entry) => ({
      ...entry,
      message: structuredClone(stripTauUserMetadataFromMessage(entry.message)),
    }));
  }

  get sessionIdValue(): string {
    return this.sessionId;
  }

  async compact(options: SessionCompactionOptions): Promise<SessionCompactionResult> {
    const preparation = prepareSessionCompaction(this.historyEntries, {
      systemPrompt: this.systemPrompt,
    });
    if (!preparation) {
      throw new Error("no conversation to compact.");
    }

    const summaryPrompt = buildSessionCompactionPrompt({
      preparation,
      guidance: options.guidance,
    });

    const summaryResponse = await this.runCompactionSummary(summaryPrompt, {
      sessionId: `summary-${randomUUID()}`,
      signal: options.signal,
    });
    const summaryResult = parseCompactionSummaryResponse({
      response: summaryResponse,
      userMessageCandidates: preparation.userMessageCandidates,
    });

    const { compactionMessage, includedLastAssistant } = buildSessionCompactionMessage({
      summary: summaryResult.summary,
      mode: options.mode,
      messagesToSummarize: preparation.messagesToSummarize,
      preservedUserMessages: summaryResult.preservedUserMessages,
    });

    const textWithModelNotice = prependModelNotice(
      compactionMessage,
      resolveModelNotice(this.config, this.persona.model),
    );
    const textWithMetadata = prependTauUserMetadata(textWithModelNotice, [
      {
        type: "compaction",
        version: 1,
        summary: summaryResult.summary,
        preservedUserMessages: summaryResult.preservedUserMessages,
      },
    ]);

    const summaryEntry: HistoryEntry = {
      id: this.createHistoryEntryId(),
      message: {
        role: "user",
        content: [{ type: "text", text: textWithMetadata }],
        timestamp: this.deps.clock.now(),
      },
    };
    this.replaceHistoryEntries([summaryEntry]);

    return {
      compactionMessage,
      includedLastAssistant,
    };
  }

  async pruneToolResults(
    options: Omit<SessionPruneOptions, "smartSelection"> & { signal?: AbortSignal },
  ): Promise<SessionPruneResult> {
    let smartSelection: string[] | undefined;
    if (options.strategy === "smart") {
      const request = prepareSessionSmartPrunePrompt({
        historyEntries: this.historyEntries,
        fraction: options.fraction,
        ...(options.guidance !== undefined ? { guidance: options.guidance } : {}),
      });
      smartSelection = request
        ? await this.runSmartPruneSelection(request.prompt, { signal: options.signal })
        : [];
    }

    return pruneSessionHistory({
      historyEntries: this.historyEntries,
      replaceMessageById: (historyEntryId, message) =>
        this.replaceMessageById(historyEntryId, message),
      options: {
        strategy: options.strategy,
        fraction: options.fraction,
        ...(options.guidance !== undefined ? { guidance: options.guidance } : {}),
        ...(smartSelection !== undefined ? { smartSelection } : {}),
      },
    });
  }

  private async runSmartPruneSelection(
    prompt: string,
    options: { signal?: AbortSignal },
  ): Promise<string[]> {
    const reasoning = this.clampSmartPruneReasoning(this.persona.settings.reasoning);
    const stream = this.modelRuntime.streamModel(
      this.persona.model,
      {
        systemPrompt: buildSmartPruneSystemPrompt(),
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: this.deps.clock.now(),
          },
        ],
      },
      {
        ...(reasoning ? { reasoning } : {}),
        sessionId: `prune-${randomUUID()}`,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );

    const final = await stream.result();
    const raw = extractAssistantText(final).trim();
    const parsed = parseSmartPruneResponse(raw);
    if (!parsed) {
      throw new Error("model returned an invalid prune selection.");
    }

    return parsed;
  }

  private clampSmartPruneReasoning(
    reasoning?: ReasoningEffort,
  ): Exclude<ReasoningEffort, "none"> | undefined {
    return clampPruneReasoning(reasoning);
  }

  private async runCompactionSummary(
    summaryPrompt: string,
    options: { sessionId: string; signal?: AbortSignal },
  ): Promise<string> {
    const stream = this.modelRuntime.streamModel(
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
        sessionId: options.sessionId,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );

    const final = await stream.result();
    const summary = extractAssistantText(final).trim();
    if (!summary) {
      throw new Error("summarization returned an empty response.");
    }

    return summary;
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
      return stripTauUserMetadata(message.content);
    }

    const parts: string[] = [];
    for (const block of message.content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block.type === "text") {
        parts.push(block.text ?? "");
      }
    }

    return stripTauUserMetadata(parts.join("\n\n"));
  }

  private extractRewindUserText(message: Message): string {
    return stripTauUserDisplayText(this.extractUserText(message));
  }

  private emitSubagentEvent(event: SubagentUiEvent): void {
    const subagentId = this.getSubagentEventId(event);
    const originHistoryEntryId = this.subagentControlPlane.getOriginHistoryEntryId(subagentId);
    const coreEvent: CoreSubagentUiEvent = {
      type: "subagent_ui",
      event,
      originHistoryEntryId,
    };
    for (const listener of this.subagentEventListeners) {
      listener(coreEvent);
    }
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

  private captureTurnSettings(): SessionTurnSettings {
    const persona = {
      ...this.persona,
      settings: { ...this.persona.settings },
    };
    return {
      persona,
      streamOptions: this.getStreamingSettings(persona),
      reasoningEffort: persona.settings.reasoning ?? "none",
      clientToolDefinitions: this.clientToolDefinitions?.(this.sessionId) ?? [],
    };
  }

  private getEnabledToolSchemas(
    persona: Persona = this.persona,
    clientToolDefinitions: ToolDefinition[] = [],
  ) {
    const schemas = this.toolRegistry.getEnabledToolSchemas(persona.tools);
    const existingNames = new Set(schemas.map((tool) => tool.name));
    const configuredToolDefinitions = this.getConfiguredToolDefinitions().filter(
      (definition) => !existingNames.has(definition.schema.name),
    );
    const extraDefinitions = [...configuredToolDefinitions, ...clientToolDefinitions];
    if (extraDefinitions.length === 0) {
      return schemas;
    }

    const clientSchemas = extraDefinitions.map((definition) => definition.schema);
    for (const schema of clientSchemas) {
      if (existingNames.has(schema.name)) {
        throw new Error(`duplicate tool '${schema.name}'`);
      }
      existingNames.add(schema.name);
    }

    return [...schemas, ...clientSchemas];
  }

  private getConfiguredToolDefinitions(): ToolDefinition[] {
    if (!this.config.nook) {
      return [];
    }

    const nook = this.toolRegistry.get(TOOL_NAME_NOOK);
    return nook ? [nook] : [];
  }

  private createDispatchModelResolver(): ModelResolver {
    const cwd = this.cwd || this.deps.env.cwd();
    const home = this.home || this.deps.env.home() || cwd;

    const deps = {
      fs: {
        readFile: (path: string) => readFileSync(path, "utf-8"),
        exists: (path: string) => existsSync(path),
        listDir: (path: string) => readdirSync(path),
        stat: (path: string) => statSync(path),
      },
      env: {
        getEnv: () => this.deps.env.env(),
        cwd: () => cwd,
        home: () => home,
      },
    };
    const levels = resolveConfigLevels(deps, { cwd });

    return loadModelResolver({ deps, levels }).resolveModel;
  }

  async *processTurn(
    signal: AbortSignal,
    options?: { shouldStopAtBoundary?: () => boolean },
  ): AsyncGenerator<CoreEvent, ProcessTurnResult, void> {
    let subturns = 0;
    let autoCompactionAttempted = false;
    const originHistoryEntryId = this.getCurrentTurnUserHistoryEntryId();
    const turnSettings = this.captureTurnSettings();

    while (subturns < MAX_ASSISTANT_SUBTURNS && !signal.aborted) {
      if (!autoCompactionAttempted && this.shouldRunAutoCompaction()) {
        autoCompactionAttempted = true;
        const compactionResult = yield* this.runAutoCompactionIfNeeded(signal);
        if (compactionResult.blocked || compactionResult.aborted) {
          return compactionResult;
        }
      }

      subturns += 1;
      const { finalMessage } = yield* this.runSingleSubturn(signal, turnSettings);

      if (signal.aborted) {
        break;
      }

      if (finalMessage?.stopReason !== "toolUse") {
        break;
      }

      const toolCalls = finalMessage.content.filter((c): c is ToolCall => c.type === "toolCall");
      if (!toolCalls.length) {
        break;
      }

      const enabledTools = this.getEnabledToolSchemas(
        turnSettings.persona,
        turnSettings.clientToolDefinitions,
      );
      const dispatchContext: ToolDispatchContext = {
        scope: "main",
        persona: turnSettings.persona,
        config: this.config,
        originHistoryEntryId,
        cwd: this.cwd,
        home: this.home,
        includeAgentContext: this.includeAgentContext,
        subagentPrompts: this.subagentPrompts,
        toolRegistry: this.toolRegistry,
        modelResolver: this.modelResolver,
        authPath: this.authPath,
        subagentControlPlane: this.subagentControlPlane,
      };

      for await (const event of runToolCalls({
        toolCalls,
        toolRegistry: this.toolRegistry,
        extraToolDefinitions: [
          ...this.getConfiguredToolDefinitions(),
          ...turnSettings.clientToolDefinitions,
        ],
        enabledTools,
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

      if (options?.shouldStopAtBoundary?.()) {
        break;
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

    return { aborted: signal.aborted };
  }

  private async *runAutoCompactionIfNeeded(
    signal: AbortSignal,
  ): AsyncGenerator<CoreEvent, ProcessTurnResult, void> {
    if (!this.shouldRunAutoCompaction()) {
      return { aborted: signal.aborted };
    }

    const startEvent: CoreEvent = { type: "compaction_start", reason: "threshold" };
    this.emitEvent(startEvent);
    yield startEvent;

    try {
      const result = await this.runAutoCompaction(signal);
      if (!result) {
        const endEvent: CoreEvent = {
          type: "compaction_end",
          reason: "threshold",
          outcome: "skipped",
        };
        this.emitEvent(endEvent);
        yield endEvent;
        return { aborted: false };
      }

      const endEvent: CoreEvent = {
        type: "compaction_end",
        reason: "threshold",
        outcome: "compacted",
        result,
      };
      this.emitEvent(endEvent);
      yield endEvent;
      return { aborted: false };
    } catch (error) {
      if (signal.aborted) {
        const endEvent: CoreEvent = {
          type: "compaction_end",
          reason: "threshold",
          outcome: "aborted",
        };
        this.emitEvent(endEvent);
        yield endEvent;
        return { aborted: true };
      }

      const message = error instanceof Error ? error.message : String(error);
      const endEvent: CoreEvent = {
        type: "compaction_end",
        reason: "threshold",
        outcome: "failed",
        errorMessage: message,
      };
      this.emitEvent(endEvent);
      yield endEvent;
      return {
        aborted: false,
        blocked: {
          reason: "auto-compaction-failed",
          message,
        },
      };
    }
  }

  private async runAutoCompaction(signal: AbortSignal): Promise<CoreCompactionResult | undefined> {
    const settings = this.getAutoCompactConfig();
    const preparation = prepareAutoCompaction(this.historyEntries, {
      keepRecentTokens: Math.min(
        settings.keepRecentTokens,
        this.getAutoCompactionThresholdTokens(settings),
      ),
      systemPrompt: this.systemPrompt,
    });
    if (!preparation) {
      return undefined;
    }

    const summaryResponse = await this.runCompactionSummary(
      buildAutoCompactionPrompt(preparation),
      {
        sessionId: `auto-summary-${randomUUID()}`,
        signal,
      },
    );
    const summaryResult = parseCompactionSummaryResponse({
      response: summaryResponse,
      userMessageCandidates: preparation.userMessageCandidates,
    });

    const compactionSummary = buildCompactionSummary({
      summary: summaryResult.summary,
      preservedUserMessages: summaryResult.preservedUserMessages,
    });
    const compactionMessage = buildCompactionUserMessage({ summary: compactionSummary });
    const retainedMessageCount = preparation.retainedEntries.length;
    const modelNotice = resolveModelNotice(this.config, this.persona.model);
    const textWithModelNotice = prependModelNotice(compactionMessage, modelNotice);
    const textWithMetadata = prependTauUserMetadata(textWithModelNotice, [
      {
        type: "auto-compaction",
        version: 1,
        summary: summaryResult.summary,
        preservedUserMessages: summaryResult.preservedUserMessages,
        cutType: preparation.cutType,
        retainedMessageCount,
      },
    ]);

    const summaryEntry: HistoryEntry = {
      id: this.createHistoryEntryId(),
      message: {
        role: "user",
        content: [{ type: "text", text: textWithMetadata }],
        timestamp: this.deps.clock.now(),
      },
    };
    const continuationEntry: HistoryEntry = {
      id: this.createHistoryEntryId(),
      message: buildAutoCompactionContinuationMessage({
        cutType: preparation.cutType,
        now: this.deps.clock.now(),
        modelNotice,
        subagentStatus: this.formatAutoCompactionSubagentStatus(),
      }),
    };

    this.replaceHistoryEntries([summaryEntry, ...preparation.retainedEntries, continuationEntry]);

    return {
      summaryHistoryEntryId: summaryEntry.id,
      continuationHistoryEntryId: continuationEntry.id,
      compactionMessage,
      cutType: preparation.cutType,
      retainedMessageCount,
    };
  }

  private formatAutoCompactionSubagentStatus(): string | undefined {
    const running = this.subagentControlPlane
      .listSnapshots()
      .filter((snapshot) => snapshot.status === "running");
    if (running.length === 0) {
      return undefined;
    }

    return running
      .map((snapshot) => {
        const abort = snapshot.abortRequested ? ", abort requested" : "";
        return `- ${snapshot.id}: ${snapshot.title} (name: ${snapshot.name}, status: ${snapshot.status}${abort})`;
      })
      .join("\n");
  }

  private shouldRunAutoCompaction(): boolean {
    const settings = this.getAutoCompactConfig();
    if (!settings.enabled) {
      return false;
    }

    const thresholdTokens = this.getAutoCompactionThresholdTokens(settings);
    if (thresholdTokens <= 0) {
      return false;
    }

    const usageTokens = this.getLatestFreshContextUsageTokens();
    return usageTokens !== undefined && usageTokens > thresholdTokens;
  }

  private getAutoCompactionThresholdTokens(settings: NormalizedAutoCompactConfig): number {
    return (this.persona.model.contextWindow ?? 0) - settings.reserveTokens;
  }

  private getAutoCompactConfig(): NormalizedAutoCompactConfig {
    return normalizeAutoCompactConfig(this.config.autoCompact);
  }

  private getLatestFreshContextUsageTokens(): number | undefined {
    const boundaryIndex = this.findLatestAutoCompactionContinuationIndex();
    for (let index = this.historyEntries.length - 1; index > boundaryIndex; index -= 1) {
      const message = this.historyEntries[index]!.message;
      if (message.role !== "assistant") {
        continue;
      }
      const usage = (message as AssistantMessage).usage;
      if (!usage) {
        return undefined;
      }
      return (
        (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0)
      );
    }

    return undefined;
  }

  private findLatestAutoCompactionContinuationIndex(): number {
    for (let index = this.historyEntries.length - 1; index >= 0; index -= 1) {
      if (hasAutoCompactionContinuationMetadata(this.historyEntries[index]!.message)) {
        return index;
      }
    }

    return -1;
  }

  private async noteCurrentProviderError(message?: string): Promise<void> {
    try {
      await this.modelRuntime.noteProviderError(this.persona.model.provider, {
        sessionId: this.sessionId,
        error: message ? new Error(message) : undefined,
      });
    } catch {}
  }

  private async *runSingleSubturn(
    signal: AbortSignal,
    turnSettings: SessionTurnSettings,
  ): AsyncGenerator<CoreEvent, { finalMessage?: AssistantMessage }, void> {
    const historyEntryId = this.createHistoryEntryId();
    const startEvent: CoreEvent = { type: "assistant_start", historyEntryId };
    this.emitEvent(startEvent);
    yield startEvent;
    const tools = this.getEnabledToolSchemas(
      turnSettings.persona,
      turnSettings.clientToolDefinitions,
    );

    const context: Context = {
      systemPrompt: this.systemPrompt,
      messages: [...this.modelHistory],
      tools,
    };

    const baseOptions: TauStreamOptions = {
      ...turnSettings.streamOptions,
      signal,
      sessionId: this.sessionId,
    };

    if (turnSettings.persona.model.provider === "openai-codex") {
      baseOptions.headers = {
        ...baseOptions.headers,
        originator: CODEX_ORIGINATOR,
        "User-Agent": CODEX_USER_AGENT,
      };
    }

    try {
      const stream = runModelSubturn({
        model: turnSettings.persona.model,
        modelRuntime: this.modelRuntime,
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

      if (finalMessage.stopReason === "error") {
        await this.noteCurrentProviderError(finalMessage.errorMessage);
      }

      this.addMessage(finalMessage, { historyEntryId });
      appendUsageLogEntry({
        timestamp: finalMessage.timestamp,
        sessionId: this.sessionId,
        personaId: turnSettings.persona.id,
        provider: finalMessage.provider,
        model: finalMessage.model,
        api: finalMessage.api,
        reasoningEffort: turnSettings.reasoningEffort,
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
        await this.noteCurrentProviderError(err instanceof Error ? err.message : String(err));
      }
      if (signal.aborted) {
        return { finalMessage: undefined };
      }
      throw err;
    }
  }
}
