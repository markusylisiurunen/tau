import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import type { AssistantPartialSnapshot } from "../session/message_accumulator.js";
import type { SubagentUiEvent } from "../subagents/types.js";
import type { ToolUiEvent } from "../tools/registry.js";
import {
  CORE_EVENT_VERSION,
  type CoreEvent,
  type CoreEventEnvelope,
  type CoreEventVersion,
} from "./types.js";

export type CoreEventParseFailure = { ok: false; message: string };
export type CoreEventParseSuccess<T> = { ok: true; value: T };
export type CoreEventParseResult<T> = CoreEventParseSuccess<T> | CoreEventParseFailure;

const stopReasons = ["stop", "length", "toolUse", "error", "aborted"];
const subagentStatuses = ["running", "success", "error", "aborted"];
const fail = (message: string): CoreEventParseFailure => ({ ok: false, message });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseCoreEvent(value: unknown): CoreEvent {
  const parsed = safeParseCoreEvent(value);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

export function safeParseCoreEvent(value: unknown): CoreEventParseResult<CoreEvent> {
  if (!isRecord(value)) return fail("core event payload must be an object");
  if (typeof value.type !== "string") return fail("core event payload.type must be a string");
  return isCoreEvent(value) ? { ok: true, value } : fail("invalid core event payload");
}

export function parseCoreEventEnvelope(value: unknown): CoreEventEnvelope {
  const parsed = safeParseCoreEventEnvelope(value);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

export function safeParseCoreEventEnvelope(
  value: unknown,
): CoreEventParseResult<CoreEventEnvelope> {
  if (!isRecord(value)) return fail("core event envelope must be an object");
  if (value.version !== CORE_EVENT_VERSION) {
    return fail(`unsupported core event version: ${String(value.version)}`);
  }
  const event = safeParseCoreEvent(value.event);
  return event.ok
    ? { ok: true, value: { version: CORE_EVENT_VERSION, event: event.value } }
    : fail(`invalid core event envelope: ${event.message}`);
}

export function isCoreEventVersion(value: unknown): value is CoreEventVersion {
  return value === CORE_EVENT_VERSION;
}

function isCoreEvent(value: Record<string, unknown>): value is CoreEvent {
  switch (value.type) {
    case "assistant_start":
      return typeof value.historyEntryId === "string";
    case "assistant_final":
      return typeof value.historyEntryId === "string" && isAssistantMessage(value.message);
    case "assistant_partial":
      return typeof value.historyEntryId === "string" && isAssistantPartialSnapshot(value.snapshot);
    case "notice":
      return (
        (value.severity === "info" || value.severity === "warn" || value.severity === "error") &&
        typeof value.text === "string"
      );
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

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    isRecord(value) &&
    value.role === "assistant" &&
    (value.stopReason === undefined ||
      (typeof value.stopReason === "string" && stopReasons.includes(value.stopReason)))
  );
}

function isToolResultMessage(value: unknown): value is ToolResultMessage {
  return (
    isRecord(value) &&
    value.role === "toolResult" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string"
  );
}

function isAssistantPartialSnapshot(value: unknown): value is AssistantPartialSnapshot {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    typeof value.thinking === "string" &&
    typeof value.hasTextStarted === "boolean" &&
    typeof value.hasAnyThinking === "boolean"
  );
}

function isToolUiEvent(value: unknown): value is ToolUiEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  return value.type === "tool_pruned"
    ? typeof value.toolCallId === "string" && typeof value.content === "string"
    : typeof value.headerTarget === "string";
}

function isSubagentUiEvent(value: unknown): value is SubagentUiEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "subagent_spawned":
    case "subagent_finished":
      return isSubagentState(value.state);
    case "subagent_progress":
      return (
        typeof value.id === "string" &&
        typeof value.text === "string" &&
        typeof value.costTotal === "number" &&
        typeof value.turns === "number" &&
        typeof value.toolCalls === "number"
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
    typeof value.status === "string" &&
    subagentStatuses.includes(value.status)
  );
}
