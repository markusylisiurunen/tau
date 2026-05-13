import type { Message } from "@earendil-works/pi-ai";
import type { Config } from "../config/index.js";
import type { CoreEvent, CoreSubagentUiEvent } from "../events/types.js";
import type { CoreDeps } from "../runtime/deps.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Persona, RiskLevel } from "../types.js";
import {
  type HistoryEntry,
  type ProcessTurnResult,
  type RewindCandidate,
  type RewindResult,
  type SessionCompactionOptions,
  type SessionCompactionResult,
  SessionEngine,
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
};

export type CoreSessionOptions = {
  persona: Persona;
  systemPrompt: string;
  subagentPrompts: Record<string, string>;
  riskLevel: RiskLevel;
  toolRegistry: ToolRegistry;
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

  setRiskLevel(level: RiskLevel): void {
    this.engine.setRiskLevel(level);
  }

  setConfig(config: Config): void {
    this.engine.setConfig(config);
  }

  setPromptContext(context: { cwd?: string; home?: string; includeAgentContext?: boolean }): void {
    this.engine.setPromptContext(context);
  }

  onEvent(handler: (event: CoreEvent) => void): () => void {
    return this.engine.onEvent(handler);
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

  async compact(options: SessionCompactionOptions): Promise<SessionCompactionResult> {
    return await this.engine.compact(options);
  }

  async *events(signal: AbortSignal): AsyncGenerator<CoreEvent, ProcessTurnResult, void> {
    return yield* this.engine.processTurn(signal);
  }
}
