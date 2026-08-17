import type {
  SessionProtocolAutocompletePathsResult,
  SessionProtocolCancelPendingMessagesResult,
  SessionProtocolClientToolDefinition,
  SessionProtocolCompactResult,
  SessionProtocolCreateParams,
  SessionProtocolDeltaMessage,
  SessionProtocolEphemeralAgentTool,
  SessionProtocolEphemeralCloseResult,
  SessionProtocolEphemeralCreateResult,
  SessionProtocolEphemeralMessage,
  SessionProtocolEphemeralSubmitResult,
  SessionProtocolExecResult,
  SessionProtocolInitializeParams,
  SessionProtocolInterruptResult,
  SessionProtocolInterruptSubagentResult,
  SessionProtocolMethod,
  SessionProtocolPendingUserMessagesMessage,
  SessionProtocolPendingUserMessagesState,
  SessionProtocolQueueResult,
  SessionProtocolReadyMessage,
  SessionProtocolRecordResult,
  SessionProtocolReloadResult,
  SessionProtocolRequestId,
  SessionProtocolResolvePromptResult,
  SessionProtocolResumeGoalResult,
  SessionProtocolRetryResult,
  SessionProtocolRewindResult,
  SessionProtocolSampleParams,
  SessionProtocolSampleResult,
  SessionProtocolSessionSummary,
  SessionProtocolSettingsUpdateResult,
  SessionProtocolSnapshot,
  SessionProtocolStartGoalResult,
  SessionProtocolSteerResult,
  SessionProtocolSubagentActivitiesMessage,
  SessionProtocolSubagentActivitiesState,
  SessionProtocolSubmitResult,
  SessionProtocolTurnOutcome,
  SessionProtocolTurnRecord,
  SessionProtocolUnobserveResult,
} from "../protocol/session_protocol.js";
import type { WebSocketSessionProtocolTransportOptions } from "../transport/index.js";
import type { TauClientToolPresentation } from "./client_tool_presentation.js";

export type TauSdkRequestId = SessionProtocolRequestId;
export type TauSdkSessionProtocolMethod = SessionProtocolMethod;
export type TauSdkInitializeParams = SessionProtocolInitializeParams;
export type TauSdkDelta = SessionProtocolDeltaMessage;
export type TauSdkEphemeral = SessionProtocolEphemeralMessage;
export type TauSdkPendingUserMessagesState = SessionProtocolPendingUserMessagesState;
export type TauSdkPendingUserMessagesMessage = SessionProtocolPendingUserMessagesMessage;
export type TauSdkSubagentActivitiesState = SessionProtocolSubagentActivitiesState;
export type TauSdkSubagentActivitiesMessage = SessionProtocolSubagentActivitiesMessage;
export type TauSdkReadyMessage = SessionProtocolReadyMessage;
export type TauSdkCreateSessionInput = SessionProtocolCreateParams;
export type TauSdkSessionSummary = SessionProtocolSessionSummary;
export type TauSdkSessionTurnOutcome = SessionProtocolTurnOutcome;
export type TauSdkSessionTurnRecord = SessionProtocolTurnRecord;
export type TauSdkSessionSubmitResult = SessionProtocolSubmitResult;
export type TauSdkSessionQueueResult = SessionProtocolQueueResult;
export type TauSdkSessionSteerResult = SessionProtocolSteerResult;
export type TauSdkSessionCancelPendingMessagesResult = SessionProtocolCancelPendingMessagesResult;
export type TauSdkSessionRecordResult = SessionProtocolRecordResult;
export type TauSdkSessionInterruptResult = SessionProtocolInterruptResult;
export type TauSdkSessionExecResult = SessionProtocolExecResult;
export type TauSdkSessionSnapshotResult = SessionProtocolSnapshot;
export type TauSdkSessionStartGoalResult = SessionProtocolStartGoalResult;
export type TauSdkSessionResumeGoalResult = SessionProtocolResumeGoalResult;
export type TauSdkSessionClearGoalResult = SessionProtocolSnapshot;
export type TauSdkSessionSetReasoningResult = SessionProtocolSettingsUpdateResult;
export type TauSdkSessionSetPersonaResult = SessionProtocolSnapshot;
export type TauSdkSessionCompactResult = SessionProtocolCompactResult;
export type TauSdkSessionRewindResult = SessionProtocolRewindResult;
export type TauSdkSessionReloadResult = SessionProtocolReloadResult;
export type TauSdkResolvePromptResult = SessionProtocolResolvePromptResult;
export type TauSdkAutocompletePathsResult = SessionProtocolAutocompletePathsResult;
export type TauSdkSessionRetryResult = SessionProtocolRetryResult;
export type TauSdkSessionSampleInput = Omit<SessionProtocolSampleParams, "sessionId">;
export type TauSdkSessionSampleResult = SessionProtocolSampleResult;
export type TauSdkSessionInterruptSubagentResult = SessionProtocolInterruptSubagentResult;
export type TauSdkSessionUnobserveResult = SessionProtocolUnobserveResult;
export type TauSdkEphemeralAgentTool = SessionProtocolEphemeralAgentTool;
export type TauSdkEphemeralCreateResult = SessionProtocolEphemeralCreateResult;
export type TauSdkEphemeralSubmitResult = SessionProtocolEphemeralSubmitResult;
export type TauSdkEphemeralCloseResult = SessionProtocolEphemeralCloseResult;

export type TauSdkSessionExecOptions = {
  args?: string[];
  env?: Record<string, string>;
  stdin?: Buffer;
  cwd?: string;
  timeoutMs?: number;
  maxCaptureBytes?: number;
  signal?: AbortSignal;
};

export type TauSdkClientToolExecutionEnvironment = {
  exec(command: string, options?: TauSdkSessionExecOptions): Promise<TauSdkSessionExecResult>;
};

export type TauSdkClientToolDescribeContext = {
  sessionId: string;
  agentId: string;
  callId: string;
  signal: AbortSignal;
};

export type TauSdkClientToolContext = TauSdkClientToolDescribeContext & {
  executionEnvironment: TauSdkClientToolExecutionEnvironment;
};

export type TauSdkClientToolResult =
  | string
  | {
      ok?: true;
      content: string;
      presentation?: TauClientToolPresentation;
    }
  | {
      ok: false;
      error: string;
      presentation?: TauClientToolPresentation;
    };

export type TauSdkClientTool = {
  schema: SessionProtocolClientToolDefinition;
  describe?: (
    args: unknown,
    context: TauSdkClientToolDescribeContext,
  ) => Promise<TauClientToolPresentation | undefined> | TauClientToolPresentation | undefined;
  execute: (
    args: unknown,
    context: TauSdkClientToolContext,
  ) => Promise<TauSdkClientToolResult> | TauSdkClientToolResult;
};

export type TauSdkTransportClientOptions = {
  connectTimeoutMs?: number;
  initialize?: TauSdkInitializeParams;
  clientTools?: TauSdkClientTool[];
};

export type TauSdkHostDiagnostic = {
  event: "history_replication_failed";
  endpoint: string;
  sessionId?: string;
  operationId?: string;
  quarantined?: true;
  error: {
    status?: number;
    code?: string;
    message: string;
  };
};

export type TauSdkClientOptions = TauSdkTransportClientOptions & {
  cwd?: string;
  persona?: string;
  reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  noAgentContextFiles?: boolean;
  refreshModelCatalog?: boolean;
  onDiagnostic?: (diagnostic: TauSdkHostDiagnostic) => void;
};

export type TauSdkWebSocketClientOptions = TauSdkTransportClientOptions &
  WebSocketSessionProtocolTransportOptions;

export type TauSdkSessionUserMessageOptions = {
  historyEntryId?: string;
};

export type TauSdkDeltaListener = (delta: TauSdkDelta) => void;
export type TauSdkEphemeralListener = (message: TauSdkEphemeral) => void;
export type TauSdkPendingUserMessagesListener = (message: TauSdkPendingUserMessagesMessage) => void;
export type TauSdkSubagentActivitiesListener = (message: TauSdkSubagentActivitiesMessage) => void;

export type TauSdkSession = {
  readonly id: string;
  pendingUserMessages(): TauSdkPendingUserMessagesState;
  subagentActivities(): TauSdkSubagentActivitiesState;
  onDelta(listener: TauSdkDeltaListener): () => void;
  onEphemeral(listener: TauSdkEphemeralListener): () => void;
  onPendingUserMessages(listener: TauSdkPendingUserMessagesListener): () => void;
  onSubagentActivities(listener: TauSdkSubagentActivitiesListener): () => void;
  record(
    text: string,
    options?: TauSdkSessionUserMessageOptions,
  ): Promise<TauSdkSessionRecordResult>;
  submit(
    text: string,
    options?: TauSdkSessionUserMessageOptions,
  ): Promise<TauSdkSessionSubmitResult>;
  queue(text: string, options?: TauSdkSessionUserMessageOptions): Promise<TauSdkSessionQueueResult>;
  steer(text: string): Promise<TauSdkSessionSteerResult>;
  cancelPendingMessages(): Promise<TauSdkSessionCancelPendingMessagesResult>;
  retry(): Promise<TauSdkSessionRetryResult>;
  exec(command: string, options?: TauSdkSessionExecOptions): Promise<TauSdkSessionExecResult>;
  sample(input: TauSdkSessionSampleInput): Promise<TauSdkSessionSampleResult>;
  interrupt(): Promise<TauSdkSessionInterruptResult>;
  snapshot(): Promise<TauSdkSessionSnapshotResult>;
  startGoal(objective: string): Promise<TauSdkSessionStartGoalResult>;
  resumeGoal(): Promise<TauSdkSessionResumeGoalResult>;
  clearGoal(): Promise<TauSdkSessionClearGoalResult>;
  setReasoning(
    reasoning: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  ): Promise<TauSdkSessionSetReasoningResult>;
  setPersona(personaId: string): Promise<TauSdkSessionSetPersonaResult>;
  resolvePrompt(promptId: string): Promise<TauSdkResolvePromptResult>;
  autocompletePaths(options: {
    query: string;
    limit: number;
  }): Promise<TauSdkAutocompletePathsResult>;
  reload(): Promise<TauSdkSessionReloadResult>;
  compact(
    mode: "summary-only" | "summary-and-last",
    options?: { guidance?: string },
  ): Promise<TauSdkSessionCompactResult>;
  rewindToHistoryEntryId(historyEntryId: string): Promise<TauSdkSessionRewindResult>;
  interruptSubagent(subagentId: string): Promise<TauSdkSessionInterruptSubagentResult>;
  createEphemeralContext(options: {
    instructions: string;
    tools: TauSdkEphemeralAgentTool[];
  }): Promise<TauSdkEphemeralCreateResult>;
  submitEphemeralThread(options: {
    contextId: string;
    threadId: string;
    forkFromThreadId?: string;
    message: string;
  }): Promise<TauSdkEphemeralSubmitResult>;
  closeEphemeralContext(contextId: string): Promise<TauSdkEphemeralCloseResult>;
  unobserve(): Promise<TauSdkSessionUnobserveResult>;
};

export type TauSdkSessionClient = {
  create(input: TauSdkCreateSessionInput): Promise<TauSdkSession>;
  list(): Promise<TauSdkSessionSummary[]>;
  observe(sessionId: string): Promise<TauSdkSession>;
};

export type TauSdkClient = {
  readonly ready: TauSdkReadyMessage;
  readonly sessions: TauSdkSessionClient;
  subscribe(listener: TauSdkDeltaListener): () => void;
  subscribeEphemeral(listener: TauSdkEphemeralListener): () => void;
  subscribePendingUserMessages(listener: TauSdkPendingUserMessagesListener): () => void;
  subscribeSubagentActivities(listener: TauSdkSubagentActivitiesListener): () => void;
  close(): Promise<void>;
};
