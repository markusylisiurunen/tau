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

  return { ok: true, value: value as CoreEvent };
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
      return typeof value.originHistoryEntryId === "string" && isSubagentUiEvent(value.event);
    case "tool_result":
      return typeof value.historyEntryId === "string" && isToolResultMessage(value.message);
    default:
      return false;
  }
}

function isAssistantMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.role === "assistant" &&
    (value.stopReason === undefined || isOneOf(value.stopReason, stopReasons))
  );
}

function isToolResultMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.role === "toolResult" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string"
  );
}

function isAssistantPartialSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    typeof value.thinking === "string" &&
    typeof value.hasTextStarted === "boolean" &&
    typeof value.hasAnyThinking === "boolean"
  );
}

function isToolUiEvent(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "tool_pruned") {
    return typeof value.toolCallId === "string" && typeof value.content === "string";
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
    isFiniteNumber(value.promptTokensSent) &&
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
