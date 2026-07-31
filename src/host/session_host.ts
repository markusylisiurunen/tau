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
  SessionProtocolRecordParams,
  SessionProtocolRecordResult,
  SessionProtocolReloadResult,
  SessionProtocolResolvePromptParams,
  SessionProtocolResolvePromptResult,
  SessionProtocolRewindParams,
  SessionProtocolRewindResult,
  SessionProtocolSampleParams,
  SessionProtocolSampleResult,
  SessionProtocolSessionSummary,
  SessionProtocolSetPersonaParams,
  SessionProtocolSetReasoningParams,
  SessionProtocolSettingsUpdateResult,
  SessionProtocolSnapshot,
  SessionProtocolTerminateSubagentResult,
  SessionProtocolTurnOutcome,
} from "../protocol/session_protocol.js";

export class EphemeralThreadBusyError extends Error {}

export class SessionExecBusyError extends Error {
  constructor(execId: string) {
    super(`execution '${execId}' is already active`);
  }
}

export type TauHostedSession = {
  readonly sessionId: string;
  readonly isDisposed?: boolean;
  readonly isTurnRunning: boolean;
  onDelta(handler: (delta: SessionProtocolDeltaMessage) => void): () => void;
  onEphemeral(handler: (message: SessionProtocolEphemeralMessage) => void): () => void;
  record(
    options: Omit<SessionProtocolRecordParams, "sessionId">,
  ): Promise<SessionProtocolRecordResult>;
  runTurn(): Promise<SessionProtocolTurnOutcome>;
  interruptTurn(): boolean;
  interruptActiveWork(): boolean;
  waitForActiveWork(): Promise<void>;
  requestTurnBoundaryStop(): boolean;
  cancelTurnBoundaryStop(): boolean;
  steer(text: string): Promise<{
    userHistoryEntryId: string;
    turn: SessionProtocolTurnOutcome;
  }>;
  cancelSteering(): string[];
  exec(
    options: Omit<SessionProtocolExecParams, "sessionId"> & {
      signal?: AbortSignal;
    },
  ): Promise<SessionProtocolExecResult>;
  cancelExec(execId: string): boolean;
  sample(
    options: Omit<SessionProtocolSampleParams, "sessionId"> & {
      signal?: AbortSignal;
    },
  ): Promise<SessionProtocolSampleResult>;
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
  }): {
    clientId: string;
    attachSession: (sessionId: string) => void;
    detachSession: (sessionId: string) => void;
    unregister: () => void;
  };
  acknowledgeClientToolCall?(sessionId: string, callId: string): boolean;
  completeClientToolCall?(
    sessionId: string,
    callId: string,
    result: { ok: true; content: string } | { ok: false; error: string },
  ): boolean;
  shutdown(): Promise<void>;
};
