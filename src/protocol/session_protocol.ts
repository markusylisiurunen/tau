import type {
  AssistantMessage,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
} from "@earendil-works/pi-ai";
import { type ZodError, z } from "zod";

export const SESSION_PROTOCOL_VERSION = 3 as const;

export const SESSION_PROTOCOL_METHODS = [
  "initialize",
  "session.create",
  "session.list",
  "session.observe",
  "session.unobserve",
  "session.record",
  "session.submit",
  "session.queue",
  "session.steer",
  "session.cancelPendingMessages",
  "session.retry",
  "session.exec",
  "session.execProcess",
  "session.cancelExec",
  "session.readFile",
  "session.writeFile",
  "session.sample",
  "session.interrupt",
  "session.snapshot",
  "session.setReasoning",
  "session.setPersona",
  "session.resolvePrompt",
  "session.autocompletePaths",
  "session.reload",
  "session.compact",
  "session.prune",
  "session.rewind",
  "session.terminateSubagent",
  "session.ephemeral.create",
  "session.ephemeral.submit",
  "session.ephemeral.close",
  "session.clientTool.ack",
  "session.clientTool.result",
] as const;

const SESSION_PROTOCOL_METHOD_SET: ReadonlySet<string> = new Set(SESSION_PROTOCOL_METHODS);

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : undefined;
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

export type SessionProtocolMethod = (typeof SESSION_PROTOCOL_METHODS)[number];

export const SESSION_PROTOCOL_ERROR_CODES = {
  parseError: "parse_error",
  invalidRequest: "invalid_request",
  methodNotFound: "method_not_found",
  invalidParams: "invalid_params",
  notFound: "not_found",
  busy: "busy",
  cancelled: "cancelled",
  internalError: "internal_error",
} as const;

export type SessionProtocolErrorCode =
  (typeof SESSION_PROTOCOL_ERROR_CODES)[keyof typeof SESSION_PROTOCOL_ERROR_CODES];

const SESSION_PROTOCOL_ERROR_CODE_VALUES = [
  SESSION_PROTOCOL_ERROR_CODES.parseError,
  SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
  SESSION_PROTOCOL_ERROR_CODES.methodNotFound,
  SESSION_PROTOCOL_ERROR_CODES.invalidParams,
  SESSION_PROTOCOL_ERROR_CODES.notFound,
  SESSION_PROTOCOL_ERROR_CODES.busy,
  SESSION_PROTOCOL_ERROR_CODES.cancelled,
  SESSION_PROTOCOL_ERROR_CODES.internalError,
] as const;

export type SessionProtocolRequestId = string;

export type SessionProtocolClientToolDefinition = {
  name: string;
  description: string;
  parameters: unknown;
  executionTimeoutMs?: number;
};

export type SessionProtocolInitializeParams = {
  client: {
    name: string;
    version: string;
    tools?: SessionProtocolClientToolDefinition[];
  };
};

export type SessionProtocolLocalExecutionEnvironmentInput = {
  kind: "local";
  cwd: string;
  env?: Record<string, string>;
};

export type SessionProtocolCloudflareSandboxExecutionEnvironmentInput = {
  kind: "cloudflare-sandbox";
  bridgeId: string;
  sandboxId: string;
  cwd: string;
};

export type SessionProtocolFlySpriteExecutionEnvironmentInput = {
  kind: "fly-sprite";
  apiId: string;
  spriteName: string;
  cwd: string;
};

export type SessionProtocolExecutionEnvironmentInput =
  | SessionProtocolLocalExecutionEnvironmentInput
  | SessionProtocolCloudflareSandboxExecutionEnvironmentInput
  | SessionProtocolFlySpriteExecutionEnvironmentInput;

export type SessionProtocolCreateParams = {
  executionEnvironment: SessionProtocolExecutionEnvironmentInput;
  personaId?: string;
  reasoning?: SessionProtocolReasoningEffort;
};
export type SessionProtocolListParams = Record<string, never>;
export type SessionProtocolSessionIdParams = {
  sessionId: string;
};
export type SessionProtocolUnobserveParams = SessionProtocolSessionIdParams;
export type SessionProtocolUserMessageParams = {
  sessionId: string;
  text: string;
  historyEntryId?: string;
};
export type SessionProtocolSubmitParams = SessionProtocolUserMessageParams;
export type SessionProtocolQueueParams = SessionProtocolUserMessageParams;
export type SessionProtocolSteerParams = SessionProtocolUserMessageParams;
export type SessionProtocolCancelPendingMessagesParams = SessionProtocolSessionIdParams;
export type SessionProtocolRecordParams = SessionProtocolSessionIdParams & {
  text: string;
  historyEntryId?: string;
};
export const SESSION_PROTOCOL_MAX_EXEC_CAPTURE_BYTES = 16 * 1024 * 1024;
export const SESSION_PROTOCOL_MAX_FILE_BYTES = 16 * 1024 * 1024;

export type SessionProtocolRetryParams = SessionProtocolSessionIdParams;
type SessionProtocolExecOptions = SessionProtocolSessionIdParams & {
  execId: string;
  cwd?: string;
  timeoutMs?: number;
  maxCaptureBytes?: number;
};
export type SessionProtocolExecParams = SessionProtocolExecOptions & {
  command: string;
};
export type SessionProtocolExecProcessParams = SessionProtocolExecOptions & {
  argv: [string, ...string[]];
  env?: Record<string, string>;
};
export type SessionProtocolCancelExecParams = SessionProtocolSessionIdParams & {
  execId: string;
};
export type SessionProtocolReadFileParams = SessionProtocolSessionIdParams & {
  path: string;
  maxBytes: number;
};
export type SessionProtocolWriteFileParams = SessionProtocolSessionIdParams & {
  path: string;
  contentBase64: string;
};
export type SessionProtocolSampleContext = {
  systemPrompt: string;
  messages: Message[];
  tools?: Tool[];
};
export type SessionProtocolSampleOptions = {
  reasoning?: SessionProtocolReasoningEffort;
  maxTokens?: number;
};
export type SessionProtocolSampleParams = SessionProtocolSessionIdParams & {
  context: SessionProtocolSampleContext;
  options: SessionProtocolSampleOptions;
};

export type SessionProtocolSetReasoningParams = SessionProtocolSessionIdParams & {
  reasoning: SessionProtocolReasoningEffort;
};
export type SessionProtocolSetPersonaParams = SessionProtocolSessionIdParams & {
  personaId: string;
};
export type SessionProtocolSettingsUpdateResult = {
  revision: number;
  settings: SessionProtocolSettingsSnapshot;
};
export type SessionProtocolResolvePromptParams = SessionProtocolSessionIdParams & {
  promptId: string;
};
export type SessionProtocolAutocompletePathsParams = SessionProtocolSessionIdParams & {
  query: string;
  limit: number;
};
export type SessionProtocolReloadParams = SessionProtocolSessionIdParams;
export type SessionProtocolCompactParams = SessionProtocolSessionIdParams & {
  mode: "summary-only" | "summary-and-last";
  guidance?: string;
};
export type SessionProtocolPruneParams = SessionProtocolSessionIdParams & {
  strategy: "earliest" | "largest" | "smart";
  fraction: number;
  guidance?: string;
};
export type SessionProtocolRewindParams = SessionProtocolSessionIdParams & {
  historyEntryId: string;
};
export type SessionProtocolTerminateSubagentParams = SessionProtocolSessionIdParams & {
  subagentId: string;
};
export type SessionProtocolEphemeralAgentTool =
  | "bash"
  | "write"
  | "edit"
  | "view_image"
  | "web_search"
  | "web_fetch";
export type SessionProtocolEphemeralCreateParams = SessionProtocolSessionIdParams & {
  instructions: string;
  tools: SessionProtocolEphemeralAgentTool[];
};
export type SessionProtocolEphemeralSubmitParams = SessionProtocolSessionIdParams & {
  contextId: string;
  threadId: string;
  forkFromThreadId?: string;
  message: string;
};
export type SessionProtocolEphemeralCloseParams = SessionProtocolSessionIdParams & {
  contextId: string;
};
export type SessionProtocolClientToolAckParams = SessionProtocolSessionIdParams & {
  callId: string;
};
export type SessionProtocolClientToolResultParams = SessionProtocolSessionIdParams & {
  callId: string;
} & (
    | {
        ok: true;
        content: string;
      }
    | {
        ok: false;
        error: string;
      }
  );

export type SessionProtocolParamsByMethod = {
  initialize: SessionProtocolInitializeParams;
  "session.create": SessionProtocolCreateParams;
  "session.list": SessionProtocolListParams;
  "session.observe": SessionProtocolSessionIdParams;
  "session.unobserve": SessionProtocolUnobserveParams;
  "session.record": SessionProtocolRecordParams;
  "session.submit": SessionProtocolSubmitParams;
  "session.queue": SessionProtocolQueueParams;
  "session.steer": SessionProtocolSteerParams;
  "session.cancelPendingMessages": SessionProtocolCancelPendingMessagesParams;
  "session.retry": SessionProtocolRetryParams;
  "session.exec": SessionProtocolExecParams;
  "session.execProcess": SessionProtocolExecProcessParams;
  "session.cancelExec": SessionProtocolCancelExecParams;
  "session.readFile": SessionProtocolReadFileParams;
  "session.writeFile": SessionProtocolWriteFileParams;
  "session.sample": SessionProtocolSampleParams;
  "session.interrupt": SessionProtocolSessionIdParams;
  "session.snapshot": SessionProtocolSessionIdParams;
  "session.setReasoning": SessionProtocolSetReasoningParams;
  "session.setPersona": SessionProtocolSetPersonaParams;
  "session.resolvePrompt": SessionProtocolResolvePromptParams;
  "session.autocompletePaths": SessionProtocolAutocompletePathsParams;
  "session.reload": SessionProtocolReloadParams;
  "session.compact": SessionProtocolCompactParams;
  "session.prune": SessionProtocolPruneParams;
  "session.rewind": SessionProtocolRewindParams;
  "session.terminateSubagent": SessionProtocolTerminateSubagentParams;
  "session.ephemeral.create": SessionProtocolEphemeralCreateParams;
  "session.ephemeral.submit": SessionProtocolEphemeralSubmitParams;
  "session.ephemeral.close": SessionProtocolEphemeralCloseParams;
  "session.clientTool.ack": SessionProtocolClientToolAckParams;
  "session.clientTool.result": SessionProtocolClientToolResultParams;
};

export type SessionProtocolInitializeResult = {
  protocolVersion: typeof SESSION_PROTOCOL_VERSION;
  methods: SessionProtocolMethod[];
  alreadyInitialized: boolean;
};

export type SessionProtocolTurnOutcome =
  | {
      status: "completed";
      stopReason: "stop" | "length" | "toolUse";
    }
  | {
      status: "failed";
      stopReason: "error";
      errorMessage?: string;
    }
  | {
      status: "aborted";
      stopReason: "aborted";
    }
  | {
      status: "blocked";
      reason: "auto-compaction-failed";
      message: string;
    };

export type SessionProtocolTurnResult = {
  turn: SessionProtocolTurnOutcome;
};

export type SessionProtocolUserMessageTurnResult = SessionProtocolTurnResult & {
  userHistoryEntryId: string;
};
export type SessionProtocolSubmitResult = SessionProtocolUserMessageTurnResult;
export type SessionProtocolQueueResult = SessionProtocolUserMessageTurnResult;
export type SessionProtocolSteerResult = SessionProtocolUserMessageTurnResult;

export type SessionProtocolPendingUserMessage = {
  id: string;
  mode: "queue" | "steer";
  text: string;
};

export type SessionProtocolPendingUserMessagesState = {
  revision: number;
  messages: SessionProtocolPendingUserMessage[];
};

export type SessionProtocolCreateResult = {
  sessionId: string;
};

export type SessionProtocolObserveResult = {
  snapshot: SessionProtocolSnapshot;
  pendingUserMessages: SessionProtocolPendingUserMessagesState;
};

export type SessionProtocolCancelPendingMessagesResult = {
  cancelled: SessionProtocolPendingUserMessage[];
};

export type SessionProtocolRecordResult = {
  snapshot: SessionProtocolSnapshot;
  userHistoryEntryId: string;
};

export type SessionProtocolRetryResult = SessionProtocolTurnResult;

export type SessionProtocolExecResult = {
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  closeSignal: string | null;
};

export type SessionProtocolCancelExecResult = {
  cancelled: boolean;
};

export type SessionProtocolReadFileResult = {
  contentBase64: string;
  bytes: number;
};

export type SessionProtocolWriteFileResult = {
  path: string;
  bytes: number;
};

export type SessionProtocolSampleResult = {
  message: AssistantMessage;
};

export type SessionProtocolSessionLifecycle = "idle" | "running";

export type SessionProtocolSessionSummary = {
  sessionId: string;
  lifecycle: SessionProtocolSessionLifecycle;
};

export type SessionProtocolListResult = {
  sessions: SessionProtocolSessionSummary[];
};

export type SessionProtocolSystemMessage = {
  role: "system";
  content: string;
  timestamp: number;
};

export type SessionProtocolDraftAssistantMessage = {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  timestamp: number;
};

export type SessionProtocolMessagePayload =
  | SessionProtocolSystemMessage
  | Message
  | SessionProtocolDraftAssistantMessage;

export type SessionProtocolMessageState = "draft" | "committed" | "interrupted" | "discarded";

export type SessionProtocolMessage = {
  id: string;
  state: SessionProtocolMessageState;
  modelVisible: boolean;
  message: SessionProtocolMessagePayload;
  turn?: SessionProtocolTurnOutcome;
};

export type SessionProtocolTimelineItem =
  | { type: "message"; id: string; messageId: string }
  | { type: "notice"; id: string; notice: SessionProtocolNotice }
  | { type: "operation"; id: string; operation: SessionProtocolOperation };

export type SessionProtocolNotice = {
  severity: "info" | "warn" | "error";
  text: string;
  timestamp: number;
};

export type SessionProtocolOperation = {
  kind: "auto-compaction" | "manual-compaction" | "prune" | "reload" | "rewind";
  status: "running" | "succeeded" | "failed" | "cancelled" | "skipped";
  startedAt: number;
  finishedAt?: number;
  summary?: string;
  error?: string;
  data?: Record<string, unknown>;
};

export type SessionProtocolPromptCompositionSnapshot = {
  environmentTag: string;
  subagentPrompts: Record<string, string>;
};

export type SessionProtocolReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type SessionProtocolThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type SessionProtocolServiceTier = "priority" | "flex";

export type SessionProtocolModelSnapshot = {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<SessionProtocolThinkingLevel, string | null>>;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: Array<{
      inputTokensAbove: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }>;
  };
  contextWindow: number;
  maxTokens: number;
  compat?: unknown;
};

export type SessionProtocolPersonaSettingsSnapshot = {
  reasoning?: SessionProtocolReasoningEffort;
  interleavedThinking?: boolean;
  serviceTier?: SessionProtocolServiceTier;
};

export type SessionProtocolSubagentSnapshot = {
  description?: string;
  tools?: string[];
  launchModels?: string[];
};

export type SessionProtocolPersonaSnapshot = {
  id: string;
  label: string;
  description?: string;
  allowedReasoningLevels?: SessionProtocolReasoningEffort[];
  subagents?: Record<string, SessionProtocolSubagentSnapshot>;
  tools?: string[];
  skills: string[] | "*";
  source: "builtin" | "user" | "project";
};

export type SessionProtocolBootstrapSnapshot = {
  model: SessionProtocolModelSnapshot;
  prompt: SessionProtocolPromptCompositionSnapshot;
};

export type SessionProtocolPromptTemplateSnapshot = {
  id: string;
  label?: string;
  description?: string;
};

export type SessionProtocolSkillSnapshot = {
  name: string;
  description: string;
  path: string;
};

export type SessionProtocolContentCatalogSnapshot = {
  personas: SessionProtocolPersonaSnapshot[];
  prompts: SessionProtocolPromptTemplateSnapshot[];
  skills: SessionProtocolSkillSnapshot[];
};

export type SessionProtocolSettingsSnapshot = {
  personaId: string;
  reasoning?: SessionProtocolReasoningEffort;
  serviceTier?: SessionProtocolServiceTier;
};

export type SessionProtocolLocalExecutionEnvironmentSnapshot = {
  kind: "local";
  cwd: string;
  home: string;
  env?: Record<string, string>;
};

export type SessionProtocolCloudflareSandboxExecutionEnvironmentSnapshot = {
  kind: "cloudflare-sandbox";
  bridgeId: string;
  sandboxId: string;
  cwd: string;
  home: string;
};

export type SessionProtocolFlySpriteExecutionEnvironmentSnapshot = {
  kind: "fly-sprite";
  apiId: string;
  spriteName: string;
  cwd: string;
  home: string;
};

export type SessionProtocolExecutionEnvironmentSnapshot =
  | SessionProtocolLocalExecutionEnvironmentSnapshot
  | SessionProtocolCloudflareSandboxExecutionEnvironmentSnapshot
  | SessionProtocolFlySpriteExecutionEnvironmentSnapshot;

export type SessionProtocolSnapshot = {
  sessionId: string;
  revision: number;
  lifecycle: SessionProtocolSessionLifecycle;
  costTotal: number;
  settings: SessionProtocolSettingsSnapshot;
  bootstrap: SessionProtocolBootstrapSnapshot;
  catalog: SessionProtocolContentCatalogSnapshot;
  executionEnvironment: SessionProtocolExecutionEnvironmentSnapshot;
  messages: SessionProtocolMessage[];
  timeline: SessionProtocolTimelineItem[];
  tools: Record<string, SessionProtocolToolRun>;
  agents: Record<string, SessionProtocolAgentRun>;
  facets: Record<string, SessionProtocolFacet>;
};

type SessionProtocolToolRunBase = {
  id: string;
  toolCallId: string;
  toolName: string;
  facetIds: string[];
};

type SessionProtocolToolPosition = {
  messageId: string;
  contentIndex: number;
};

export type SessionProtocolToolRun =
  | (SessionProtocolToolRunBase & {
      status: "streaming";
      origin: SessionProtocolToolPosition;
    })
  | (SessionProtocolToolRunBase & {
      status: "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
      call: SessionProtocolToolPosition;
      startedAt?: number;
      finishedAt?: number;
      resultMessageId?: string;
      summary?: string;
      error?: string;
    });

export type SessionProtocolAgentRun = {
  id: string;
  name: string;
  title: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  modelLabel?: string;
  costTotal: number;
  turns: number;
  toolCalls: number;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    contextWindowUsageTokens: number;
    contextWindow: number;
  };
  startedAt: number;
  finishedAt?: number;
  abortRequested: boolean;
  progress?: string;
  finalText?: string;
  error?: string;
};

export type SessionProtocolFacetSubject =
  | { type: "session" }
  | { type: "message"; id: string }
  | { type: "tool"; id: string }
  | { type: "agent"; id: string }
  | { type: "operation"; id: string };

export type SessionProtocolFacet = {
  id: string;
  subject: SessionProtocolFacetSubject;
  kind: string;
  version: number;
  data: Record<string, unknown>;
};

export type SessionProtocolInterruptResult = {
  interrupted: boolean;
  isTurnRunning: boolean;
};

export type SessionProtocolCompactResult = {
  snapshot: SessionProtocolSnapshot;
  compactionMessage: string;
  includedLastAssistant: boolean;
};
export type SessionProtocolPruneResult = {
  snapshot: SessionProtocolSnapshot;
  message: string;
  noop: boolean;
  bashResultsPruned: number;
  editCallsPruned: number;
  editResultsPruned: number;
  bytesPruned: number;
};

export type SessionProtocolRewindResult = {
  snapshot: SessionProtocolSnapshot;
  historyEntryId: string;
  text: string;
  removedEntryIds: string[];
};

export type SessionProtocolReloadResult = {
  snapshot: SessionProtocolSnapshot;
  warnings: string[];
  counts: {
    personas: number;
    prompts: number;
    skills: number;
  };
};

export type SessionProtocolResolvePromptResult = {
  promptId: string;
  text: string;
};
export type SessionProtocolAutocompletePathsResult = {
  paths: string[];
};

export type SessionProtocolUnobserveResult = {
  unobserved: true;
};

export type SessionProtocolTerminateSubagentResult = {
  found: boolean;
};

export type SessionProtocolEphemeralCreateResult = {
  contextId: string;
};

export type SessionProtocolEphemeralSubmitResult = {
  threadId: string;
  response: string;
};

export type SessionProtocolEphemeralCloseResult = {
  closed: boolean;
};

export type SessionProtocolClientToolAckResult = {
  accepted: boolean;
};

export type SessionProtocolClientToolResultResult = {
  accepted: boolean;
};

export type SessionProtocolResultByMethod = {
  initialize: SessionProtocolInitializeResult;
  "session.create": SessionProtocolCreateResult;
  "session.list": SessionProtocolListResult;
  "session.observe": SessionProtocolObserveResult;
  "session.unobserve": SessionProtocolUnobserveResult;
  "session.record": SessionProtocolRecordResult;
  "session.submit": SessionProtocolSubmitResult;
  "session.queue": SessionProtocolQueueResult;
  "session.steer": SessionProtocolSteerResult;
  "session.cancelPendingMessages": SessionProtocolCancelPendingMessagesResult;
  "session.retry": SessionProtocolRetryResult;
  "session.exec": SessionProtocolExecResult;
  "session.execProcess": SessionProtocolExecResult;
  "session.cancelExec": SessionProtocolCancelExecResult;
  "session.readFile": SessionProtocolReadFileResult;
  "session.writeFile": SessionProtocolWriteFileResult;
  "session.sample": SessionProtocolSampleResult;
  "session.interrupt": SessionProtocolInterruptResult;
  "session.snapshot": SessionProtocolSnapshot;
  "session.setReasoning": SessionProtocolSettingsUpdateResult;
  "session.setPersona": SessionProtocolSnapshot;
  "session.resolvePrompt": SessionProtocolResolvePromptResult;
  "session.autocompletePaths": SessionProtocolAutocompletePathsResult;
  "session.reload": SessionProtocolReloadResult;
  "session.compact": SessionProtocolCompactResult;
  "session.prune": SessionProtocolPruneResult;
  "session.rewind": SessionProtocolRewindResult;
  "session.terminateSubagent": SessionProtocolTerminateSubagentResult;
  "session.ephemeral.create": SessionProtocolEphemeralCreateResult;
  "session.ephemeral.submit": SessionProtocolEphemeralSubmitResult;
  "session.ephemeral.close": SessionProtocolEphemeralCloseResult;
  "session.clientTool.ack": SessionProtocolClientToolAckResult;
  "session.clientTool.result": SessionProtocolClientToolResultResult;
};

export type SessionProtocolRequestMessage = {
  [M in SessionProtocolMethod]: {
    version: typeof SESSION_PROTOCOL_VERSION;
    type: "request";
    id: SessionProtocolRequestId;
    method: M;
    params: SessionProtocolParamsByMethod[M];
  };
}[SessionProtocolMethod];

export type SessionProtocolSuccessResponseMessage = {
  version: typeof SESSION_PROTOCOL_VERSION;
  type: "response";
  id: SessionProtocolRequestId;
  ok: true;
  result: SessionProtocolResultByMethod[SessionProtocolMethod];
};

export type SessionProtocolError = {
  code: SessionProtocolErrorCode;
  message: string;
  data?: unknown;
};

export type SessionProtocolErrorResponseMessage = {
  version: typeof SESSION_PROTOCOL_VERSION;
  type: "response";
  id: SessionProtocolRequestId | null;
  ok: false;
  error: SessionProtocolError;
};

export type SessionProtocolResponseMessage =
  | SessionProtocolSuccessResponseMessage
  | SessionProtocolErrorResponseMessage;

export type SessionProtocolParsedSuccessResponseMessage = Omit<
  SessionProtocolSuccessResponseMessage,
  "result"
> & {
  result: unknown;
};

export type SessionProtocolParsedResponseMessage =
  | SessionProtocolParsedSuccessResponseMessage
  | SessionProtocolErrorResponseMessage;

export type SessionProtocolDeltaReason =
  | "user-message"
  | "assistant-stream"
  | "assistant-message"
  | "tool-run"
  | "tool-result"
  | "notice"
  | "agent-run"
  | "maintenance"
  | "configuration"
  | "recovery";

export type SessionProtocolChange =
  | { type: "lifecycle.set"; lifecycle: SessionProtocolSessionLifecycle }
  | { type: "cost.set"; costTotal: number }
  | { type: "settings.set"; settings: SessionProtocolSettingsSnapshot }
  | {
      type: "message.append";
      message: SessionProtocolMessage;
      timelineItem?: SessionProtocolTimelineItem;
    }
  | { type: "message.replace"; message: SessionProtocolMessage }
  | {
      type: "message.content.append";
      messageId: string;
      text?: string;
      thinking?: string;
      timestamp: number;
    }
  | { type: "timeline.append"; item: SessionProtocolTimelineItem }
  | { type: "timeline.replace"; item: SessionProtocolTimelineItem }
  | { type: "timeline.remove"; id: string }
  | { type: "tool.set"; tool: SessionProtocolToolRun }
  | { type: "tool.remove"; id: string }
  | { type: "agent.set"; agent: SessionProtocolAgentRun }
  | { type: "agent.remove"; id: string }
  | { type: "facet.set"; facet: SessionProtocolFacet }
  | { type: "facet.remove"; id: string };

export type SessionProtocolDelta =
  | {
      type: "snapshot.patch";
      changes: SessionProtocolChange[];
    }
  | {
      type: "snapshot.reset";
      snapshot: SessionProtocolSnapshot;
    };

export type SessionProtocolDeltaMessage = {
  version: typeof SESSION_PROTOCOL_VERSION;
  type: "session.delta";
  sessionId: string;
  fromRevision: number | null;
  toRevision: number;
  reason: SessionProtocolDeltaReason;
  delta: SessionProtocolDelta;
};

export type SessionProtocolReadyMessage = {
  version: typeof SESSION_PROTOCOL_VERSION;
  type: "ready";
  methods: SessionProtocolMethod[];
};

export type SessionProtocolClientToolCallMessage = {
  version: typeof SESSION_PROTOCOL_VERSION;
  type: "session.clientTool.call";
  sessionId: string;
  callId: string;
  toolName: string;
  arguments: unknown;
  ackDeadlineMs: number;
  executionDeadlineMs: number;
};

export type SessionProtocolClientToolCancelMessage = {
  version: typeof SESSION_PROTOCOL_VERSION;
  type: "session.clientTool.cancel";
  sessionId: string;
  callId: string;
  reason: "aborted" | "timeout" | "client-detached";
};

export type SessionProtocolClientToolMessage =
  | SessionProtocolClientToolCallMessage
  | SessionProtocolClientToolCancelMessage;

export type SessionProtocolEphemeralAgentThreadUpdateEvent = {
  type: "ephemeral-agent.thread-update";
  contextId: string;
  threadId: string;
  update: {
    costTotal: number;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      contextWindowUsageTokens: number;
      contextWindow: number;
    };
    lastActivityText?: string;
  };
};

export type SessionProtocolEphemeralEvent = SessionProtocolEphemeralAgentThreadUpdateEvent;

export type SessionProtocolEphemeralMessage = {
  version: typeof SESSION_PROTOCOL_VERSION;
  type: "session.ephemeral";
  sessionId: string;
  event: SessionProtocolEphemeralEvent;
};

export type SessionProtocolPendingUserMessagesMessage = {
  version: typeof SESSION_PROTOCOL_VERSION;
  type: "session.pendingUserMessages";
  sessionId: string;
  state: SessionProtocolPendingUserMessagesState;
};

export type SessionProtocolOutgoingMessage =
  | SessionProtocolResponseMessage
  | SessionProtocolDeltaMessage
  | SessionProtocolEphemeralMessage
  | SessionProtocolPendingUserMessagesMessage
  | SessionProtocolClientToolMessage
  | SessionProtocolReadyMessage;

export type SessionProtocolParsedOutgoingMessage =
  | SessionProtocolParsedResponseMessage
  | SessionProtocolDeltaMessage
  | SessionProtocolEphemeralMessage
  | SessionProtocolPendingUserMessagesMessage
  | SessionProtocolClientToolMessage
  | SessionProtocolReadyMessage;

export type SessionProtocolOutgoingParseFailureReason =
  | "invalid_payload"
  | "empty_line"
  | "parse_error"
  | "unsupported_version"
  | "unsupported_message_type"
  | "response_invalid_id";

export type SessionProtocolOutgoingParseFailure = {
  ok: false;
  reason: SessionProtocolOutgoingParseFailureReason;
  messageType: SessionProtocolOutgoingMessage["type"] | null;
  id: SessionProtocolRequestId | null;
  error: SessionProtocolError;
};

export type SessionProtocolOutgoingParseSuccess = {
  ok: true;
  message: SessionProtocolParsedOutgoingMessage;
};

export type SessionProtocolOutgoingParseResult =
  | SessionProtocolOutgoingParseFailure
  | SessionProtocolOutgoingParseSuccess;

export type SessionProtocolParseFailure = {
  ok: false;
  id: SessionProtocolRequestId | null;
  error: SessionProtocolError;
};

export type SessionProtocolParseSuccess = {
  ok: true;
  request: SessionProtocolRequestMessage;
};

export type SessionProtocolParseResult = SessionProtocolParseFailure | SessionProtocolParseSuccess;

export type SessionProtocolParamsValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SessionProtocolError };

export type SessionProtocolResultValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SessionProtocolError };

const sessionProtocolMethodSchema = z.enum(SESSION_PROTOCOL_METHODS);
const sessionProtocolMethodListSchema = z
  .array(sessionProtocolMethodSchema)
  .superRefine((methods, ctx) => {
    const seen = new Set<SessionProtocolMethod>();
    for (const method of methods) {
      if (seen.has(method)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate session protocol method '${method}'`,
        });
      }
      seen.add(method);
    }
  });
const sessionProtocolSessionLifecycleSchema = z.enum(["idle", "running"]);
const sessionProtocolErrorCodeSchema = z.enum(SESSION_PROTOCOL_ERROR_CODE_VALUES);
const nonEmptyStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
const sessionProtocolRequestIdSchema = nonEmptyStringSchema;
const nullableSessionProtocolRequestIdSchema = sessionProtocolRequestIdSchema.nullable();
const environmentVariableNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const environmentVariableValueSchema = z.string().refine((value) => !value.includes("\0"));
const environmentVariablesSchema = z.record(
  environmentVariableNameSchema,
  environmentVariableValueSchema,
);
const base64Schema = z
  .string()
  .refine(
    (value) => /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
    "must be valid base64",
  );
const boundedFileBase64Schema = base64Schema.max(
  4 * Math.ceil(SESSION_PROTOCOL_MAX_FILE_BYTES / 3),
);

function decodedBase64ByteLength(value: string): number {
  if (!value) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length * 3) / 4 - padding;
}

const modelTextContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
    textSignature: z.string().optional(),
  })
  .strip();
const modelImageContentSchema = z
  .object({
    type: z.literal("image"),
    data: z.string(),
    mimeType: nonEmptyStringSchema,
  })
  .strip();
const modelThinkingContentSchema = z
  .object({
    type: z.literal("thinking"),
    thinking: z.string(),
    thinkingSignature: z.string().optional(),
    redacted: z.boolean().optional(),
  })
  .strip();
const modelToolCallSchema = z
  .object({
    type: z.literal("toolCall"),
    id: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    arguments: z.record(z.string(), z.unknown()),
    thoughtSignature: z.string().optional(),
  })
  .strip();
const modelUsageSchema = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    cacheWrite1h: z.number().int().nonnegative().optional(),
    reasoning: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative(),
    cost: z
      .object({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cacheRead: z.number().nonnegative(),
        cacheWrite: z.number().nonnegative(),
        total: z.number().nonnegative(),
      })
      .strip(),
  })
  .strip();
const modelUserMessageSchema = z
  .object({
    role: z.literal("user"),
    content: z.union([
      z.string(),
      z.array(z.union([modelTextContentSchema, modelImageContentSchema])),
    ]),
    timestamp: z.number().finite(),
  })
  .strip();
const modelDiagnosticErrorSchema = z
  .object({
    name: z.string().optional(),
    message: z.string(),
    stack: z.string().optional(),
    code: z.union([z.string(), z.number()]).optional(),
  })
  .strip();
const modelDiagnosticSchema = z
  .object({
    type: z.string(),
    timestamp: z.number().finite(),
    error: modelDiagnosticErrorSchema.optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();
const modelAssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.array(
      z.union([modelTextContentSchema, modelThinkingContentSchema, modelToolCallSchema]),
    ),
    api: nonEmptyStringSchema,
    provider: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
    responseModel: nonEmptyStringSchema.optional(),
    responseId: nonEmptyStringSchema.optional(),
    diagnostics: z.array(modelDiagnosticSchema).optional(),
    usage: modelUsageSchema,
    stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
    errorMessage: z.string().optional(),
    timestamp: z.number().finite(),
  })
  .strip() as z.ZodType<AssistantMessage>;
const modelToolResultMessageSchema = z
  .object({
    role: z.literal("toolResult"),
    toolCallId: nonEmptyStringSchema,
    toolName: nonEmptyStringSchema,
    content: z.array(z.union([modelTextContentSchema, modelImageContentSchema])),
    details: z.unknown().optional(),
    addedToolNames: z.array(nonEmptyStringSchema).optional(),
    isError: z.boolean(),
    timestamp: z.number().finite(),
  })
  .strip();
const modelMessageSchema = z.union([
  modelUserMessageSchema,
  modelAssistantMessageSchema,
  modelToolResultMessageSchema,
]) as z.ZodType<Message>;

const sessionProtocolReadyMessageSchema = z
  .object({
    version: z.literal(SESSION_PROTOCOL_VERSION),
    type: z.literal("ready"),
    methods: sessionProtocolMethodListSchema,
  })
  .strip();

const sessionProtocolClientToolCallMessageSchema = z
  .object({
    version: z.literal(SESSION_PROTOCOL_VERSION),
    type: z.literal("session.clientTool.call"),
    sessionId: nonEmptyStringSchema,
    callId: nonEmptyStringSchema,
    toolName: nonEmptyStringSchema,
    arguments: z.unknown(),
    ackDeadlineMs: z.number().int().positive(),
    executionDeadlineMs: z.number().int().positive(),
  })
  .strip();

const sessionProtocolClientToolCancelMessageSchema = z
  .object({
    version: z.literal(SESSION_PROTOCOL_VERSION),
    type: z.literal("session.clientTool.cancel"),
    sessionId: nonEmptyStringSchema,
    callId: nonEmptyStringSchema,
    reason: z.enum(["aborted", "timeout", "client-detached"]),
  })
  .strip();

const sessionProtocolClientToolMessageSchema = z.discriminatedUnion("type", [
  sessionProtocolClientToolCallMessageSchema,
  sessionProtocolClientToolCancelMessageSchema,
]);

const sessionProtocolRequestEnvelopeSchema = z
  .object({
    version: z.literal(SESSION_PROTOCOL_VERSION),
    type: z.literal("request"),
    id: sessionProtocolRequestIdSchema,
    method: z.string(),
    params: z.unknown(),
  })
  .strip();

const sessionProtocolOutgoingRoutingSchema = z
  .object({
    version: z.literal(SESSION_PROTOCOL_VERSION),
    type: z.enum([
      "ready",
      "session.delta",
      "session.ephemeral",
      "session.pendingUserMessages",
      "session.clientTool.call",
      "session.clientTool.cancel",
      "response",
    ]),
  })
  .strip();

const sessionProtocolIdFieldSchema = z.object({ id: z.unknown() }).strip();
const sessionProtocolOkFieldSchema = z.object({ ok: z.unknown() }).strip();
const sessionProtocolVersionFieldSchema = z.object({ version: z.unknown() }).strip();
const sessionProtocolTypeFieldSchema = z.object({ type: z.unknown() }).strip();

const sessionProtocolResponseSuccessSchema = z
  .object({
    version: z.literal(SESSION_PROTOCOL_VERSION),
    type: z.literal("response"),
    id: sessionProtocolRequestIdSchema,
    ok: z.literal(true),
    result: z.unknown(),
  })
  .strip();

const sessionProtocolResponseErrorSchema = z
  .object({
    version: z.literal(SESSION_PROTOCOL_VERSION),
    type: z.literal("response"),
    id: nullableSessionProtocolRequestIdSchema,
    ok: z.literal(false),
    error: z
      .object({
        code: sessionProtocolErrorCodeSchema,
        message: z.string(),
        data: z.unknown().optional(),
      })
      .strip(),
  })
  .strip();

const sessionProtocolClientToolDefinitionSchema = z
  .object({
    name: nonEmptyStringSchema,
    description: z.string(),
    parameters: z.unknown(),
    executionTimeoutMs: z.number().int().positive().optional(),
  })
  .strip();

const sessionProtocolInitializeParamsSchema = z
  .object({
    client: z
      .object({
        name: nonEmptyStringSchema,
        version: nonEmptyStringSchema,
        tools: z.array(sessionProtocolClientToolDefinitionSchema).optional(),
      })
      .strip(),
  })
  .strip();

const sessionProtocolUserMessageParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    text: z.string(),
    historyEntryId: nonEmptyStringSchema.optional(),
  })
  .strip();

const sessionProtocolRecordParamsSchema = sessionProtocolUserMessageParamsSchema;

const sessionProtocolExecOptionsSchema = {
  sessionId: nonEmptyStringSchema,
  execId: nonEmptyStringSchema,
  cwd: nonEmptyStringSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxCaptureBytes: z
    .number()
    .int()
    .positive()
    .max(SESSION_PROTOCOL_MAX_EXEC_CAPTURE_BYTES)
    .optional(),
};

const sessionProtocolExecParamsSchema = z
  .object({
    ...sessionProtocolExecOptionsSchema,
    command: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolExecProcessParamsSchema = z
  .object({
    ...sessionProtocolExecOptionsSchema,
    argv: z.array(nonEmptyStringSchema).min(1),
    env: environmentVariablesSchema.optional(),
  })
  .strip();

const sessionProtocolCancelExecParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    execId: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolReadFileParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
    maxBytes: z.number().int().positive().max(SESSION_PROTOCOL_MAX_FILE_BYTES),
  })
  .strip();

const sessionProtocolWriteFileParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
    contentBase64: boundedFileBase64Schema,
  })
  .strip();

const sessionProtocolReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const sessionProtocolSampleToolSchema = z
  .object({
    name: nonEmptyStringSchema,
    description: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  })
  .strip();

const sessionProtocolSampleParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    context: z
      .object({
        systemPrompt: z.string(),
        messages: z.array(modelMessageSchema),
        tools: z.array(sessionProtocolSampleToolSchema).optional(),
      })
      .strip(),
    options: z
      .object({
        reasoning: sessionProtocolReasoningEffortSchema.optional(),
        maxTokens: z.number().int().positive().optional(),
      })
      .strip(),
  })
  .strip();

const sessionProtocolSessionIdParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolSetReasoningParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    reasoning: sessionProtocolReasoningEffortSchema,
  })
  .strip();

const sessionProtocolSetPersonaParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    personaId: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolResolvePromptParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    promptId: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolAutocompletePathsParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    query: z.string(),
    limit: z.number().int().positive().max(100),
  })
  .strip();

const sessionProtocolCompactParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    mode: z.enum(["summary-only", "summary-and-last"]),
    guidance: z.string().optional(),
  })
  .strip();

const sessionProtocolPruneParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    strategy: z.enum(["earliest", "largest", "smart"]),
    fraction: z.number().min(0).max(1),
    guidance: z.string().optional(),
  })
  .strip();

const sessionProtocolRewindParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    historyEntryId: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolTerminateSubagentParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    subagentId: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolEphemeralAgentToolSchema = z.enum([
  "bash",
  "write",
  "edit",
  "view_image",
  "web_search",
  "web_fetch",
]);

const sessionProtocolEphemeralCreateParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    instructions: nonEmptyStringSchema,
    tools: z.array(sessionProtocolEphemeralAgentToolSchema),
  })
  .strip();

const sessionProtocolEphemeralSubmitParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    contextId: nonEmptyStringSchema,
    threadId: nonEmptyStringSchema,
    forkFromThreadId: nonEmptyStringSchema.optional(),
    message: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolEphemeralCloseParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    contextId: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolClientToolAckParamsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    callId: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolClientToolResultParamsSchema = z.discriminatedUnion("ok", [
  z
    .object({
      sessionId: nonEmptyStringSchema,
      callId: nonEmptyStringSchema,
      ok: z.literal(true),
      content: z.string(),
    })
    .strip(),
  z
    .object({
      sessionId: nonEmptyStringSchema,
      callId: nonEmptyStringSchema,
      ok: z.literal(false),
      error: z.string(),
    })
    .strip(),
]);

const absolutePathSchema = nonEmptyStringSchema.refine((value) => value.startsWith("/"));

const sessionProtocolLocalExecutionEnvironmentInputSchema = z
  .object({
    kind: z.literal("local"),
    cwd: absolutePathSchema,
    env: environmentVariablesSchema.optional(),
  })
  .strip();

const sessionProtocolCloudflareSandboxExecutionEnvironmentInputSchema = z
  .object({
    kind: z.literal("cloudflare-sandbox"),
    bridgeId: nonEmptyStringSchema,
    sandboxId: nonEmptyStringSchema,
    cwd: absolutePathSchema,
  })
  .strip();

const sessionProtocolFlySpriteExecutionEnvironmentInputSchema = z
  .object({
    kind: z.literal("fly-sprite"),
    apiId: nonEmptyStringSchema,
    spriteName: nonEmptyStringSchema,
    cwd: absolutePathSchema,
  })
  .strip();

const sessionProtocolExecutionEnvironmentInputSchema = z.discriminatedUnion("kind", [
  sessionProtocolLocalExecutionEnvironmentInputSchema,
  sessionProtocolCloudflareSandboxExecutionEnvironmentInputSchema,
  sessionProtocolFlySpriteExecutionEnvironmentInputSchema,
]);

const sessionProtocolCreateParamsSchema = z
  .object({
    executionEnvironment: sessionProtocolExecutionEnvironmentInputSchema,
    personaId: nonEmptyStringSchema.optional(),
    reasoning: sessionProtocolReasoningEffortSchema.optional(),
  })
  .strip();

const sessionProtocolEmptyParamsSchema = z.object({}).strip();

const sessionProtocolSessionSummarySchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    lifecycle: sessionProtocolSessionLifecycleSchema,
  })
  .strip();

const sessionProtocolServiceTierSchema = z.enum(["priority", "flex"]);

const sessionProtocolModelSnapshotSchema = z
  .object({
    id: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    api: nonEmptyStringSchema,
    provider: nonEmptyStringSchema,
    baseUrl: z.string(),
    reasoning: z.boolean(),
    thinkingLevelMap: z
      .partialRecord(
        z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
        z.string().nullable(),
      )
      .optional(),
    input: z.array(z.enum(["text", "image"])),
    cost: z
      .object({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cacheRead: z.number().nonnegative(),
        cacheWrite: z.number().nonnegative(),
        tiers: z
          .array(
            z
              .object({
                inputTokensAbove: z.number().int().nonnegative(),
                input: z.number().nonnegative(),
                output: z.number().nonnegative(),
                cacheRead: z.number().nonnegative(),
                cacheWrite: z.number().nonnegative(),
              })
              .strip(),
          )
          .optional(),
      })
      .strip(),
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    compat: z.unknown().optional(),
  })
  .strip();

const sessionProtocolPersonaSettingsSnapshotSchema = z
  .object({
    reasoning: sessionProtocolReasoningEffortSchema.optional(),
    interleavedThinking: z.boolean().optional(),
    serviceTier: sessionProtocolServiceTierSchema.optional(),
  })
  .strip();

const sessionProtocolSubagentSnapshotSchema = z
  .object({
    description: z.string().optional(),
    tools: z.array(nonEmptyStringSchema).optional(),
    launchModels: z.array(nonEmptyStringSchema).optional(),
  })
  .strip();

const sessionProtocolPersonaSnapshotSchema = z
  .object({
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    description: z.string().optional(),
    allowedReasoningLevels: z.array(sessionProtocolReasoningEffortSchema).optional(),
    subagents: z.record(nonEmptyStringSchema, sessionProtocolSubagentSnapshotSchema).optional(),
    tools: z.array(nonEmptyStringSchema).optional(),
    skills: z.union([z.literal("*"), z.array(nonEmptyStringSchema)]),
    source: z.enum(["builtin", "user", "project"]),
  })
  .strip();

const sessionProtocolPromptTemplateSnapshotSchema = z
  .object({
    id: nonEmptyStringSchema,
    label: z.string().optional(),
    description: z.string().optional(),
  })
  .strip();

const sessionProtocolSkillSnapshotSchema = z
  .object({
    name: nonEmptyStringSchema,
    description: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolContentCatalogSnapshotSchema = z
  .object({
    personas: z.array(sessionProtocolPersonaSnapshotSchema),
    prompts: z.array(sessionProtocolPromptTemplateSnapshotSchema),
    skills: z.array(sessionProtocolSkillSnapshotSchema),
  })
  .strip();

const sessionProtocolSettingsSnapshotSchema = z
  .object({
    personaId: nonEmptyStringSchema,
    reasoning: sessionProtocolReasoningEffortSchema.optional(),
    serviceTier: sessionProtocolServiceTierSchema.optional(),
  })
  .strip();

const sessionProtocolBootstrapSnapshotSchema = z
  .object({
    model: sessionProtocolModelSnapshotSchema,
    prompt: z
      .object({
        environmentTag: nonEmptyStringSchema,
        subagentPrompts: z.record(z.string(), z.string()),
      })
      .strip(),
  })
  .strip();

const sessionProtocolLocalExecutionEnvironmentSnapshotSchema = z
  .object({
    kind: z.literal("local"),
    cwd: nonEmptyStringSchema,
    home: nonEmptyStringSchema,
    env: environmentVariablesSchema.optional(),
  })
  .strip();

const sessionProtocolCloudflareSandboxExecutionEnvironmentSnapshotSchema = z
  .object({
    kind: z.literal("cloudflare-sandbox"),
    bridgeId: nonEmptyStringSchema,
    sandboxId: nonEmptyStringSchema,
    cwd: nonEmptyStringSchema,
    home: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolFlySpriteExecutionEnvironmentSnapshotSchema = z
  .object({
    kind: z.literal("fly-sprite"),
    apiId: nonEmptyStringSchema,
    spriteName: nonEmptyStringSchema,
    cwd: nonEmptyStringSchema,
    home: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolExecutionEnvironmentSnapshotSchema = z.discriminatedUnion("kind", [
  sessionProtocolLocalExecutionEnvironmentSnapshotSchema,
  sessionProtocolCloudflareSandboxExecutionEnvironmentSnapshotSchema,
  sessionProtocolFlySpriteExecutionEnvironmentSnapshotSchema,
]);

const sessionProtocolSystemMessageSchema = z
  .object({
    role: z.literal("system"),
    content: z.string(),
    timestamp: z.number().finite(),
  })
  .strip();

const sessionProtocolDraftAssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.array(z.unknown()),
    timestamp: z.number().finite(),
  })
  .strip() as z.ZodType<SessionProtocolDraftAssistantMessage>;

const sessionProtocolMessagePayloadSchema = z.union([
  sessionProtocolSystemMessageSchema,
  modelMessageSchema,
  sessionProtocolDraftAssistantMessageSchema,
]) as z.ZodType<SessionProtocolMessagePayload>;

const sessionProtocolTurnOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      stopReason: z.enum(["stop", "length", "toolUse"]),
    })
    .strip(),
  z
    .object({
      status: z.literal("failed"),
      stopReason: z.literal("error"),
      errorMessage: z.string().optional(),
    })
    .strip(),
  z
    .object({
      status: z.literal("aborted"),
      stopReason: z.literal("aborted"),
    })
    .strip(),
  z
    .object({
      status: z.literal("blocked"),
      reason: z.literal("auto-compaction-failed"),
      message: z.string(),
    })
    .strip(),
]);

const sessionProtocolMessageSchema = z
  .object({
    id: nonEmptyStringSchema,
    state: z.enum(["draft", "committed", "interrupted", "discarded"]),
    modelVisible: z.boolean(),
    message: sessionProtocolMessagePayloadSchema,
    turn: sessionProtocolTurnOutcomeSchema.optional(),
  })
  .strip() as z.ZodType<SessionProtocolMessage>;

const sessionProtocolNoticeSchema = z
  .object({
    severity: z.enum(["info", "warn", "error"]),
    text: z.string(),
    timestamp: z.number().finite(),
  })
  .strip();

const sessionProtocolOperationSchema = z
  .object({
    kind: z.enum(["auto-compaction", "manual-compaction", "prune", "reload", "rewind"]),
    status: z.enum(["running", "succeeded", "failed", "cancelled", "skipped"]),
    startedAt: z.number().finite(),
    finishedAt: z.number().finite().optional(),
    summary: z.string().optional(),
    error: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();

const sessionProtocolTimelineItemSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("message"),
      id: nonEmptyStringSchema,
      messageId: nonEmptyStringSchema,
    })
    .strip(),
  z
    .object({
      type: z.literal("notice"),
      id: nonEmptyStringSchema,
      notice: sessionProtocolNoticeSchema,
    })
    .strip(),
  z
    .object({
      type: z.literal("operation"),
      id: nonEmptyStringSchema,
      operation: sessionProtocolOperationSchema,
    })
    .strip(),
]);

const sessionProtocolToolRunBaseSchema = z.object({
  id: nonEmptyStringSchema,
  toolCallId: nonEmptyStringSchema,
  toolName: nonEmptyStringSchema,
  facetIds: z.array(nonEmptyStringSchema),
});

const sessionProtocolToolPositionSchema = z
  .object({
    messageId: nonEmptyStringSchema,
    contentIndex: z.number().int().nonnegative(),
  })
  .strip();

const sessionProtocolToolRunSchema = z.discriminatedUnion("status", [
  sessionProtocolToolRunBaseSchema
    .extend({
      status: z.literal("streaming"),
      origin: sessionProtocolToolPositionSchema,
    })
    .strip(),
  sessionProtocolToolRunBaseSchema
    .extend({
      status: z.enum(["queued", "running", "succeeded", "failed", "blocked", "cancelled"]),
      call: sessionProtocolToolPositionSchema,
      startedAt: z.number().finite().optional(),
      finishedAt: z.number().finite().optional(),
      resultMessageId: nonEmptyStringSchema.optional(),
      summary: z.string().optional(),
      error: z.string().optional(),
    })
    .strip(),
]);

const sessionProtocolAgentUsageSchema = z
  .object({
    input: z.number().finite(),
    output: z.number().finite(),
    cacheRead: z.number().finite(),
    cacheWrite: z.number().finite(),
    contextWindowUsageTokens: z.number().finite(),
    contextWindow: z.number().finite(),
  })
  .strip();

const sessionProtocolAgentRunSchema = z
  .object({
    id: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    title: nonEmptyStringSchema,
    status: z.enum(["running", "succeeded", "failed", "cancelled"]),
    modelLabel: z.string().optional(),
    costTotal: z.number().finite(),
    turns: z.number().finite(),
    toolCalls: z.number().finite(),
    usage: sessionProtocolAgentUsageSchema,
    startedAt: z.number().finite(),
    finishedAt: z.number().finite().optional(),
    abortRequested: z.boolean(),
    progress: z.string().optional(),
    finalText: z.string().optional(),
    error: z.string().optional(),
  })
  .strip();

const sessionProtocolFacetSubjectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session") }).strip(),
  z.object({ type: z.literal("message"), id: nonEmptyStringSchema }).strip(),
  z.object({ type: z.literal("tool"), id: nonEmptyStringSchema }).strip(),
  z.object({ type: z.literal("agent"), id: nonEmptyStringSchema }).strip(),
  z.object({ type: z.literal("operation"), id: nonEmptyStringSchema }).strip(),
]);

const sessionProtocolFacetSchema = z
  .object({
    id: nonEmptyStringSchema,
    subject: sessionProtocolFacetSubjectSchema,
    kind: nonEmptyStringSchema,
    version: z.number().int().positive(),
    data: z.record(z.string(), z.unknown()),
  })
  .strip();

const sessionProtocolSnapshotSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    revision: z.number().int().positive(),
    lifecycle: sessionProtocolSessionLifecycleSchema,
    costTotal: z.number().nonnegative(),
    settings: sessionProtocolSettingsSnapshotSchema,
    bootstrap: sessionProtocolBootstrapSnapshotSchema,
    catalog: sessionProtocolContentCatalogSnapshotSchema,
    executionEnvironment: sessionProtocolExecutionEnvironmentSnapshotSchema,
    messages: z.array(sessionProtocolMessageSchema),
    timeline: z.array(sessionProtocolTimelineItemSchema),
    tools: z.record(nonEmptyStringSchema, sessionProtocolToolRunSchema),
    agents: z.record(nonEmptyStringSchema, sessionProtocolAgentRunSchema),
    facets: z.record(nonEmptyStringSchema, sessionProtocolFacetSchema),
  })
  .strip()
  .superRefine((snapshot, ctx) => {
    const messagesById = new Map<string, SessionProtocolMessage>();
    for (const message of snapshot.messages) {
      if (messagesById.has(message.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["messages"],
          message: `duplicate message id '${message.id}'`,
        });
      }
      if (message.turn && message.message.role !== "user") {
        ctx.addIssue({
          code: "custom",
          path: ["messages"],
          message: `turn outcome belongs to non-user message '${message.id}'`,
        });
      }
      messagesById.set(message.id, message);
    }

    const timelineIds = new Set<string>();
    const operationIds = new Set<string>();
    for (const item of snapshot.timeline) {
      if (timelineIds.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["timeline"],
          message: `duplicate timeline item id '${item.id}'`,
        });
      }
      timelineIds.add(item.id);
      if (item.type === "message" && !messagesById.has(item.messageId)) {
        ctx.addIssue({
          code: "custom",
          path: ["timeline"],
          message: `timeline message item '${item.id}' references unknown message '${item.messageId}'`,
        });
      }
      if (item.type === "operation") {
        operationIds.add(item.id);
      }
    }

    for (const [id, tool] of Object.entries(snapshot.tools)) {
      if (id !== tool.id || id !== tool.toolCallId) {
        ctx.addIssue({
          code: "custom",
          path: ["tools", id],
          message: `tool map key '${id}' does not match embedded identity`,
        });
      }
      for (const facetId of tool.facetIds) {
        const facet = snapshot.facets[facetId];
        if (facet === undefined || facet.subject.type !== "tool" || facet.subject.id !== id) {
          ctx.addIssue({
            code: "custom",
            path: ["tools", id, "facetIds"],
            message: `tool '${id}' references invalid facet '${facetId}'`,
          });
        }
      }
      if (tool.status === "streaming") {
        const originMessage = messagesById.get(tool.origin.messageId);
        if (
          originMessage === undefined ||
          originMessage.state !== "draft" ||
          originMessage.message.role !== "assistant"
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["tools", id, "origin"],
            message: `streaming tool '${id}' does not reference a draft assistant message`,
          });
        }
        continue;
      }

      const callMessage = messagesById.get(tool.call.messageId);
      if (callMessage === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["tools", id, "call", "messageId"],
          message: `tool '${id}' references unknown call message '${tool.call.messageId}'`,
        });
      } else {
        const callContent =
          callMessage.message.role === "assistant"
            ? callMessage.message.content[tool.call.contentIndex]
            : undefined;
        if (
          typeof callContent !== "object" ||
          callContent === null ||
          !("type" in callContent) ||
          callContent.type !== "toolCall" ||
          !("id" in callContent) ||
          callContent.id !== tool.toolCallId ||
          !("name" in callContent) ||
          callContent.name !== tool.toolName
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["tools", id, "call"],
            message: `tool '${id}' does not match its call message content`,
          });
        }
      }
      if (tool.resultMessageId !== undefined) {
        const resultMessage = messagesById.get(tool.resultMessageId);
        if (resultMessage === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["tools", id, "resultMessageId"],
            message: `tool '${id}' references unknown result message '${tool.resultMessageId}'`,
          });
        } else if (
          resultMessage.message.role !== "toolResult" ||
          resultMessage.message.toolCallId !== tool.toolCallId ||
          resultMessage.message.toolName !== tool.toolName
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["tools", id, "resultMessageId"],
            message: `tool '${id}' does not match its result message`,
          });
        }
      }
    }

    for (const [id, agent] of Object.entries(snapshot.agents)) {
      if (id !== agent.id) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", id],
          message: `agent map key '${id}' does not match embedded id '${agent.id}'`,
        });
      }
    }

    for (const [id, facet] of Object.entries(snapshot.facets)) {
      if (id !== facet.id) {
        ctx.addIssue({
          code: "custom",
          path: ["facets", id],
          message: `facet map key '${id}' does not match embedded id '${facet.id}'`,
        });
      }
      const subjectExists =
        facet.subject.type === "session" ||
        (facet.subject.type === "message" && messagesById.has(facet.subject.id)) ||
        (facet.subject.type === "tool" && snapshot.tools[facet.subject.id] !== undefined) ||
        (facet.subject.type === "agent" && snapshot.agents[facet.subject.id] !== undefined) ||
        (facet.subject.type === "operation" && operationIds.has(facet.subject.id));
      if (!subjectExists) {
        ctx.addIssue({
          code: "custom",
          path: ["facets", id, "subject"],
          message: `facet '${id}' references unknown ${facet.subject.type} subject`,
        });
      }
    }
  }) as z.ZodType<SessionProtocolSnapshot>;

const sessionProtocolDeltaReasonSchema = z.enum([
  "user-message",
  "assistant-stream",
  "assistant-message",
  "tool-run",
  "tool-result",
  "notice",
  "agent-run",
  "maintenance",
  "configuration",
  "recovery",
]);

const sessionProtocolChangeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("lifecycle.set"),
      lifecycle: sessionProtocolSessionLifecycleSchema,
    })
    .strip(),
  z
    .object({
      type: z.literal("cost.set"),
      costTotal: z.number().nonnegative(),
    })
    .strip(),
  z
    .object({
      type: z.literal("settings.set"),
      settings: sessionProtocolSettingsSnapshotSchema,
    })
    .strip(),
  z
    .object({
      type: z.literal("message.append"),
      message: sessionProtocolMessageSchema,
      timelineItem: sessionProtocolTimelineItemSchema.optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal("message.replace"),
      message: sessionProtocolMessageSchema,
    })
    .strip(),
  z
    .object({
      type: z.literal("message.content.append"),
      messageId: nonEmptyStringSchema,
      text: z.string().optional(),
      thinking: z.string().optional(),
      timestamp: z.number().finite(),
    })
    .strip(),
  z
    .object({
      type: z.literal("timeline.append"),
      item: sessionProtocolTimelineItemSchema,
    })
    .strip(),
  z
    .object({
      type: z.literal("timeline.replace"),
      item: sessionProtocolTimelineItemSchema,
    })
    .strip(),
  z
    .object({
      type: z.literal("timeline.remove"),
      id: nonEmptyStringSchema,
    })
    .strip(),
  z
    .object({
      type: z.literal("tool.set"),
      tool: sessionProtocolToolRunSchema,
    })
    .strip(),
  z
    .object({
      type: z.literal("tool.remove"),
      id: nonEmptyStringSchema,
    })
    .strip(),
  z
    .object({
      type: z.literal("agent.set"),
      agent: sessionProtocolAgentRunSchema,
    })
    .strip(),
  z
    .object({
      type: z.literal("agent.remove"),
      id: nonEmptyStringSchema,
    })
    .strip(),
  z
    .object({
      type: z.literal("facet.set"),
      facet: sessionProtocolFacetSchema,
    })
    .strip(),
  z
    .object({
      type: z.literal("facet.remove"),
      id: nonEmptyStringSchema,
    })
    .strip(),
]) as z.ZodType<SessionProtocolChange>;

const sessionProtocolDeltaSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("snapshot.patch"),
      changes: z.array(sessionProtocolChangeSchema),
    })
    .strip(),
  z
    .object({
      type: z.literal("snapshot.reset"),
      snapshot: sessionProtocolSnapshotSchema,
    })
    .strip(),
]) as z.ZodType<SessionProtocolDelta>;

const sessionProtocolDeltaMessageSchema = z
  .object({
    version: z.literal(SESSION_PROTOCOL_VERSION),
    type: z.literal("session.delta"),
    sessionId: nonEmptyStringSchema,
    fromRevision: z.number().int().positive().nullable(),
    toRevision: z.number().int().positive(),
    reason: sessionProtocolDeltaReasonSchema,
    delta: sessionProtocolDeltaSchema,
  })
  .strip()
  .superRefine((message, ctx) => {
    if (message.delta.type === "snapshot.patch" && message.fromRevision === null) {
      ctx.addIssue({
        code: "custom",
        path: ["fromRevision"],
        message: "snapshot.patch delta requires fromRevision",
      });
    }
    if (
      message.delta.type === "snapshot.patch" &&
      message.fromRevision !== null &&
      message.toRevision <= message.fromRevision
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["toRevision"],
        message: "snapshot.patch toRevision must be greater than fromRevision",
      });
    }
    if (message.delta.type === "snapshot.patch") {
      message.delta.changes.forEach((change, index) => {
        if (
          change.type === "message.content.append" &&
          (change.text === undefined || change.text.length === 0) &&
          (change.thinking === undefined || change.thinking.length === 0)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["delta", "changes", index],
            message: "message.content.append requires text or thinking",
          });
        }
      });
    }
    if (
      message.delta.type === "snapshot.reset" &&
      message.delta.snapshot.revision !== message.toRevision
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["delta", "snapshot", "revision"],
        message: "snapshot.reset revision must equal toRevision",
      });
    }
  });

const sessionProtocolEphemeralAgentThreadUpdateEventSchema = z
  .object({
    type: z.literal("ephemeral-agent.thread-update"),
    contextId: nonEmptyStringSchema,
    threadId: nonEmptyStringSchema,
    update: z
      .object({
        costTotal: z.number().finite(),
        usage: sessionProtocolAgentUsageSchema,
        lastActivityText: z.string().optional(),
      })
      .strip(),
  })
  .strip();

const sessionProtocolEphemeralEventSchema = sessionProtocolEphemeralAgentThreadUpdateEventSchema;

const sessionProtocolEphemeralMessageSchema = z
  .object({
    version: z.literal(SESSION_PROTOCOL_VERSION),
    type: z.literal("session.ephemeral"),
    sessionId: nonEmptyStringSchema,
    event: sessionProtocolEphemeralEventSchema,
  })
  .strip();

const sessionProtocolPendingUserMessageSchema = z
  .object({
    id: nonEmptyStringSchema,
    mode: z.enum(["queue", "steer"]),
    text: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolPendingUserMessagesStateSchema = z
  .object({
    revision: z.number().int().positive(),
    messages: z.array(sessionProtocolPendingUserMessageSchema),
  })
  .strip()
  .superRefine((state, ctx) => {
    const ids = new Set<string>();
    for (const message of state.messages) {
      if (ids.has(message.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["messages"],
          message: `duplicate pending user message id '${message.id}'`,
        });
      }
      ids.add(message.id);
    }
  }) as z.ZodType<SessionProtocolPendingUserMessagesState>;

const sessionProtocolPendingUserMessagesMessageSchema = z
  .object({
    version: z.literal(SESSION_PROTOCOL_VERSION),
    type: z.literal("session.pendingUserMessages"),
    sessionId: nonEmptyStringSchema,
    state: sessionProtocolPendingUserMessagesStateSchema,
  })
  .strip();

const sessionProtocolInitializeResultSchema = z
  .object({
    protocolVersion: z.literal(SESSION_PROTOCOL_VERSION),
    methods: sessionProtocolMethodListSchema,
    alreadyInitialized: z.boolean(),
  })
  .strip();

const sessionProtocolCreateResultSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolObserveResultSchema = z
  .object({
    snapshot: sessionProtocolSnapshotSchema,
    pendingUserMessages: sessionProtocolPendingUserMessagesStateSchema,
  })
  .strip();

const sessionProtocolListResultSchema = z
  .object({
    sessions: z.array(sessionProtocolSessionSummarySchema),
  })
  .strip();

const sessionProtocolSubmitResultSchema = z
  .object({
    turn: sessionProtocolTurnOutcomeSchema,
  })
  .strip();

const sessionProtocolTurnResultSchema = sessionProtocolSubmitResultSchema;

const sessionProtocolRetryResultSchema = sessionProtocolTurnResultSchema;

const sessionProtocolSubmitWithUserResultSchema = sessionProtocolTurnResultSchema
  .extend({
    userHistoryEntryId: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolCancelPendingMessagesResultSchema = z
  .object({
    cancelled: z.array(sessionProtocolPendingUserMessageSchema),
  })
  .strip();

const sessionProtocolRecordResultSchema = z
  .object({
    snapshot: sessionProtocolSnapshotSchema,
    userHistoryEntryId: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolExecResultSchema = z
  .object({
    output: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int().nullable(),
    truncated: z.boolean(),
    timedOut: z.boolean(),
    aborted: z.boolean(),
    closeSignal: z.string().nullable(),
  })
  .strip();

const sessionProtocolCancelExecResultSchema = z
  .object({
    cancelled: z.boolean(),
  })
  .strip();

const sessionProtocolReadFileResultSchema = z
  .object({
    contentBase64: boundedFileBase64Schema,
    bytes: z.number().int().nonnegative().max(SESSION_PROTOCOL_MAX_FILE_BYTES),
  })
  .strip()
  .refine((value) => decodedBase64ByteLength(value.contentBase64) === value.bytes, {
    message: "bytes must match decoded contentBase64 length",
    path: ["bytes"],
  });

const sessionProtocolWriteFileResultSchema = z
  .object({
    path: nonEmptyStringSchema,
    bytes: z.number().int().nonnegative(),
  })
  .strip();

const sessionProtocolSampleResultSchema = z
  .object({
    message: modelAssistantMessageSchema,
  })
  .strip();

const sessionProtocolInterruptResultSchema = z
  .object({
    interrupted: z.boolean(),
    isTurnRunning: z.boolean(),
  })
  .strip();

const sessionProtocolSettingsUpdateResultSchema = z
  .object({
    revision: z.number().int().positive(),
    settings: sessionProtocolSettingsSnapshotSchema,
  })
  .strip();

const sessionProtocolCompactResultSchema = z
  .object({
    snapshot: sessionProtocolSnapshotSchema,
    compactionMessage: nonEmptyStringSchema,
    includedLastAssistant: z.boolean(),
  })
  .strip();

const sessionProtocolPruneResultSchema = z
  .object({
    snapshot: sessionProtocolSnapshotSchema,
    message: nonEmptyStringSchema,
    noop: z.boolean(),
    bashResultsPruned: z.number().int().nonnegative(),
    editCallsPruned: z.number().int().nonnegative(),
    editResultsPruned: z.number().int().nonnegative(),
    bytesPruned: z.number().int().nonnegative(),
  })
  .strip();

const sessionProtocolRewindResultSchema = z
  .object({
    snapshot: sessionProtocolSnapshotSchema,
    historyEntryId: nonEmptyStringSchema,
    text: z.string(),
    removedEntryIds: z.array(nonEmptyStringSchema),
  })
  .strip();

const sessionProtocolReloadResultSchema = z
  .object({
    snapshot: sessionProtocolSnapshotSchema,
    warnings: z.array(z.string()),
    counts: z
      .object({
        personas: z.number().int().nonnegative(),
        prompts: z.number().int().nonnegative(),
        skills: z.number().int().nonnegative(),
      })
      .strip(),
  })
  .strip();

const sessionProtocolResolvePromptResultSchema = z
  .object({
    promptId: nonEmptyStringSchema,
    text: z.string(),
  })
  .strip();

const sessionProtocolAutocompletePathsResultSchema = z
  .object({
    paths: z.array(z.string()),
  })
  .strip();

const sessionProtocolUnobserveResultSchema = z
  .object({
    unobserved: z.literal(true),
  })
  .strip();

const sessionProtocolTerminateSubagentResultSchema = z
  .object({
    found: z.boolean(),
  })
  .strip();

const sessionProtocolEphemeralCreateResultSchema = z
  .object({
    contextId: nonEmptyStringSchema,
  })
  .strip();

const sessionProtocolEphemeralSubmitResultSchema = z
  .object({
    threadId: nonEmptyStringSchema,
    response: z.string(),
  })
  .strip();

const sessionProtocolEphemeralCloseResultSchema = z
  .object({
    closed: z.boolean(),
  })
  .strip();

const sessionProtocolClientToolAckResultSchema = z
  .object({
    accepted: z.boolean(),
  })
  .strip();

const sessionProtocolClientToolResultResultSchema = z
  .object({
    accepted: z.boolean(),
  })
  .strip();

export function isSessionProtocolMethod(value: unknown): value is SessionProtocolMethod {
  return typeof value === "string" && SESSION_PROTOCOL_METHOD_SET.has(value);
}

export function createSessionProtocolError(
  code: SessionProtocolErrorCode,
  message: string,
  data?: unknown,
): SessionProtocolError {
  return data === undefined ? { code, message } : { code, message, data };
}

export function createSessionProtocolSuccessResponse<M extends SessionProtocolMethod>(
  id: SessionProtocolRequestId,
  method: M,
  result: SessionProtocolResultByMethod[M],
): SessionProtocolSuccessResponseMessage {
  const parsed = validateSessionProtocolResult(method, result);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }

  const response = {
    version: SESSION_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: true,
    result: parsed.value,
  };
  const parsedResponse = sessionProtocolResponseSuccessSchema.safeParse(response);
  if (!parsedResponse.success) {
    throw new Error(
      `session protocol success response is invalid: ${formatZodError(parsedResponse.error)}`,
    );
  }

  return parsedResponse.data as SessionProtocolSuccessResponseMessage;
}

export function createSessionProtocolErrorResponse(
  id: SessionProtocolRequestId | null,
  code: SessionProtocolErrorCode,
  message: string,
  data?: unknown,
): SessionProtocolErrorResponseMessage {
  const response = {
    version: SESSION_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: false,
    error: createSessionProtocolError(code, message, data),
  };
  const parsed = sessionProtocolResponseErrorSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error(`session protocol error response is invalid: ${formatZodError(parsed.error)}`);
  }

  return parsed.data as SessionProtocolErrorResponseMessage;
}

export function createSessionProtocolDeltaMessage(options: {
  sessionId: string;
  fromRevision: number | null;
  toRevision: number;
  reason: SessionProtocolDeltaReason;
  delta: SessionProtocolDelta;
}): SessionProtocolDeltaMessage {
  const message = {
    version: SESSION_PROTOCOL_VERSION,
    type: "session.delta",
    sessionId: options.sessionId,
    fromRevision: options.fromRevision,
    toRevision: options.toRevision,
    reason: options.reason,
    delta: options.delta,
  };
  const parsedMessage = sessionProtocolDeltaMessageSchema.safeParse(message);
  if (!parsedMessage.success) {
    throw new Error(
      `session protocol delta message is invalid: ${formatZodError(parsedMessage.error)}`,
    );
  }

  return parsedMessage.data as SessionProtocolDeltaMessage;
}

export function createSessionProtocolEphemeralMessage(options: {
  sessionId: string;
  event: SessionProtocolEphemeralEvent;
}): SessionProtocolEphemeralMessage {
  const message = {
    version: SESSION_PROTOCOL_VERSION,
    type: "session.ephemeral",
    sessionId: options.sessionId,
    event: options.event,
  };
  const parsedMessage = sessionProtocolEphemeralMessageSchema.safeParse(message);
  if (!parsedMessage.success) {
    throw new Error(
      `session protocol ephemeral message is invalid: ${formatZodError(parsedMessage.error)}`,
    );
  }

  return parsedMessage.data as SessionProtocolEphemeralMessage;
}

export function createSessionProtocolPendingUserMessagesMessage(options: {
  sessionId: string;
  state: SessionProtocolPendingUserMessagesState;
}): SessionProtocolPendingUserMessagesMessage {
  const message = {
    version: SESSION_PROTOCOL_VERSION,
    type: "session.pendingUserMessages",
    sessionId: options.sessionId,
    state: options.state,
  };
  const parsedMessage = sessionProtocolPendingUserMessagesMessageSchema.safeParse(message);
  if (!parsedMessage.success) {
    throw new Error(
      `session protocol pending user messages message is invalid: ${formatZodError(parsedMessage.error)}`,
    );
  }

  return parsedMessage.data as SessionProtocolPendingUserMessagesMessage;
}

export function applySessionProtocolDelta(
  snapshot: SessionProtocolSnapshot,
  message: SessionProtocolDeltaMessage,
): SessionProtocolSnapshot {
  if (message.sessionId !== snapshot.sessionId) {
    throw new Error(
      `session delta targets '${message.sessionId}' but current snapshot is '${snapshot.sessionId}'`,
    );
  }

  if (message.delta.type === "snapshot.reset") {
    return structuredClone(message.delta.snapshot);
  }

  if (message.fromRevision !== snapshot.revision) {
    throw new Error(
      `session delta revision mismatch: expected ${snapshot.revision}, got ${message.fromRevision}`,
    );
  }

  const contentAppendSnapshot = applyContentAppendDelta(snapshot, message);
  if (contentAppendSnapshot) {
    return contentAppendSnapshot;
  }

  const keyedPatchSnapshot = applyKeyedRecordDelta(snapshot, message);
  if (keyedPatchSnapshot) {
    return keyedPatchSnapshot;
  }

  const next = structuredClone(snapshot);
  next.revision = message.toRevision;
  for (const change of message.delta.changes) {
    switch (change.type) {
      case "lifecycle.set":
        next.lifecycle = change.lifecycle;
        break;
      case "cost.set":
        next.costTotal = change.costTotal;
        break;
      case "settings.set":
        next.settings = structuredClone(change.settings);
        break;
      case "message.append":
        next.messages.push(structuredClone(change.message));
        if (change.timelineItem) {
          next.timeline.push(structuredClone(change.timelineItem));
        }
        break;
      case "message.replace": {
        const index = next.messages.findIndex((entry) => entry.id === change.message.id);
        if (index === -1) {
          next.messages.push(structuredClone(change.message));
        } else {
          next.messages[index] = structuredClone(change.message);
        }
        break;
      }
      case "message.content.append": {
        appendMessageContent(next, change);
        break;
      }
      case "timeline.append":
        next.timeline.push(structuredClone(change.item));
        break;
      case "timeline.replace": {
        const index = next.timeline.findIndex((item) => item.id === change.item.id);
        if (index === -1) {
          next.timeline.push(structuredClone(change.item));
        } else {
          next.timeline[index] = structuredClone(change.item);
        }
        break;
      }
      case "timeline.remove":
        next.timeline = next.timeline.filter((item) => item.id !== change.id);
        break;
      case "tool.set":
        next.tools[change.tool.id] = structuredClone(change.tool);
        break;
      case "tool.remove":
        delete next.tools[change.id];
        break;
      case "agent.set":
        next.agents[change.agent.id] = structuredClone(change.agent);
        break;
      case "agent.remove":
        delete next.agents[change.id];
        break;
      case "facet.set":
        next.facets[change.facet.id] = structuredClone(change.facet);
        break;
      case "facet.remove":
        delete next.facets[change.id];
        break;
    }
  }

  return next;
}

function applyKeyedRecordDelta(
  snapshot: SessionProtocolSnapshot,
  message: SessionProtocolDeltaMessage,
): SessionProtocolSnapshot | undefined {
  if (message.delta.type !== "snapshot.patch") {
    return undefined;
  }

  let nextTools: SessionProtocolSnapshot["tools"] | undefined;
  let nextAgents: SessionProtocolSnapshot["agents"] | undefined;
  let nextFacets: SessionProtocolSnapshot["facets"] | undefined;

  const cloneTools = () => {
    nextTools ??= { ...snapshot.tools };
    return nextTools;
  };
  const cloneAgents = () => {
    nextAgents ??= { ...snapshot.agents };
    return nextAgents;
  };
  const cloneFacets = () => {
    nextFacets ??= { ...snapshot.facets };
    return nextFacets;
  };

  for (const change of message.delta.changes) {
    switch (change.type) {
      case "tool.set":
        cloneTools()[change.tool.id] = structuredClone(change.tool);
        break;
      case "tool.remove":
        delete cloneTools()[change.id];
        break;
      case "agent.set":
        cloneAgents()[change.agent.id] = structuredClone(change.agent);
        break;
      case "agent.remove":
        delete cloneAgents()[change.id];
        break;
      case "facet.set":
        cloneFacets()[change.facet.id] = structuredClone(change.facet);
        break;
      case "facet.remove":
        delete cloneFacets()[change.id];
        break;
      default:
        return undefined;
    }
  }

  return {
    ...snapshot,
    revision: message.toRevision,
    ...(nextTools ? { tools: nextTools } : {}),
    ...(nextAgents ? { agents: nextAgents } : {}),
    ...(nextFacets ? { facets: nextFacets } : {}),
  };
}

function applyContentAppendDelta(
  snapshot: SessionProtocolSnapshot,
  message: SessionProtocolDeltaMessage,
): SessionProtocolSnapshot | undefined {
  if (
    message.delta.type !== "snapshot.patch" ||
    message.delta.changes.length !== 1 ||
    message.delta.changes[0]?.type !== "message.content.append"
  ) {
    return undefined;
  }

  const change = message.delta.changes[0];
  const messageIndex = snapshot.messages.findIndex((entry) => entry.id === change.messageId);
  if (messageIndex === -1) {
    throw new Error(`message.content.append targets unknown message '${change.messageId}'`);
  }

  const target = snapshot.messages[messageIndex]!;
  if (target.message.role !== "assistant" || !Array.isArray(target.message.content)) {
    throw new Error(`message.content.append targets non-assistant message '${change.messageId}'`);
  }
  if (target.state !== "draft") {
    throw new Error(`message.content.append targets non-draft message '${change.messageId}'`);
  }

  const nextMessages = [...snapshot.messages];
  const nextTarget: SessionProtocolMessage = {
    ...target,
    message: {
      ...target.message,
      content: target.message.content.map((item) => ({ ...item })),
    },
  };
  nextMessages[messageIndex] = nextTarget;
  const next: SessionProtocolSnapshot = {
    ...snapshot,
    revision: message.toRevision,
    messages: nextMessages,
  };
  appendMessageContent(next, change);
  return next;
}

function appendMessageContent(
  snapshot: SessionProtocolSnapshot,
  change: Extract<SessionProtocolChange, { type: "message.content.append" }>,
): void {
  const entry = snapshot.messages.find((message) => message.id === change.messageId);
  if (!entry) {
    throw new Error(`message.content.append targets unknown message '${change.messageId}'`);
  }
  const message = entry.message;
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    throw new Error(`message.content.append targets non-assistant message '${change.messageId}'`);
  }
  if (entry.state !== "draft") {
    throw new Error(`message.content.append targets non-draft message '${change.messageId}'`);
  }

  if (change.thinking) {
    appendAssistantTextBlock(message.content, "thinking", change.thinking);
  }
  if (change.text) {
    appendAssistantTextBlock(message.content, "text", change.text);
  }
  message.timestamp = change.timestamp;
}

function appendAssistantTextBlock(
  content: SessionProtocolDraftAssistantMessage["content"],
  type: "text" | "thinking",
  value: string,
): void {
  if (type === "text") {
    const existing = content.find((item) => item.type === "text");
    if (existing) {
      existing.text += value;
      return;
    }
    content.push({ type: "text", text: value });
    return;
  }

  const existing = content.find((item) => item.type === "thinking");
  if (existing) {
    existing.thinking += value;
    return;
  }

  const textIndex = content.findIndex((item) => item.type === "text");
  if (textIndex === -1) {
    content.push({ type: "thinking", thinking: value });
    return;
  }
  content.splice(textIndex, 0, { type: "thinking", thinking: value });
}

export function createSessionProtocolReadyMessage(): SessionProtocolReadyMessage {
  return {
    version: SESSION_PROTOCOL_VERSION,
    type: "ready",
    methods: [...SESSION_PROTOCOL_METHODS],
  };
}

export function serializeSessionProtocolMessage(message: SessionProtocolOutgoingMessage): string {
  return JSON.stringify(message);
}

export function parseSessionProtocolRequestLine(line: string): SessionProtocolParseResult {
  if (isBlankProtocolLine(line)) {
    return {
      ok: false,
      id: null,
      error: createSessionProtocolError(
        SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
        "request line cannot be empty",
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return {
      ok: false,
      id: null,
      error: createSessionProtocolError(
        SESSION_PROTOCOL_ERROR_CODES.parseError,
        "failed to parse JSON request line",
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      ),
    };
  }

  const parsedIdField = sessionProtocolIdFieldSchema.safeParse(parsed);
  const requestIdCandidate = parsedIdField.success
    ? parseNullableRequestId(parsedIdField.data.id)
    : null;
  const requestId = requestIdCandidate?.ok ? requestIdCandidate.id : null;

  const requestEnvelope = sessionProtocolRequestEnvelopeSchema.safeParse(parsed);
  if (!requestEnvelope.success) {
    if (hasIssue(requestEnvelope.error, [], "invalid_type")) {
      return {
        ok: false,
        id: null,
        error: createSessionProtocolError(
          SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
          "request must be a JSON object",
        ),
      };
    }

    if (hasIssue(requestEnvelope.error, ["id"])) {
      return {
        ok: false,
        id: null,
        error: createSessionProtocolError(
          SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
          "request id must be a non-empty string",
        ),
      };
    }

    if (hasIssue(requestEnvelope.error, ["version"])) {
      const parsedVersionField = sessionProtocolVersionFieldSchema.safeParse(parsed);
      const version = parsedVersionField.success ? parsedVersionField.data.version : undefined;
      return {
        ok: false,
        id: requestId,
        error: createSessionProtocolError(
          SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
          `unsupported session protocol version: ${String(version)}`,
        ),
      };
    }

    if (hasIssue(requestEnvelope.error, ["type"])) {
      return {
        ok: false,
        id: requestId,
        error: createSessionProtocolError(
          SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
          'request.type must be "request"',
        ),
      };
    }

    if (hasIssue(requestEnvelope.error, ["method"])) {
      return {
        ok: false,
        id: requestId,
        error: createSessionProtocolError(
          SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
          "request.method must be a string",
        ),
      };
    }

    if (hasIssue(requestEnvelope.error, ["params"])) {
      return {
        ok: false,
        id: requestId,
        error: createSessionProtocolError(
          SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
          "request.params is required",
        ),
      };
    }

    return {
      ok: false,
      id: requestId,
      error: createSessionProtocolError(
        SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
        `request is invalid: ${formatZodError(requestEnvelope.error)}`,
      ),
    };
  }

  const method = requestEnvelope.data.method;
  if (!isSessionProtocolMethod(method)) {
    return {
      ok: false,
      id: requestEnvelope.data.id,
      error: createSessionProtocolError(
        SESSION_PROTOCOL_ERROR_CODES.methodNotFound,
        `unsupported method: ${method}`,
      ),
    };
  }

  const request = createSessionProtocolRequest(
    requestEnvelope.data.id,
    method,
    requestEnvelope.data.params,
  );
  if (!request.ok) {
    return {
      ok: false,
      id: requestEnvelope.data.id,
      error: request.error,
    };
  }

  return {
    ok: true,
    request: request.value,
  };
}

export function createSessionProtocolRequest(
  id: SessionProtocolRequestId,
  method: SessionProtocolMethod,
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolRequestMessage> {
  const parsedId = sessionProtocolRequestIdSchema.safeParse(id);
  if (!parsedId.success) {
    return {
      ok: false,
      error: createSessionProtocolError(
        SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
        "request id must be a non-empty string",
      ),
    };
  }

  const parsed = validateSessionProtocolParams(method, params);
  if (!parsed.ok) {
    return parsed;
  }

  return {
    ok: true,
    value: {
      ...requestEnvelope(parsedId.data),
      method,
      params: parsed.value,
    } as SessionProtocolRequestMessage,
  };
}

function requestEnvelope(id: SessionProtocolRequestId): {
  version: typeof SESSION_PROTOCOL_VERSION;
  type: "request";
  id: SessionProtocolRequestId;
} {
  return {
    version: SESSION_PROTOCOL_VERSION,
    type: "request",
    id,
  };
}

function isBlankProtocolLine(line: string): boolean {
  for (let index = 0; index < line.length; index++) {
    const code = line.charCodeAt(index);
    if (code !== 9 && code !== 10 && code !== 13 && code !== 32) {
      return false;
    }
  }
  return true;
}

export function parseSessionProtocolOutgoingLine(line: string): SessionProtocolOutgoingParseResult {
  if (isBlankProtocolLine(line)) {
    return outgoingParseFailure(
      null,
      null,
      SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
      "session protocol line cannot be empty",
      undefined,
      "empty_line",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return outgoingParseFailure(
      null,
      null,
      SESSION_PROTOCOL_ERROR_CODES.parseError,
      "failed to parse JSON session protocol line",
      {
        cause: error instanceof Error ? error.message : String(error),
      },
      "parse_error",
    );
  }

  const routing = sessionProtocolOutgoingRoutingSchema.safeParse(parsed);
  if (!routing.success) {
    if (hasIssue(routing.error, [], "invalid_type")) {
      return outgoingParseFailure(
        null,
        null,
        SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
        "session protocol payload must be a JSON object",
      );
    }

    if (hasIssue(routing.error, ["version"])) {
      const parsedVersionField = sessionProtocolVersionFieldSchema.safeParse(parsed);
      const version = parsedVersionField.success ? parsedVersionField.data.version : undefined;
      return outgoingParseFailure(
        null,
        null,
        SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
        `unsupported session protocol version: ${String(version)}`,
        undefined,
        "unsupported_version",
      );
    }

    const parsedTypeField = sessionProtocolTypeFieldSchema.safeParse(parsed);
    const messageType = parsedTypeField.success ? parsedTypeField.data.type : undefined;
    return outgoingParseFailure(
      null,
      null,
      SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
      `unsupported session protocol message type: ${String(messageType)}`,
      undefined,
      "unsupported_message_type",
    );
  }

  if (routing.data.type === "ready") {
    return parseSessionProtocolReadyMessage(parsed);
  }

  if (routing.data.type === "session.delta") {
    return parseSessionProtocolDeltaMessage(parsed);
  }

  if (routing.data.type === "session.ephemeral") {
    return parseSessionProtocolEphemeralMessage(parsed);
  }

  if (routing.data.type === "session.pendingUserMessages") {
    return parseSessionProtocolPendingUserMessagesMessage(parsed);
  }

  if (
    routing.data.type === "session.clientTool.call" ||
    routing.data.type === "session.clientTool.cancel"
  ) {
    return parseSessionProtocolClientToolMessage(parsed);
  }

  return parseSessionProtocolResponseMessage(parsed);
}

export function validateSessionProtocolParams(
  method: "initialize",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolInitializeParams>;
export function validateSessionProtocolParams(
  method: "session.create",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolCreateParams>;
export function validateSessionProtocolParams(
  method: "session.list",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolListParams>;
export function validateSessionProtocolParams(
  method: "session.observe",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolSessionIdParams>;
export function validateSessionProtocolParams(
  method: "session.unobserve",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolUnobserveParams>;
export function validateSessionProtocolParams(
  method: "session.record",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolRecordParams>;
export function validateSessionProtocolParams(
  method: "session.submit",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolSubmitParams>;
export function validateSessionProtocolParams(
  method: "session.queue",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolQueueParams>;
export function validateSessionProtocolParams(
  method: "session.steer",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolSteerParams>;
export function validateSessionProtocolParams(
  method: "session.cancelPendingMessages",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolCancelPendingMessagesParams>;
export function validateSessionProtocolParams(
  method: "session.retry",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolRetryParams>;
export function validateSessionProtocolParams(
  method: "session.exec",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolExecParams>;
export function validateSessionProtocolParams(
  method: "session.execProcess",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolExecProcessParams>;
export function validateSessionProtocolParams(
  method: "session.cancelExec",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolCancelExecParams>;
export function validateSessionProtocolParams(
  method: "session.readFile",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolReadFileParams>;
export function validateSessionProtocolParams(
  method: "session.writeFile",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolWriteFileParams>;
export function validateSessionProtocolParams(
  method: "session.sample",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolSampleParams>;
export function validateSessionProtocolParams(
  method: "session.interrupt",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolSessionIdParams>;
export function validateSessionProtocolParams(
  method: "session.snapshot",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolSessionIdParams>;
export function validateSessionProtocolParams(
  method: "session.reload",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolReloadParams>;
export function validateSessionProtocolParams(
  method: "session.setReasoning",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolSetReasoningParams>;
export function validateSessionProtocolParams(
  method: "session.setPersona",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolSetPersonaParams>;
export function validateSessionProtocolParams(
  method: "session.resolvePrompt",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolResolvePromptParams>;
export function validateSessionProtocolParams(
  method: "session.autocompletePaths",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolAutocompletePathsParams>;
export function validateSessionProtocolParams(
  method: "session.compact",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolCompactParams>;
export function validateSessionProtocolParams(
  method: "session.prune",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolPruneParams>;
export function validateSessionProtocolParams(
  method: "session.rewind",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolRewindParams>;
export function validateSessionProtocolParams(
  method: "session.terminateSubagent",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolTerminateSubagentParams>;
export function validateSessionProtocolParams(
  method: "session.ephemeral.create",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolEphemeralCreateParams>;
export function validateSessionProtocolParams(
  method: "session.ephemeral.submit",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolEphemeralSubmitParams>;
export function validateSessionProtocolParams(
  method: "session.ephemeral.close",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolEphemeralCloseParams>;
export function validateSessionProtocolParams(
  method: "session.clientTool.ack",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolClientToolAckParams>;
export function validateSessionProtocolParams(
  method: "session.clientTool.result",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolClientToolResultParams>;
export function validateSessionProtocolParams(
  method: SessionProtocolMethod,
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolParamsByMethod[SessionProtocolMethod]>;
export function validateSessionProtocolParams(
  method: SessionProtocolMethod,
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolParamsByMethod[SessionProtocolMethod]> {
  switch (method) {
    case "initialize":
      return validateInitializeParams(params);
    case "session.create":
      return validateCreateParams(params);
    case "session.observe":
      return validateSessionIdParams("session.observe", params);
    case "session.unobserve":
      return validateSessionIdParams("session.unobserve", params);
    case "session.record":
      return validateRecordParams(params);
    case "session.submit":
    case "session.queue":
    case "session.steer":
      return validateUserMessageParams(method, params);
    case "session.exec":
      return validateExecParams(params);
    case "session.execProcess":
      return validateExecProcessParams(params);
    case "session.cancelExec":
      return validateCancelExecParams(params);
    case "session.readFile":
      return validateReadFileParams(params);
    case "session.writeFile":
      return validateWriteFileParams(params);
    case "session.sample":
      return validateSampleParams(params);
    case "session.list":
      return validateNoParams(method, params);
    case "session.cancelPendingMessages":
    case "session.retry":
    case "session.interrupt":
    case "session.snapshot":
    case "session.reload":
      return validateSessionIdParams(method, params);
    case "session.setReasoning":
      return validateSetReasoningParams(params);
    case "session.setPersona":
      return validateSetPersonaParams(params);
    case "session.resolvePrompt":
      return validateResolvePromptParams(params);
    case "session.autocompletePaths":
      return validateAutocompletePathsParams(params);
    case "session.compact":
      return validateCompactParams(params);
    case "session.prune":
      return validatePruneParams(params);
    case "session.rewind":
      return validateRewindParams(params);
    case "session.terminateSubagent":
      return validateTerminateSubagentParams(params);
    case "session.ephemeral.create":
      return validateEphemeralCreateParams(params);
    case "session.ephemeral.submit":
      return validateEphemeralSubmitParams(params);
    case "session.ephemeral.close":
      return validateEphemeralCloseParams(params);
    case "session.clientTool.ack":
      return validateClientToolAckParams(params);
    case "session.clientTool.result":
      return validateClientToolResultParams(params);
  }
}

export function validateSessionProtocolResult<M extends SessionProtocolMethod>(
  method: M,
  result: unknown,
): SessionProtocolResultValidationResult<SessionProtocolResultByMethod[M]>;
export function validateSessionProtocolResult(
  method: SessionProtocolMethod,
  result: unknown,
): SessionProtocolResultValidationResult<SessionProtocolResultByMethod[SessionProtocolMethod]> {
  switch (method) {
    case "initialize":
      return validateResult(method, result, sessionProtocolInitializeResultSchema);
    case "session.create":
      return validateResult(method, result, sessionProtocolCreateResultSchema);
    case "session.observe":
      return validateResult(method, result, sessionProtocolObserveResultSchema);
    case "session.snapshot":
    case "session.setPersona":
      return validateResult(method, result, sessionProtocolSnapshotSchema);
    case "session.setReasoning":
      return validateResult(method, result, sessionProtocolSettingsUpdateResultSchema);
    case "session.resolvePrompt":
      return validateResult(method, result, sessionProtocolResolvePromptResultSchema);
    case "session.autocompletePaths":
      return validateResult(method, result, sessionProtocolAutocompletePathsResultSchema);
    case "session.unobserve":
      return validateResult(method, result, sessionProtocolUnobserveResultSchema);
    case "session.reload":
      return validateResult(method, result, sessionProtocolReloadResultSchema);
    case "session.compact":
      return validateResult(method, result, sessionProtocolCompactResultSchema);
    case "session.prune":
      return validateResult(method, result, sessionProtocolPruneResultSchema);
    case "session.rewind":
      return validateResult(method, result, sessionProtocolRewindResultSchema);
    case "session.terminateSubagent":
      return validateResult(method, result, sessionProtocolTerminateSubagentResultSchema);
    case "session.ephemeral.create":
      return validateResult(method, result, sessionProtocolEphemeralCreateResultSchema);
    case "session.ephemeral.submit":
      return validateResult(method, result, sessionProtocolEphemeralSubmitResultSchema);
    case "session.ephemeral.close":
      return validateResult(method, result, sessionProtocolEphemeralCloseResultSchema);
    case "session.clientTool.ack":
      return validateResult(method, result, sessionProtocolClientToolAckResultSchema);
    case "session.clientTool.result":
      return validateResult(method, result, sessionProtocolClientToolResultResultSchema);
    case "session.list":
      return validateResult(method, result, sessionProtocolListResultSchema);
    case "session.submit":
    case "session.queue":
    case "session.steer":
      return validateResult(method, result, sessionProtocolSubmitWithUserResultSchema);
    case "session.cancelPendingMessages":
      return validateResult(method, result, sessionProtocolCancelPendingMessagesResultSchema);
    case "session.record":
      return validateResult(method, result, sessionProtocolRecordResultSchema);
    case "session.retry":
      return validateResult(method, result, sessionProtocolRetryResultSchema);
    case "session.exec":
    case "session.execProcess":
      return validateResult(method, result, sessionProtocolExecResultSchema);
    case "session.cancelExec":
      return validateResult(method, result, sessionProtocolCancelExecResultSchema);
    case "session.readFile":
      return validateResult(method, result, sessionProtocolReadFileResultSchema);
    case "session.writeFile":
      return validateResult(method, result, sessionProtocolWriteFileResultSchema);
    case "session.sample":
      return validateResult(method, result, sessionProtocolSampleResultSchema);
    case "session.interrupt":
      return validateResult(method, result, sessionProtocolInterruptResultSchema);
  }
}

function validateSessionIdParams<
  T extends
    | "session.observe"
    | "session.unobserve"
    | "session.cancelPendingMessages"
    | "session.retry"
    | "session.interrupt"
    | "session.snapshot"
    | "session.reload",
>(
  method: T,
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolSessionIdParams> {
  const parsed = sessionProtocolSessionIdParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? `${method} params must be an object`
      : hasIssue(parsed.error, ["sessionId"])
        ? `${method} params.sessionId must be a non-empty string`
        : `${method} params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return {
    ok: true,
    value: {
      sessionId: parsed.data.sessionId,
    },
  };
}

function validateInitializeParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolInitializeParams> {
  const parsed = sessionProtocolInitializeParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "initialize params must be an object with client metadata"
      : hasIssue(parsed.error, ["client"])
        ? "initialize.client must be an object with name/version strings and optional tools"
        : hasIssue(parsed.error, ["client", "name"])
          ? "initialize.client.name must be a non-empty string"
          : hasIssue(parsed.error, ["client", "version"])
            ? "initialize.client.version must be a non-empty string"
            : `initialize params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return {
    ok: true,
    value: {
      client: {
        name: parsed.data.client.name,
        version: parsed.data.client.version,
        ...(parsed.data.client.tools !== undefined ? { tools: parsed.data.client.tools } : {}),
      },
    },
  };
}

function validateUserMessageParams(
  method: "session.submit" | "session.queue" | "session.steer",
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolUserMessageParams> {
  const parsed = sessionProtocolUserMessageParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? `${method} params must be an object`
      : hasIssue(parsed.error, ["sessionId"])
        ? `${method} params.sessionId must be a non-empty string`
        : hasIssue(parsed.error, ["text"])
          ? `${method} params.text must be a string`
          : hasIssue(parsed.error, ["historyEntryId"])
            ? `${method} params.historyEntryId must be a non-empty string when provided`
            : `${method} params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return {
    ok: true,
    value: {
      sessionId: parsed.data.sessionId,
      text: parsed.data.text,
      ...(parsed.data.historyEntryId !== undefined
        ? { historyEntryId: parsed.data.historyEntryId }
        : {}),
    },
  };
}

function validateRecordParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolRecordParams> {
  const parsed = sessionProtocolRecordParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.record params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.record params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["text"])
          ? "session.record params.text must be a string"
          : hasIssue(parsed.error, ["historyEntryId"])
            ? "session.record params.historyEntryId must be a non-empty string when provided"
            : `session.record params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return {
    ok: true,
    value: {
      sessionId: parsed.data.sessionId,
      text: parsed.data.text,
      ...(parsed.data.historyEntryId !== undefined
        ? { historyEntryId: parsed.data.historyEntryId }
        : {}),
    },
  };
}

function validateExecParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolExecParams> {
  const parsed = sessionProtocolExecParamsSchema.safeParse(params);
  if (!parsed.success) {
    return invalidExecParams("session.exec", parsed.error);
  }

  return {
    ok: true,
    value: {
      sessionId: parsed.data.sessionId,
      execId: parsed.data.execId,
      command: parsed.data.command,
      ...(parsed.data.cwd !== undefined ? { cwd: parsed.data.cwd } : {}),
      ...(parsed.data.timeoutMs !== undefined ? { timeoutMs: parsed.data.timeoutMs } : {}),
      ...(parsed.data.maxCaptureBytes !== undefined
        ? { maxCaptureBytes: parsed.data.maxCaptureBytes }
        : {}),
    },
  };
}

function validateExecProcessParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolExecProcessParams> {
  const parsed = sessionProtocolExecProcessParamsSchema.safeParse(params);
  if (!parsed.success) {
    if (hasIssue(parsed.error, ["argv"])) {
      return invalidParams(
        "session.execProcess params.argv must be a non-empty array of non-empty strings",
      );
    }
    if (hasIssue(parsed.error, ["env"])) {
      return invalidParams(
        "session.execProcess params.env must use valid environment variable names and string values without null bytes",
      );
    }
    return invalidExecParams("session.execProcess", parsed.error);
  }

  return {
    ok: true,
    value: {
      sessionId: parsed.data.sessionId,
      execId: parsed.data.execId,
      argv: parsed.data.argv as [string, ...string[]],
      ...(parsed.data.env !== undefined ? { env: parsed.data.env } : {}),
      ...(parsed.data.cwd !== undefined ? { cwd: parsed.data.cwd } : {}),
      ...(parsed.data.timeoutMs !== undefined ? { timeoutMs: parsed.data.timeoutMs } : {}),
      ...(parsed.data.maxCaptureBytes !== undefined
        ? { maxCaptureBytes: parsed.data.maxCaptureBytes }
        : {}),
    },
  };
}

function validateCancelExecParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolCancelExecParams> {
  const parsed = sessionProtocolCancelExecParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.cancelExec params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.cancelExec params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["execId"])
          ? "session.cancelExec params.execId must be a non-empty string"
          : `session.cancelExec params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }
  return { ok: true, value: parsed.data };
}

function validateReadFileParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolReadFileParams> {
  const parsed = sessionProtocolReadFileParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.readFile params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.readFile params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["path"])
          ? "session.readFile params.path must be a non-empty string"
          : hasIssue(parsed.error, ["maxBytes"])
            ? `session.readFile params.maxBytes must be a positive integer no greater than ${SESSION_PROTOCOL_MAX_FILE_BYTES}`
            : `session.readFile params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }
  return { ok: true, value: parsed.data };
}

function validateWriteFileParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolWriteFileParams> {
  const parsed = sessionProtocolWriteFileParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.writeFile params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.writeFile params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["path"])
          ? "session.writeFile params.path must be a non-empty string"
          : hasIssue(parsed.error, ["contentBase64"])
            ? `session.writeFile params.contentBase64 must be valid base64 encoding at most ${SESSION_PROTOCOL_MAX_FILE_BYTES} bytes`
            : `session.writeFile params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }
  return { ok: true, value: parsed.data };
}

function invalidExecParams(
  method: "session.exec" | "session.execProcess",
  error: ZodError,
): SessionProtocolParamsValidationResult<never> {
  const message = hasIssue(error, [], "invalid_type")
    ? `${method} params must be an object`
    : hasIssue(error, ["sessionId"])
      ? `${method} params.sessionId must be a non-empty string`
      : hasIssue(error, ["execId"])
        ? `${method} params.execId must be a non-empty string`
        : hasIssue(error, ["command"])
          ? `${method} params.command must be a non-empty string`
          : hasIssue(error, ["cwd"])
            ? `${method} params.cwd must be a non-empty string when provided`
            : hasIssue(error, ["timeoutMs"])
              ? `${method} params.timeoutMs must be a positive integer when provided`
              : hasIssue(error, ["maxCaptureBytes"])
                ? `${method} params.maxCaptureBytes must be a positive integer no greater than ${SESSION_PROTOCOL_MAX_EXEC_CAPTURE_BYTES} when provided`
                : `${method} params are invalid: ${formatZodError(error)}`;
  return invalidParams(message);
}

function validateSampleParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolSampleParams> {
  const parsed = sessionProtocolSampleParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.sample params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.sample params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["context"])
          ? "session.sample params.context must include a system prompt and messages"
          : hasIssue(parsed.error, ["options"])
            ? "session.sample params.options must be an object"
            : `session.sample params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return { ok: true, value: parsed.data };
}

function validateSetReasoningParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolSetReasoningParams> {
  const parsed = sessionProtocolSetReasoningParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.setReasoning params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.setReasoning params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["reasoning"])
          ? "session.setReasoning params.reasoning must be one of none, minimal, low, medium, high, xhigh, or max"
          : `session.setReasoning params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return {
    ok: true,
    value: {
      sessionId: parsed.data.sessionId,
      reasoning: parsed.data.reasoning,
    },
  };
}

function validateSetPersonaParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolSetPersonaParams> {
  const parsed = sessionProtocolSetPersonaParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.setPersona params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.setPersona params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["personaId"])
          ? "session.setPersona params.personaId must be a non-empty string"
          : `session.setPersona params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return {
    ok: true,
    value: {
      sessionId: parsed.data.sessionId,
      personaId: parsed.data.personaId,
    },
  };
}

function validateResolvePromptParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolResolvePromptParams> {
  const parsed = sessionProtocolResolvePromptParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.resolvePrompt params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.resolvePrompt params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["promptId"])
          ? "session.resolvePrompt params.promptId must be a non-empty string"
          : `session.resolvePrompt params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return {
    ok: true,
    value: {
      sessionId: parsed.data.sessionId,
      promptId: parsed.data.promptId,
    },
  };
}

function validateAutocompletePathsParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolAutocompletePathsParams> {
  const parsed = sessionProtocolAutocompletePathsParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.autocompletePaths params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.autocompletePaths params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["query"])
          ? "session.autocompletePaths params.query must be a string"
          : hasIssue(parsed.error, ["limit"])
            ? "session.autocompletePaths params.limit must be a positive integer up to 100"
            : `session.autocompletePaths params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return {
    ok: true,
    value: {
      sessionId: parsed.data.sessionId,
      query: parsed.data.query,
      limit: parsed.data.limit,
    },
  };
}

function validateCompactParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolCompactParams> {
  const parsed = sessionProtocolCompactParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.compact params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.compact params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["mode"])
          ? "session.compact params.mode must be 'summary-only' or 'summary-and-last'"
          : hasIssue(parsed.error, ["guidance"])
            ? "session.compact params.guidance must be a string when provided"
            : `session.compact params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return {
    ok: true,
    value: {
      sessionId: parsed.data.sessionId,
      mode: parsed.data.mode,
      ...(parsed.data.guidance !== undefined ? { guidance: parsed.data.guidance } : {}),
    },
  };
}

function validatePruneParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolPruneParams> {
  const parsed = sessionProtocolPruneParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.prune params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.prune params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["strategy"])
          ? "session.prune params.strategy must be 'earliest', 'largest', or 'smart'"
          : hasIssue(parsed.error, ["fraction"])
            ? "session.prune params.fraction must be a number between 0 and 1"
            : hasIssue(parsed.error, ["guidance"])
              ? "session.prune params.guidance must be a string when provided"
              : `session.prune params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return {
    ok: true,
    value: {
      sessionId: parsed.data.sessionId,
      strategy: parsed.data.strategy,
      fraction: parsed.data.fraction,
      ...(parsed.data.guidance !== undefined ? { guidance: parsed.data.guidance } : {}),
    },
  };
}

function validateRewindParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolRewindParams> {
  const parsed = sessionProtocolRewindParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.rewind params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.rewind params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["historyEntryId"])
          ? "session.rewind params.historyEntryId must be a non-empty string"
          : `session.rewind params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return {
    ok: true,
    value: {
      sessionId: parsed.data.sessionId,
      historyEntryId: parsed.data.historyEntryId,
    },
  };
}

function validateTerminateSubagentParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolTerminateSubagentParams> {
  const parsed = sessionProtocolTerminateSubagentParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.terminateSubagent params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.terminateSubagent params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["subagentId"])
          ? "session.terminateSubagent params.subagentId must be a non-empty string"
          : `session.terminateSubagent params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return {
    ok: true,
    value: {
      sessionId: parsed.data.sessionId,
      subagentId: parsed.data.subagentId,
    },
  };
}

function validateEphemeralCreateParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolEphemeralCreateParams> {
  const parsed = sessionProtocolEphemeralCreateParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.ephemeral.create params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.ephemeral.create params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["instructions"])
          ? "session.ephemeral.create params.instructions must be a non-empty string"
          : hasIssue(parsed.error, ["tools"])
            ? "session.ephemeral.create params.tools are invalid"
            : `session.ephemeral.create params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return { ok: true, value: parsed.data };
}

function validateEphemeralSubmitParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolEphemeralSubmitParams> {
  const parsed = sessionProtocolEphemeralSubmitParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.ephemeral.submit params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.ephemeral.submit params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["contextId"])
          ? "session.ephemeral.submit params.contextId must be a non-empty string"
          : hasIssue(parsed.error, ["threadId"])
            ? "session.ephemeral.submit params.threadId must be a non-empty string"
            : hasIssue(parsed.error, ["forkFromThreadId"])
              ? "session.ephemeral.submit params.forkFromThreadId must be a non-empty string when provided"
              : hasIssue(parsed.error, ["message"])
                ? "session.ephemeral.submit params.message must be a non-empty string"
                : `session.ephemeral.submit params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return {
    ok: true,
    value: {
      sessionId: parsed.data.sessionId,
      contextId: parsed.data.contextId,
      threadId: parsed.data.threadId,
      ...(parsed.data.forkFromThreadId !== undefined
        ? { forkFromThreadId: parsed.data.forkFromThreadId }
        : {}),
      message: parsed.data.message,
    },
  };
}

function validateEphemeralCloseParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolEphemeralCloseParams> {
  const parsed = sessionProtocolEphemeralCloseParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.ephemeral.close params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.ephemeral.close params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["contextId"])
          ? "session.ephemeral.close params.contextId must be a non-empty string"
          : `session.ephemeral.close params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return { ok: true, value: parsed.data };
}

function validateClientToolAckParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolClientToolAckParams> {
  const parsed = sessionProtocolClientToolAckParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.clientTool.ack params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.clientTool.ack params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["callId"])
          ? "session.clientTool.ack params.callId must be a non-empty string"
          : `session.clientTool.ack params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return { ok: true, value: parsed.data };
}

function validateClientToolResultParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolClientToolResultParams> {
  const parsed = sessionProtocolClientToolResultParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.clientTool.result params must be an object"
      : hasIssue(parsed.error, ["sessionId"])
        ? "session.clientTool.result params.sessionId must be a non-empty string"
        : hasIssue(parsed.error, ["callId"])
          ? "session.clientTool.result params.callId must be a non-empty string"
          : `session.clientTool.result params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return { ok: true, value: parsed.data };
}

function validateCreateParams(
  params: unknown,
): SessionProtocolParamsValidationResult<SessionProtocolCreateParams> {
  const parsed = sessionProtocolCreateParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.create params must be an object"
      : hasIssue(parsed.error, ["executionEnvironment"])
        ? "session.create params.executionEnvironment must be an object"
        : hasIssue(parsed.error, ["executionEnvironment", "kind"])
          ? "session.create params.executionEnvironment.kind must be 'local', 'cloudflare-sandbox', or 'fly-sprite'"
          : hasIssue(parsed.error, ["executionEnvironment", "cwd"])
            ? "session.create params.executionEnvironment.cwd must be an absolute path"
            : hasIssue(parsed.error, ["personaId"])
              ? "session.create params.personaId must be a non-empty string"
              : hasIssue(parsed.error, ["reasoning"])
                ? "session.create params.reasoning must be one of none, minimal, low, medium, high, xhigh, or max"
                : `session.create params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return {
    ok: true,
    value: parsed.data,
  };
}

function validateNoParams(
  method: "session.list",
  params: unknown,
): SessionProtocolParamsValidationResult<Record<string, never>> {
  const parsed = sessionProtocolEmptyParamsSchema.safeParse(params);
  if (!parsed.success) {
    return invalidParams(`${method} params must be an empty object`);
  }

  return { ok: true, value: {} };
}

function validateResult<T extends SessionProtocolResultByMethod[SessionProtocolMethod]>(
  method: SessionProtocolMethod,
  result: unknown,
  schema: z.ZodType<T>,
): SessionProtocolResultValidationResult<T> {
  const parsed = schema.safeParse(result);
  if (!parsed.success) {
    return {
      ok: false,
      error: createSessionProtocolError(
        SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
        `${method} result is invalid: ${formatZodError(parsed.error)}`,
      ),
    };
  }

  return {
    ok: true,
    value: parsed.data,
  };
}

function parseSessionProtocolReadyMessage(payload: unknown): SessionProtocolOutgoingParseResult {
  const ready = sessionProtocolReadyMessageSchema.safeParse(payload);
  if (!ready.success) {
    return outgoingParseFailure(
      "ready",
      null,
      SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
      `invalid ready message: ${formatZodError(ready.error)}`,
    );
  }

  return {
    ok: true,
    message: {
      version: SESSION_PROTOCOL_VERSION,
      type: "ready",
      methods: [...ready.data.methods],
    },
  };
}

function parseSessionProtocolDeltaMessage(payload: unknown): SessionProtocolOutgoingParseResult {
  const fail = (message: string) =>
    outgoingParseFailure(
      "session.delta",
      null,
      SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
      message,
    );

  const deltaMessage = sessionProtocolDeltaMessageSchema.safeParse(payload);
  if (!deltaMessage.success) {
    if (hasIssue(deltaMessage.error, ["sessionId"])) {
      return fail("session.delta.sessionId must be a non-empty string");
    }

    if (hasIssue(deltaMessage.error, ["fromRevision"])) {
      return fail("session.delta.fromRevision must be a positive integer or null");
    }

    if (hasIssue(deltaMessage.error, ["toRevision"])) {
      return fail("session.delta.toRevision must be a positive integer");
    }

    if (hasIssue(deltaMessage.error, ["reason"])) {
      return fail("session.delta.reason is invalid");
    }

    if (hasIssue(deltaMessage.error, ["delta"])) {
      return fail("session.delta.delta is invalid");
    }

    return fail(`invalid session.delta message: ${formatZodError(deltaMessage.error)}`);
  }

  return {
    ok: true,
    message: {
      version: SESSION_PROTOCOL_VERSION,
      type: "session.delta",
      sessionId: deltaMessage.data.sessionId,
      fromRevision: deltaMessage.data.fromRevision,
      toRevision: deltaMessage.data.toRevision,
      reason: deltaMessage.data.reason,
      delta: deltaMessage.data.delta,
    },
  };
}

function parseSessionProtocolClientToolMessage(
  payload: unknown,
): SessionProtocolOutgoingParseResult {
  const parsedTypeField = sessionProtocolTypeFieldSchema.safeParse(payload);
  const messageType = parsedTypeField.success
    ? (parsedTypeField.data.type as SessionProtocolOutgoingMessage["type"])
    : null;
  const fail = (message: string) =>
    outgoingParseFailure(messageType, null, SESSION_PROTOCOL_ERROR_CODES.invalidRequest, message);

  const message = sessionProtocolClientToolMessageSchema.safeParse(payload);
  if (!message.success) {
    return fail(`invalid ${String(messageType)} message: ${formatZodError(message.error)}`);
  }

  return {
    ok: true,
    message: message.data as SessionProtocolClientToolMessage,
  };
}

function parseSessionProtocolEphemeralMessage(
  payload: unknown,
): SessionProtocolOutgoingParseResult {
  const fail = (message: string) =>
    outgoingParseFailure(
      "session.ephemeral",
      null,
      SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
      message,
    );

  const ephemeralMessage = sessionProtocolEphemeralMessageSchema.safeParse(payload);
  if (!ephemeralMessage.success) {
    if (hasIssue(ephemeralMessage.error, ["sessionId"])) {
      return fail("session.ephemeral.sessionId must be a non-empty string");
    }
    if (hasIssue(ephemeralMessage.error, ["event"])) {
      return fail("session.ephemeral.event is invalid");
    }
    return fail(`invalid session.ephemeral message: ${formatZodError(ephemeralMessage.error)}`);
  }

  return {
    ok: true,
    message: ephemeralMessage.data as SessionProtocolEphemeralMessage,
  };
}

function parseSessionProtocolPendingUserMessagesMessage(
  payload: unknown,
): SessionProtocolOutgoingParseResult {
  const fail = (message: string) =>
    outgoingParseFailure(
      "session.pendingUserMessages",
      null,
      SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
      message,
    );

  const message = sessionProtocolPendingUserMessagesMessageSchema.safeParse(payload);
  if (!message.success) {
    if (hasIssue(message.error, ["sessionId"])) {
      return fail("session.pendingUserMessages.sessionId must be a non-empty string");
    }
    if (hasIssue(message.error, ["state"])) {
      return fail("session.pendingUserMessages.state is invalid");
    }
    return fail(`invalid session.pendingUserMessages message: ${formatZodError(message.error)}`);
  }

  return {
    ok: true,
    message: message.data as SessionProtocolPendingUserMessagesMessage,
  };
}

function parseSessionProtocolResponseMessage(payload: unknown): SessionProtocolOutgoingParseResult {
  const parsedIdField = sessionProtocolIdFieldSchema.safeParse(payload);
  const responseId = parseNullableRequestId(
    parsedIdField.success ? parsedIdField.data.id : undefined,
  );
  const requestId = responseId.ok ? responseId.id : null;
  const fail = (
    message: string,
    reason: SessionProtocolOutgoingParseFailureReason = "invalid_payload",
    id: SessionProtocolRequestId | null = requestId,
  ) =>
    outgoingParseFailure(
      "response",
      id,
      SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
      message,
      undefined,
      reason,
    );

  if (!responseId.ok) {
    return fail("response.id must be a non-empty string or null", "response_invalid_id", null);
  }

  const parsedOkField = sessionProtocolOkFieldSchema.safeParse(payload);
  const ok = parsedOkField.success ? parsedOkField.data.ok : undefined;

  if (ok === true) {
    const successResponse = sessionProtocolResponseSuccessSchema.safeParse(payload);
    if (!successResponse.success) {
      if (hasIssue(successResponse.error, ["result"], "invalid_type")) {
        return fail("successful response must include result");
      }

      if (hasIssue(successResponse.error, ["id"])) {
        return fail("successful response.id must be a non-empty string", "response_invalid_id");
      }

      return fail(`invalid successful response: ${formatZodError(successResponse.error)}`);
    }

    return {
      ok: true,
      message: {
        version: SESSION_PROTOCOL_VERSION,
        type: "response",
        id: successResponse.data.id,
        ok: true,
        result: successResponse.data.result,
      },
    };
  }

  if (ok !== false) {
    return fail("response.ok must be true or false");
  }

  const errorResponse = sessionProtocolResponseErrorSchema.safeParse(payload);
  if (!errorResponse.success) {
    if (hasIssue(errorResponse.error, ["error"])) {
      return fail("error response.error must be an object");
    }

    if (
      hasIssue(errorResponse.error, ["error", "code"]) ||
      hasIssue(errorResponse.error, ["error", "message"])
    ) {
      return fail("error response.error must include a valid code and string message");
    }

    return fail(`invalid error response: ${formatZodError(errorResponse.error)}`);
  }

  return {
    ok: true,
    message: {
      version: SESSION_PROTOCOL_VERSION,
      type: "response",
      id: errorResponse.data.id,
      ok: false,
      error: errorResponse.data.error,
    },
  };
}

function parseNullableRequestId(
  value: unknown,
): { ok: true; id: SessionProtocolRequestId | null } | { ok: false } {
  if (value === null) {
    return { ok: true, id: null };
  }

  const parsed = sessionProtocolRequestIdSchema.safeParse(value);
  return parsed.success ? { ok: true, id: parsed.data } : { ok: false };
}

function outgoingParseFailure(
  messageType: SessionProtocolOutgoingMessage["type"] | null,
  id: SessionProtocolRequestId | null,
  code: SessionProtocolErrorCode,
  message: string,
  data?: unknown,
  reason: SessionProtocolOutgoingParseFailureReason = "invalid_payload",
): SessionProtocolOutgoingParseFailure {
  return {
    ok: false,
    reason,
    messageType,
    id,
    error: createSessionProtocolError(code, message, data),
  };
}

function hasIssue(
  error: z.ZodError,
  path: readonly string[] = [],
  code?: z.ZodIssue["code"],
): boolean {
  return error.issues.some(
    (issue) =>
      (code === undefined || issue.code === code) &&
      issue.path.length === path.length &&
      issue.path.every((segment, i) => segment === path[i]),
  );
}

function invalidParams(message: string): SessionProtocolParamsValidationResult<never> {
  return {
    ok: false,
    error: createSessionProtocolError(SESSION_PROTOCOL_ERROR_CODES.invalidParams, message),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
