import type { Message } from "@earendil-works/pi-ai";
import type { Config } from "../config/index.js";
import type { CoreEvent, CoreSubagentUiEvent } from "../events/types.js";
import type { ModelResolver } from "../models/catalog.js";
import type { CoreDeps } from "../runtime/deps.js";
import type { ResolveSubagentRuntime, ToolDefinition, ToolRegistry } from "../tools/registry.js";
import type { Persona, ReasoningEffort } from "../types.js";
import {
  type HistoryEntry,
  type ProcessTurnResult,
  type RewindCandidate,
  type RewindResult,
  type SessionCompactionOptions,
  type SessionCompactionResult,
  SessionEngine,
  type SessionPruneOptions,
  type SessionPruneResult,
  type SessionSampleOptions,
} from "./session_engine.js";

export type {
  CoreEvent,
  CoreSubagentUiEvent,
  HistoryEntry,
  ProcessTurnResult,
  RewindCandidate,
  RewindResult,
  SessionCompactionOptions,
  SessionCompactionResult,
  SessionPruneOptions,
  SessionPruneResult,
  SessionSampleOptions,
};

export type CoreSessionOptions = {
  persona: Persona;
  systemPrompt: string;
  subagentPrompts: Record<string, string>;
  toolRegistry: ToolRegistry;
  clientToolDefinitions?: (sessionId: string) => ToolDefinition[];
  modelResolver: ModelResolver;
  resolveSubagentRuntime?: ResolveSubagentRuntime;
  config?: Config;
  deps?: CoreDeps;
  cwd?: string;
  home?: string;
  includeAgentContext?: boolean;
};

export class CoreSession {
  private readonly engine: SessionEngine;

  constructor(options: CoreSessionOptions) {
    this.engine = new SessionEngine(options);
  }

  reset(): void {
    this.engine.reset();
  }

  restoreState(input: { sessionId: string; historyEntries: readonly HistoryEntry[] }): void {
    this.engine.restoreState(input);
  }

  dispose(): void {
    this.engine.dispose();
  }

  setPersona(
    persona: Persona,
    systemPrompt: string,
    subagentPrompts: Record<string, string>,
  ): void {
    this.engine.setPersona(persona, systemPrompt, subagentPrompts);
  }

  setReasoning(reasoning: ReasoningEffort): void {
    this.engine.setReasoning(reasoning);
  }

  setRuntimeConfig(config: Config, modelResolver: ModelResolver): void {
    this.engine.setRuntimeConfig(config, modelResolver);
  }

  setPromptContext(context: { cwd?: string; home?: string; includeAgentContext?: boolean }): void {
    this.engine.setPromptContext(context);
  }

  onEvent(handler: (event: CoreEvent) => void): () => void {
    return this.engine.onEvent(handler);
  }

  onSubagentEvent(handler: (event: CoreSubagentUiEvent) => void): () => void {
    return this.engine.onSubagentEvent(handler);
  }

  hasSubagent(id: string): boolean {
    return this.engine.hasSubagent(id);
  }

  async terminateSubagent(id: string): Promise<boolean> {
    return await this.engine.terminateSubagent(id);
  }

  addUserText(textForModel: string, options?: { historyEntryId?: string }): string {
    return this.engine.addUserText(textForModel, options);
  }

  addMessage(message: Message, options?: { historyEntryId?: string }): string {
    return this.engine.addMessage(message, options);
  }

  replaceMessage(index: number, message: Message): boolean {
    return this.engine.replaceMessage(index, message);
  }

  replaceMessageById(historyEntryId: string, message: Message): boolean {
    return this.engine.replaceMessageById(historyEntryId, message);
  }

  listRewindCandidates(): RewindCandidate[] {
    return this.engine.listRewindCandidates();
  }

  rewindToHistoryEntryId(historyEntryId: string): RewindResult | undefined {
    return this.engine.rewindToHistoryEntryId(historyEntryId);
  }

  get history(): readonly Message[] {
    return this.engine.history;
  }

  get rawHistory(): readonly Message[] {
    return this.engine.rawHistory;
  }

  get rawHistoryEntries(): readonly HistoryEntry[] {
    return this.engine.rawHistoryEntriesSnapshot;
  }

  get historyEntries(): readonly HistoryEntry[] {
    return this.engine.historyEntriesSnapshot;
  }

  get sessionId(): string {
    return this.engine.sessionIdValue;
  }

  async sample(options: SessionSampleOptions) {
    return await this.engine.sample(options);
  }

  async compact(options: SessionCompactionOptions): Promise<SessionCompactionResult> {
    return await this.engine.compact(options);
  }

  async pruneToolResults(
    options: Omit<SessionPruneOptions, "smartSelection"> & { signal?: AbortSignal },
  ): Promise<SessionPruneResult> {
    return await this.engine.pruneToolResults(options);
  }

  async *events(
    signal: AbortSignal,
    options?: { shouldStopAtBoundary?: () => boolean },
  ): AsyncGenerator<CoreEvent, ProcessTurnResult, void> {
    return yield* this.engine.processTurn(signal, options);
  }
}
