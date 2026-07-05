import type {
  SessionProtocolAutocompletePathsParams,
  SessionProtocolAutocompletePathsResult,
  SessionProtocolClientToolCallMessage,
  SessionProtocolClientToolCancelMessage,
  SessionProtocolClientToolDefinition,
  SessionProtocolCompactParams,
  SessionProtocolCompactResult,
  SessionProtocolCreateParams,
  SessionProtocolDeltaMessage,
  SessionProtocolEphemeralCloseParams,
  SessionProtocolEphemeralCloseResult,
  SessionProtocolEphemeralCreateParams,
  SessionProtocolEphemeralCreateResult,
  SessionProtocolEphemeralMessage,
  SessionProtocolEphemeralSubmitParams,
  SessionProtocolEphemeralSubmitResult,
  SessionProtocolExecParams,
  SessionProtocolExecResult,
  SessionProtocolPruneParams,
  SessionProtocolPruneResult,
  SessionProtocolRecordParams,
  SessionProtocolRecordResult,
  SessionProtocolReloadResult,
  SessionProtocolResolvePromptParams,
  SessionProtocolResolvePromptResult,
  SessionProtocolRewindParams,
  SessionProtocolRewindResult,
  SessionProtocolSessionSummary,
  SessionProtocolSetPersonaParams,
  SessionProtocolSetReasoningParams,
  SessionProtocolSetRiskParams,
  SessionProtocolSettingsUpdateResult,
  SessionProtocolSnapshot,
  SessionProtocolTerminateSubagentResult,
  SessionProtocolUserMessageTurnResult,
} from "../protocol/session_protocol.js";

export type TauHostedSession = {
  readonly sessionId: string;
  readonly isDisposed?: boolean;
  readonly isTurnRunning: boolean;
  onDelta(handler: (delta: SessionProtocolDeltaMessage) => void): () => void;
  onEphemeral(handler: (message: SessionProtocolEphemeralMessage) => void): () => void;
  record(
    options: Omit<SessionProtocolRecordParams, "sessionId">,
  ): Promise<SessionProtocolRecordResult>;
  runTurn(): Promise<SessionProtocolUserMessageTurnResult["turn"]>;
  interruptTurn(): boolean;
  requestTurnBoundaryStop(): boolean;
  exec(
    options: Omit<SessionProtocolExecParams, "sessionId"> & {
      signal?: AbortSignal;
    },
  ): Promise<SessionProtocolExecResult>;
  setRiskLevel(level: SessionProtocolSetRiskParams["riskLevel"]): Promise<SessionProtocolSnapshot>;
  setReasoning(
    reasoning: SessionProtocolSetReasoningParams["reasoning"],
  ): Promise<SessionProtocolSettingsUpdateResult>;
  setPersona(
    personaId: SessionProtocolSetPersonaParams["personaId"],
  ): Promise<SessionProtocolSnapshot>;
  resolvePrompt(
    promptId: SessionProtocolResolvePromptParams["promptId"],
  ): Promise<SessionProtocolResolvePromptResult>;
  autocompletePaths(
    options: Omit<SessionProtocolAutocompletePathsParams, "sessionId">,
  ): Promise<SessionProtocolAutocompletePathsResult>;
  reload(): Promise<SessionProtocolReloadResult>;
  compact(
    options: Omit<SessionProtocolCompactParams, "sessionId">,
  ): Promise<SessionProtocolCompactResult>;
  pruneToolResults(
    options: Omit<SessionProtocolPruneParams, "sessionId">,
  ): Promise<SessionProtocolPruneResult>;
  rewindToHistoryEntryId(
    historyEntryId: SessionProtocolRewindParams["historyEntryId"],
  ): Promise<SessionProtocolRewindResult>;
  terminateSubagent(subagentId: string): Promise<SessionProtocolTerminateSubagentResult>;
  createEphemeralContext(
    options: Omit<SessionProtocolEphemeralCreateParams, "sessionId">,
  ): Promise<SessionProtocolEphemeralCreateResult>;
  submitEphemeralThread(
    options: Omit<SessionProtocolEphemeralSubmitParams, "sessionId">,
  ): Promise<SessionProtocolEphemeralSubmitResult>;
  closeEphemeralContext(
    contextId: SessionProtocolEphemeralCloseParams["contextId"],
  ): Promise<SessionProtocolEphemeralCloseResult>;
  snapshot(): Promise<SessionProtocolSnapshot>;
  dispose(): Promise<void>;
};

export type TauSessionHost = {
  createSession(input: SessionProtocolCreateParams): Promise<TauHostedSession>;
  observeSession(sessionId: string): Promise<TauHostedSession | undefined>;
  listSessions(): Promise<SessionProtocolSessionSummary[]>;
  registerClientTools?(options: {
    tools: SessionProtocolClientToolDefinition[];
    sendCall: (message: SessionProtocolClientToolCallMessage) => void;
    sendCancel: (message: SessionProtocolClientToolCancelMessage) => void;
  }): { clientId: string; unregister: () => void };
  acknowledgeClientToolCall?(sessionId: string, callId: string): boolean;
  completeClientToolCall?(
    sessionId: string,
    callId: string,
    result: { ok: true; content: string } | { ok: false; error: string },
  ): boolean;
  shutdown(): Promise<void>;
};
