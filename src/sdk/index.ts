export type {
  BuildTauCodeModeToolDescriptionOptions,
  ExecuteTauCodeModeOptions,
  TauCodeModeApi,
  TauCodeModeDefinition,
  TauCodeModeExecutionStatus,
  TauCodeModeHandler,
  TauCodeModeHandlerContext,
  TauCodeModeInvocation,
  TauCodeModeJsonValue,
  TauCodeModePersistOutput,
  TauCodeModeResult,
} from "../code_mode/runtime.js";
export {
  buildTauCodeModeToolDescription,
  executeTauCodeMode,
  TAU_CODE_MODE_DEFAULT_TIMEOUT_MS,
  TAU_CODE_MODE_MAX_OUTPUT_TOKENS,
} from "../code_mode/runtime.js";
export type {
  SessionProtocolDelta,
  SessionProtocolFeedbackEvent,
  SessionProtocolFeedbackTone,
  SessionProtocolPendingUserMessage,
  SessionProtocolPendingUserMessagesMessage,
  SessionProtocolPendingUserMessagesState,
  SessionProtocolSnapshot,
  SessionProtocolSubagentActivitiesAgentState,
  SessionProtocolSubagentActivitiesChange,
  SessionProtocolSubagentActivitiesMessage,
  SessionProtocolSubagentActivitiesState,
  SessionProtocolSubagentActivity,
  SessionProtocolTurnRecord,
} from "../protocol/index.js";
export {
  applySessionProtocolDelta,
  applySessionProtocolSubagentActivitiesMessage,
} from "../protocol/index.js";
export type {
  SessionProtocolDeltaListener,
  SessionProtocolEphemeralListener,
  SessionProtocolFailureListener,
  SessionProtocolPendingUserMessagesListener,
  SessionProtocolSpawnedProcess,
  SessionProtocolSubagentActivitiesListener,
  SessionProtocolTransport,
  TauSessionProtocolError,
  TauSessionProtocolErrorCode,
  WebSocketSessionProtocolTransportOptions,
} from "../transport/index.js";
export {
  StdioSessionProtocolTransport,
  TauProcessError,
  TauSessionClientError,
  TauSessionProtocolResponseError,
  TauTransportError,
  WebSocketSessionProtocolTransport,
} from "../transport/index.js";
export { createTauSdkClient, createTauSdkWebSocketClient } from "./client.js";
export {
  createTauCodeModeClientTool,
  type TauSdkCodeModeClientToolOptions,
} from "./code_mode.js";
export { createTauSdkClientFromTransport } from "./session.js";
export type {
  TauSdkAutocompletePathsResult,
  TauSdkClient,
  TauSdkClientOptions,
  TauSdkClientTool,
  TauSdkClientToolContext,
  TauSdkClientToolResult,
  TauSdkCreateSessionInput,
  TauSdkDelta,
  TauSdkDeltaListener,
  TauSdkEphemeral,
  TauSdkEphemeralAgentTool,
  TauSdkEphemeralCloseResult,
  TauSdkEphemeralCreateResult,
  TauSdkEphemeralListener,
  TauSdkEphemeralSubmitResult,
  TauSdkInitializeParams,
  TauSdkPendingUserMessagesListener,
  TauSdkPendingUserMessagesMessage,
  TauSdkPendingUserMessagesState,
  TauSdkReadyMessage,
  TauSdkRequestId,
  TauSdkResolvePromptResult,
  TauSdkSession,
  TauSdkSessionCancelPendingMessagesResult,
  TauSdkSessionClearGoalResult,
  TauSdkSessionClient,
  TauSdkSessionCompactResult,
  TauSdkSessionExecResult,
  TauSdkSessionInterruptResult,
  TauSdkSessionInterruptSubagentResult,
  TauSdkSessionProtocolMethod,
  TauSdkSessionQueueResult,
  TauSdkSessionRecordResult,
  TauSdkSessionReloadResult,
  TauSdkSessionResumeGoalResult,
  TauSdkSessionRetryResult,
  TauSdkSessionRewindResult,
  TauSdkSessionSampleInput,
  TauSdkSessionSampleResult,
  TauSdkSessionSetPersonaResult,
  TauSdkSessionSetReasoningResult,
  TauSdkSessionSnapshotResult,
  TauSdkSessionStartGoalResult,
  TauSdkSessionSteerResult,
  TauSdkSessionSubmitResult,
  TauSdkSessionSummary,
  TauSdkSessionTurnOutcome,
  TauSdkSessionTurnRecord,
  TauSdkSessionUnobserveResult,
  TauSdkSessionUserMessageOptions,
  TauSdkSubagentActivitiesListener,
  TauSdkSubagentActivitiesMessage,
  TauSdkSubagentActivitiesState,
  TauSdkTransportClientOptions,
  TauSdkWebSocketClientOptions,
} from "./types.js";
export type { TauSdkUserTextProjection } from "./user_text.js";
export { getTauUserDisplayText, getTauUserModelText, projectTauUserText } from "./user_text.js";

export function getTauSdkSessionTurnRecord(
  snapshot: import("../protocol/index.js").SessionProtocolSnapshot,
  userHistoryEntryId: string,
): import("./types.js").TauSdkSessionTurnRecord | undefined {
  return Object.hasOwn(snapshot.turns, userHistoryEntryId)
    ? snapshot.turns[userHistoryEntryId]
    : undefined;
}

export function getTauSdkSessionTurnOutcome(
  snapshot: import("../protocol/index.js").SessionProtocolSnapshot,
  userHistoryEntryId: string,
): import("./types.js").TauSdkSessionTurnOutcome | undefined {
  const record = getTauSdkSessionTurnRecord(snapshot, userHistoryEntryId);
  return record?.state === "settled" ? record.outcome : undefined;
}
