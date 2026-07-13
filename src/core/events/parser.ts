import type { AssistantPartialSnapshot } from "../session/message_accumulator.js";
import {
  CORE_EVENT_VERSION,
  type CoreEvent,
  type CoreEventEnvelope,
  type CoreEventVersion,
} from "./types.js";

export type CoreEventParseFailure = { ok: false; message: string };
export type CoreEventParseSuccess<T> = { ok: true; value: T };
export type CoreEventParseResult<T> = CoreEventParseSuccess<T> | CoreEventParseFailure;

type UnknownRecord = Record<string, unknown>;

const stopReasons = ["stop", "length", "toolUse", "error", "aborted"] as const;
const subagentStatuses = ["running", "success", "error", "aborted"] as const;
const noticeSeverities = ["info", "warn", "error"] as const;
const compactionReasons = ["threshold"] as const;
const compactionOutcomes = ["compacted", "skipped", "aborted", "failed"] as const;
const compactionCutTypes = ["turn-boundary", "split-turn"] as const;

const fail = (message: string): CoreEventParseFailure => ({ ok: false, message });

export function parseCoreEvent(value: unknown): CoreEvent {
  const parsed = safeParseCoreEvent(value);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

export function safeParseCoreEvent(value: unknown): CoreEventParseResult<CoreEvent> {
  if (!isRecord(value)) {
    return fail("core event payload must be an object");
  }

  if (typeof value.type !== "string") {
    return fail("core event payload.type must be a string");
  }

  if (!isValidCoreEvent(value, value.type)) {
    return fail("invalid core event payload");
  }

  return { ok: true, value: stripCoreEvent(value) };
}

export function parseCoreEventEnvelope(value: unknown): CoreEventEnvelope {
  const parsed = safeParseCoreEventEnvelope(value);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

export function safeParseCoreEventEnvelope(
  value: unknown,
): CoreEventParseResult<CoreEventEnvelope> {
  if (!isRecord(value)) {
    return fail("core event envelope must be an object");
  }

  if (!isCoreEventVersion(value.version)) {
    return fail(`unsupported core event version: ${String(value.version)}`);
  }

  const event = safeParseCoreEvent(value.event);
  if (!event.ok) {
    return fail(`invalid core event envelope: ${event.message}`);
  }

  return {
    ok: true,
    value: {
      version: CORE_EVENT_VERSION,
      event: event.value,
    },
  };
}

export function isCoreEventVersion(value: unknown): value is CoreEventVersion {
  return value === CORE_EVENT_VERSION;
}

function stripCoreEvent(value: UnknownRecord): CoreEvent {
  switch (value.type) {
    case "assistant_start":
      return { type: "assistant_start", historyEntryId: value.historyEntryId as string };
    case "assistant_final":
      return {
        type: "assistant_final",
        historyEntryId: value.historyEntryId as string,
        message: value.message as Extract<CoreEvent, { type: "assistant_final" }>["message"],
      };
    case "assistant_partial": {
      const snapshot = value.snapshot as UnknownRecord;
      return {
        type: "assistant_partial",
        historyEntryId: value.historyEntryId as string,
        snapshot: {
          text: snapshot.text as string,
          thinking: snapshot.thinking as string,
          toolCalls: snapshot.toolCalls as AssistantPartialSnapshot["toolCalls"],
          hasTextStarted: snapshot.hasTextStarted as boolean,
          hasAnyThinking: snapshot.hasAnyThinking as boolean,
        },
      };
    }
    case "notice":
      return {
        type: "notice",
        severity: value.severity as Extract<CoreEvent, { type: "notice" }>["severity"],
        text: value.text as string,
      };
    case "tool_ui":
      return {
        type: "tool_ui",
        uiEvent: value.uiEvent as Extract<CoreEvent, { type: "tool_ui" }>["uiEvent"],
      };
    case "subagent_ui":
      return {
        type: "subagent_ui",
        event: value.event as Extract<CoreEvent, { type: "subagent_ui" }>["event"],
      };
    case "tool_result":
      return {
        type: "tool_result",
        historyEntryId: value.historyEntryId as string,
        message: value.message as Extract<CoreEvent, { type: "tool_result" }>["message"],
      };
    case "tool_recovery":
      return {
        type: "tool_recovery",
        historyEntryId: value.historyEntryId as string,
        message: value.message as Extract<CoreEvent, { type: "tool_recovery" }>["message"],
        toolResults: value.toolResults as Extract<
          CoreEvent,
          { type: "tool_recovery" }
        >["toolResults"],
      };
    case "compaction_start":
      return { type: "compaction_start", reason: "threshold" };
    case "compaction_end":
      return stripCompactionEndEvent(value);
    default:
      throw new Error("invalid core event payload");
  }
}

function stripCompactionEndEvent(
  value: UnknownRecord,
): Extract<CoreEvent, { type: "compaction_end" }> {
  switch (value.outcome) {
    case "compacted": {
      const result = value.result as UnknownRecord;
      return {
        type: "compaction_end",
        reason: "threshold",
        outcome: "compacted",
        result: {
          summaryHistoryEntryId: result.summaryHistoryEntryId as string,
          continuationHistoryEntryId: result.continuationHistoryEntryId as string,
          compactionMessage: result.compactionMessage as string,
          cutType: result.cutType as "turn-boundary" | "split-turn",
          retainedMessageCount: result.retainedMessageCount as number,
        },
      };
    }
    case "failed":
      return {
        type: "compaction_end",
        reason: "threshold",
        outcome: "failed",
        errorMessage: value.errorMessage as string,
      };
    case "skipped":
      return { type: "compaction_end", reason: "threshold", outcome: "skipped" };
    case "aborted":
      return { type: "compaction_end", reason: "threshold", outcome: "aborted" };
    default:
      throw new Error("invalid core event payload");
  }
}

function isValidCoreEvent(value: UnknownRecord, eventType: string): boolean {
  switch (eventType) {
    case "assistant_start":
      return typeof value.historyEntryId === "string";
    case "assistant_final":
      return typeof value.historyEntryId === "string" && isAssistantMessage(value.message);
    case "assistant_partial":
      return typeof value.historyEntryId === "string" && isAssistantPartialSnapshot(value.snapshot);
    case "notice":
      return isOneOf(value.severity, noticeSeverities) && typeof value.text === "string";
    case "tool_ui":
      return isToolUiEvent(value.uiEvent);
    case "subagent_ui":
      return isSubagentUiEvent(value.event);
    case "tool_result":
      return typeof value.historyEntryId === "string" && isToolResultMessage(value.message);
    case "tool_recovery":
      return (
        typeof value.historyEntryId === "string" &&
        isUserMessage(value.message) &&
        Array.isArray(value.toolResults) &&
        value.toolResults.every(isToolResultMessage)
      );
    case "compaction_start":
      return isOneOf(value.reason, compactionReasons);
    case "compaction_end":
      return isCompactionEndEvent(value);
    default:
      return false;
  }
}

function isCompactionEndEvent(value: UnknownRecord): boolean {
  if (!isOneOf(value.reason, compactionReasons) || !isOneOf(value.outcome, compactionOutcomes)) {
    return false;
  }

  switch (value.outcome) {
    case "compacted":
      return value.errorMessage === undefined && isCompactionResult(value.result);
    case "failed":
      return value.result === undefined && typeof value.errorMessage === "string";
    case "skipped":
    case "aborted":
      return value.result === undefined && value.errorMessage === undefined;
  }
}

function isCompactionResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.summaryHistoryEntryId === "string" &&
    typeof value.continuationHistoryEntryId === "string" &&
    typeof value.compactionMessage === "string" &&
    isOneOf(value.cutType, compactionCutTypes) &&
    isPositiveInteger(value.retainedMessageCount)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isAssistantMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.role === "assistant" &&
    Array.isArray(value.content) &&
    value.content.every(isAssistantContent) &&
    typeof value.api === "string" &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    isRecord(value.usage) &&
    isOneOf(value.stopReason, stopReasons) &&
    isFiniteNumber(value.timestamp)
  );
}

function isAssistantContent(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "text") {
    return typeof value.text === "string";
  }
  if (value.type === "thinking") {
    return typeof value.thinking === "string";
  }
  return isToolCall(value);
}

function isToolResultMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.role === "toolResult" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    Array.isArray(value.content) &&
    value.content.every(isUserContent) &&
    typeof value.isError === "boolean" &&
    isFiniteNumber(value.timestamp)
  );
}

function isUserMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.role === "user" &&
    (typeof value.content === "string" ||
      (Array.isArray(value.content) && value.content.every(isUserContent))) &&
    isFiniteNumber(value.timestamp)
  );
}

function isUserContent(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "text") {
    return typeof value.text === "string";
  }
  return (
    value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string"
  );
}

function isToolCall(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "toolCall" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isRecord(value.arguments)
  );
}

function isAssistantPartialSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    typeof value.thinking === "string" &&
    Array.isArray(value.toolCalls) &&
    value.toolCalls.every(isToolCall) &&
    typeof value.hasTextStarted === "boolean" &&
    typeof value.hasAnyThinking === "boolean" &&
    (value.hasTextStarted || value.text.length === 0) &&
    (value.hasAnyThinking || value.thinking.length === 0)
  );
}

function isToolUiEvent(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "tool_pruned") {
    return typeof value.toolCallId === "string" && typeof value.content === "string";
  }

  if (value.type === "tool_call_queued") {
    return (
      typeof value.toolCallId === "string" &&
      typeof value.toolName === "string" &&
      typeof value.headerTarget === "string"
    );
  }

  return typeof value.headerTarget === "string";
}

function isSubagentUiEvent(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "subagent_spawned":
    case "subagent_finished":
      return isSubagentState(value.state);
    case "subagent_progress":
      return (
        typeof value.id === "string" &&
        typeof value.text === "string" &&
        isFiniteNumber(value.costTotal) &&
        isFiniteNumber(value.turns) &&
        isFiniteNumber(value.toolCalls) &&
        isSubagentUsageSnapshot(value.usage)
      );
    case "subagent_emit_output":
      return typeof value.id === "string" && typeof value.text === "string";
    case "subagent_abort_requested":
      return typeof value.id === "string";
    default:
      return false;
  }
}

function isSubagentState(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.title === "string" &&
    isOneOf(value.status, subagentStatuses) &&
    isSubagentUsageSnapshot(value.usage)
  );
}

function isSubagentUsageSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.input) &&
    isFiniteNumber(value.output) &&
    isFiniteNumber(value.cacheRead) &&
    isFiniteNumber(value.cacheWrite) &&
    isFiniteNumber(value.contextWindowUsageTokens) &&
    isFiniteNumber(value.contextWindow)
  );
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value);
}
