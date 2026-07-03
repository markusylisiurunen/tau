import type {
  SessionProtocolAutocompletePathsResult,
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
  SessionProtocolPruneResult,
  SessionProtocolQueueResult,
  SessionProtocolReadyMessage,
  SessionProtocolRecordResult,
  SessionProtocolReloadResult,
  SessionProtocolRequestId,
  SessionProtocolResolvePromptResult,
  SessionProtocolRetryResult,
  SessionProtocolRewindResult,
  SessionProtocolSessionSummary,
  SessionProtocolSettingsUpdateResult,
  SessionProtocolSnapshot,
  SessionProtocolSteerResult,
  SessionProtocolSubmitResult,
  SessionProtocolTerminateSubagentResult,
  SessionProtocolUnobserveResult,
} from "../protocol/session_protocol.js";
import type { WebSocketSessionProtocolTransportOptions } from "../transport/index.js";

export type TauSdkRequestId = SessionProtocolRequestId;
export type TauSdkSessionProtocolMethod = SessionProtocolMethod;
export type TauSdkInitializeParams = SessionProtocolInitializeParams;
export type TauSdkDelta = SessionProtocolDeltaMessage;
export type TauSdkEphemeral = SessionProtocolEphemeralMessage;
export type TauSdkReadyMessage = SessionProtocolReadyMessage;
export type TauSdkCreateSessionInput = SessionProtocolCreateParams;
export type TauSdkSessionSummary = SessionProtocolSessionSummary;
export type TauSdkSessionSubmitResult = SessionProtocolSubmitResult;
export type TauSdkSessionQueueResult = SessionProtocolQueueResult;
export type TauSdkSessionSteerResult = SessionProtocolSteerResult;
export type TauSdkSessionRecordResult = SessionProtocolRecordResult;
export type TauSdkSessionInterruptResult = SessionProtocolInterruptResult;
export type TauSdkSessionExecResult = SessionProtocolExecResult;
export type TauSdkSessionSnapshotResult = SessionProtocolSnapshot;
export type TauSdkSessionSetRiskResult = SessionProtocolSnapshot;
export type TauSdkSessionSetReasoningResult = SessionProtocolSettingsUpdateResult;
export type TauSdkSessionSetPersonaResult = SessionProtocolSnapshot;
export type TauSdkSessionCompactResult = SessionProtocolCompactResult;
export type TauSdkSessionPruneResult = SessionProtocolPruneResult;
export type TauSdkSessionRewindResult = SessionProtocolRewindResult;
export type TauSdkSessionReloadResult = SessionProtocolReloadResult;
export type TauSdkResolvePromptResult = SessionProtocolResolvePromptResult;
export type TauSdkAutocompletePathsResult = SessionProtocolAutocompletePathsResult;
export type TauSdkSessionRetryResult = SessionProtocolRetryResult;
export type TauSdkSessionTerminateSubagentResult = SessionProtocolTerminateSubagentResult;
export type TauSdkSessionUnobserveResult = SessionProtocolUnobserveResult;
export type TauSdkEphemeralAgentTool = SessionProtocolEphemeralAgentTool;
export type TauSdkEphemeralCreateResult = SessionProtocolEphemeralCreateResult;
export type TauSdkEphemeralSubmitResult = SessionProtocolEphemeralSubmitResult;
export type TauSdkEphemeralCloseResult = SessionProtocolEphemeralCloseResult;

export type TauSdkTransportClientOptions = {
  connectTimeoutMs?: number;
  initialize?: TauSdkInitializeParams;
};

export type TauSdkClientOptions = TauSdkTransportClientOptions & {
  cwd?: string;
  persona?: string;
  reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  riskLevel?: "read-only" | "read-write";
  noAgentContextFiles?: boolean;
};

export type TauSdkWebSocketClientOptions = TauSdkTransportClientOptions &
  WebSocketSessionProtocolTransportOptions;

export type TauSdkSessionUserMessageOptions = {
  historyEntryId?: string;
};

export type TauSdkDeltaListener = (delta: TauSdkDelta) => void;
export type TauSdkEphemeralListener = (message: TauSdkEphemeral) => void;

export type TauSdkSession = {
  readonly id: string;
  onDelta(listener: TauSdkDeltaListener): () => void;
  onEphemeral(listener: TauSdkEphemeralListener): () => void;
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
  retry(): Promise<TauSdkSessionRetryResult>;
  exec(
    command: string,
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<TauSdkSessionExecResult>;
  interrupt(): Promise<TauSdkSessionInterruptResult>;
  snapshot(): Promise<TauSdkSessionSnapshotResult>;
  setRiskLevel(riskLevel: "read-only" | "read-write"): Promise<TauSdkSessionSetRiskResult>;
  setReasoning(
    reasoning: "none" | "minimal" | "low" | "medium" | "high" | "xhigh",
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
  pruneToolResults(
    strategy: "earliest" | "largest" | "smart",
    options: { fraction: number; guidance?: string },
  ): Promise<TauSdkSessionPruneResult>;
  rewindToHistoryEntryId(historyEntryId: string): Promise<TauSdkSessionRewindResult>;
  terminateSubagent(subagentId: string): Promise<TauSdkSessionTerminateSubagentResult>;
  createEphemeralContext(options: {
    instructions: string;
    tools: TauSdkEphemeralAgentTool[];
    riskLevel: "read-only" | "read-write";
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
  close(): Promise<void>;
};
