import type { CancelledSteeringSubmission } from "../core/agent/agent_runtime.js";
import type {
  SessionProtocolAutocompletePathsParams,
  SessionProtocolAutocompletePathsResult,
  SessionProtocolBashParams,
  SessionProtocolBashResult,
  SessionProtocolClientToolCallMessage,
  SessionProtocolClientToolCancelMessage,
  SessionProtocolClientToolDefinition,
  SessionProtocolClientToolPresentation,
  SessionProtocolClientToolResult,
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
  SessionProtocolInterruptSubagentResult,
  SessionProtocolPersonaOverrides,
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
  SessionProtocolSubagentActivitiesMessage,
  SessionProtocolSubagentActivitiesState,
  SessionProtocolTurnOutcome,
  SessionProtocolUserMessageTurnResult,
} from "../protocol/session_protocol.js";

export class EphemeralThreadBusyError extends Error {}

export class SessionExecBusyError extends Error {
  constructor(execId: string) {
    super(`execution '${execId}' is already active`);
  }
}

export class SessionRetryUnavailableError extends Error {}

export class SessionRuntimeNotLoadedError extends Error {}

export type TauHostedSession = {
  readonly sessionId: string;
  readonly isDisposed?: boolean;
  readonly isTurnRunning: boolean;
  readonly isContextBashRunning: boolean;
  readonly canAcceptSteering: boolean;
  onTurnIdle(handler: () => void): () => void;
  onDelta(handler: (delta: SessionProtocolDeltaMessage) => void): () => void;
  onEphemeral(handler: (message: SessionProtocolEphemeralMessage) => void): () => void;
  subagentActivities(): SessionProtocolSubagentActivitiesState;
  onSubagentActivities(
    handler: (message: SessionProtocolSubagentActivitiesMessage) => void,
  ): () => void;
  record(
    options: Omit<SessionProtocolRecordParams, "sessionId">,
  ): Promise<SessionProtocolRecordResult>;
  acceptTurn(
    options: Omit<SessionProtocolRecordParams, "sessionId">,
  ): Promise<SessionProtocolRecordResult>;
  runAcceptedTurn(userHistoryEntryId: string): Promise<SessionProtocolUserMessageTurnResult>;
  runTurn(): Promise<SessionProtocolTurnOutcome>;
  retryTurn(): Promise<SessionProtocolTurnOutcome>;
  holdTurnAdmission(): () => void;
  waitForActiveTurn(): Promise<void>;
  interruptTurn(): boolean;
  interruptActiveWork(): boolean;
  waitForActiveWork(): Promise<void>;
  requestTurnBoundaryStop(): boolean;
  cancelTurnBoundaryStop(): boolean;
  steer(text: string): {
    id: string;
    applied: Promise<{ userHistoryEntryId: string }>;
    result: Promise<{
      userHistoryEntryId: string;
      turn: SessionProtocolTurnOutcome;
    }>;
  };
  cancelSteering(): CancelledSteeringSubmission[];
  bash(
    options: Omit<SessionProtocolBashParams, "sessionId"> & { signal?: AbortSignal },
  ): Promise<SessionProtocolBashResult>;
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
  setAutoCompactThreshold(
    thresholdTokens: number | null,
  ): Promise<SessionProtocolSettingsUpdateResult>;
  setReasoning(
    reasoning: SessionProtocolSetReasoningParams["reasoning"],
  ): Promise<SessionProtocolSettingsUpdateResult>;
  setPersona(
    personaId: SessionProtocolSetPersonaParams["personaId"],
    overrides?: SessionProtocolPersonaOverrides,
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
  interruptSubagent(subagentId: string): Promise<SessionProtocolInterruptSubagentResult>;
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
  releaseSession(session: TauHostedSession): void;
  listSessions(): Promise<SessionProtocolSessionSummary[]>;
  setRetention(sessionId: string, durationMs: number | null): { retainedUntil: number | null };
  collectSession(sessionId: string): Promise<{ disposed: boolean }>;
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
  acknowledgeClientToolCall?(
    sessionId: string,
    callId: string,
    presentation?: SessionProtocolClientToolPresentation,
  ): Promise<boolean>;
  completeClientToolCall?(
    sessionId: string,
    callId: string,
    result: SessionProtocolClientToolResult,
  ): boolean;
  shutdown(): Promise<void>;
};
