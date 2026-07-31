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
  SessionProtocolMethod,
  SessionProtocolPendingUserMessagesMessage,
  SessionProtocolPendingUserMessagesState,
  SessionProtocolQueueResult,
  SessionProtocolReadyMessage,
  SessionProtocolRecordResult,
  SessionProtocolReloadResult,
  SessionProtocolRequestId,
  SessionProtocolResolvePromptResult,
  SessionProtocolRetryResult,
  SessionProtocolRewindResult,
  SessionProtocolSampleParams,
  SessionProtocolSampleResult,
  SessionProtocolSessionSummary,
  SessionProtocolSettingsUpdateResult,
  SessionProtocolSnapshot,
  SessionProtocolSteerResult,
  SessionProtocolSubmitResult,
  SessionProtocolTerminateSubagentResult,
  SessionProtocolTurnOutcome,
  SessionProtocolUnobserveResult,
} from "../protocol/session_protocol.js";
import type { WebSocketSessionProtocolTransportOptions } from "../transport/index.js";

export type TauSdkRequestId = SessionProtocolRequestId;
export type TauSdkSessionProtocolMethod = SessionProtocolMethod;
export type TauSdkInitializeParams = SessionProtocolInitializeParams;
export type TauSdkDelta = SessionProtocolDeltaMessage;
export type TauSdkEphemeral = SessionProtocolEphemeralMessage;
export type TauSdkPendingUserMessagesState = SessionProtocolPendingUserMessagesState;
export type TauSdkPendingUserMessagesMessage = SessionProtocolPendingUserMessagesMessage;
export type TauSdkReadyMessage = SessionProtocolReadyMessage;
export type TauSdkCreateSessionInput = SessionProtocolCreateParams;
export type TauSdkSessionSummary = SessionProtocolSessionSummary;
export type TauSdkSessionTurnOutcome = SessionProtocolTurnOutcome;
export type TauSdkSessionSubmitResult = SessionProtocolSubmitResult;
export type TauSdkSessionQueueResult = SessionProtocolQueueResult;
export type TauSdkSessionSteerResult = SessionProtocolSteerResult;
export type TauSdkSessionCancelPendingMessagesResult = SessionProtocolCancelPendingMessagesResult;
export type TauSdkSessionRecordResult = SessionProtocolRecordResult;
export type TauSdkSessionInterruptResult = SessionProtocolInterruptResult;
export type TauSdkSessionExecResult = SessionProtocolExecResult;
export type TauSdkSessionSnapshotResult = SessionProtocolSnapshot;
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
export type TauSdkSessionTerminateSubagentResult = SessionProtocolTerminateSubagentResult;
export type TauSdkSessionUnobserveResult = SessionProtocolUnobserveResult;
export type TauSdkEphemeralAgentTool = SessionProtocolEphemeralAgentTool;
export type TauSdkEphemeralCreateResult = SessionProtocolEphemeralCreateResult;
export type TauSdkEphemeralSubmitResult = SessionProtocolEphemeralSubmitResult;
export type TauSdkEphemeralCloseResult = SessionProtocolEphemeralCloseResult;

export type TauSdkClientToolContext = {
  sessionId: string;
  callId: string;
  signal: AbortSignal;
};

export type TauSdkClientToolResult = string | { content: string };

export type TauSdkClientTool = {
  schema: SessionProtocolClientToolDefinition;
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

export type TauSdkClientOptions = TauSdkTransportClientOptions & {
  cwd?: string;
  persona?: string;
  reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  noAgentContextFiles?: boolean;
};

export type TauSdkWebSocketClientOptions = TauSdkTransportClientOptions &
  WebSocketSessionProtocolTransportOptions;

export type TauSdkSessionUserMessageOptions = {
  historyEntryId?: string;
};

export type TauSdkDeltaListener = (delta: TauSdkDelta) => void;
export type TauSdkEphemeralListener = (message: TauSdkEphemeral) => void;
export type TauSdkPendingUserMessagesListener = (message: TauSdkPendingUserMessagesMessage) => void;

export type TauSdkSession = {
  readonly id: string;
  pendingUserMessages(): TauSdkPendingUserMessagesState;
  onDelta(listener: TauSdkDeltaListener): () => void;
  onEphemeral(listener: TauSdkEphemeralListener): () => void;
  onPendingUserMessages(listener: TauSdkPendingUserMessagesListener): () => void;
  record(
    text: string,
    options?: TauSdkSessionUserMessageOptions,
  ): Promise<TauSdkSessionRecordResult>;
  submit(
    text: string,
    options?: TauSdkSessionUserMessageOptions,
  ): Promise<TauSdkSessionSubmitResult>;
  queue(text: string, options?: TauSdkSessionUserMessageOptions): Promise<TauSdkSessionQueueResult>;
  steer(text: string, options?: TauSdkSessionUserMessageOptions): Promise<TauSdkSessionSteerResult>;
  cancelPendingMessages(): Promise<TauSdkSessionCancelPendingMessagesResult>;
  retry(): Promise<TauSdkSessionRetryResult>;
  exec(
    command: string,
    options?: {
      args?: string[];
      env?: Record<string, string>;
      stdin?: Buffer;
      cwd?: string;
      timeoutMs?: number;
      maxCaptureBytes?: number;
      signal?: AbortSignal;
    },
  ): Promise<TauSdkSessionExecResult>;
  sample(input: TauSdkSessionSampleInput): Promise<TauSdkSessionSampleResult>;
  interrupt(): Promise<TauSdkSessionInterruptResult>;
  snapshot(): Promise<TauSdkSessionSnapshotResult>;
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
  terminateSubagent(subagentId: string): Promise<TauSdkSessionTerminateSubagentResult>;
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
  close(): Promise<void>;
};
