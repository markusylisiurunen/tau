import type { CancelledSteeringSubmission } from "../core/agent/agent_runtime.js";
import type {
  SessionProtocolAutocompletePathsParams,
  SessionProtocolAutocompletePathsResult,
  SessionProtocolClearGoalResult,
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
  SessionProtocolGoal,
  SessionProtocolInterruptSubagentResult,
  SessionProtocolRecordParams,
  SessionProtocolRecordResult,
  SessionProtocolReloadResult,
  SessionProtocolResolvePromptParams,
  SessionProtocolResolvePromptResult,
  SessionProtocolResumeGoalResult,
  SessionProtocolRewindParams,
  SessionProtocolRewindResult,
  SessionProtocolSampleParams,
  SessionProtocolSampleResult,
  SessionProtocolSessionSummary,
  SessionProtocolSetPersonaParams,
  SessionProtocolSetReasoningParams,
  SessionProtocolSettingsUpdateResult,
  SessionProtocolSnapshot,
  SessionProtocolStartGoalParams,
  SessionProtocolStartGoalResult,
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

export type TauHostedSession = {
  readonly sessionId: string;
  readonly isDisposed?: boolean;
  readonly isTurnRunning: boolean;
  readonly canAcceptSteering: boolean;
  getGoal(): SessionProtocolGoal | null;
  onDelta(handler: (delta: SessionProtocolDeltaMessage) => void): () => void;
  onEphemeral(handler: (message: SessionProtocolEphemeralMessage) => void): () => void;
  record(
    options: Omit<SessionProtocolRecordParams, "sessionId">,
  ): Promise<SessionProtocolRecordResult>;
  acceptTurn(
    options: Omit<SessionProtocolRecordParams, "sessionId">,
  ): Promise<SessionProtocolRecordResult>;
  runAcceptedTurn(userHistoryEntryId: string): Promise<SessionProtocolUserMessageTurnResult>;
  runTurn(): Promise<SessionProtocolTurnOutcome>;
  retryTurn(): Promise<SessionProtocolTurnOutcome>;
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
  startGoal(
    objective: SessionProtocolStartGoalParams["objective"],
  ): Promise<SessionProtocolStartGoalResult>;
  resumeGoal(): Promise<SessionProtocolResumeGoalResult>;
  clearGoal(): Promise<SessionProtocolClearGoalResult>;
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
