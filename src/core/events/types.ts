import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import type { AssistantPartialSnapshot } from "../session/message_accumulator.js";
import type { SubagentUiEvent } from "../subagents/types.js";
import type { ToolUiEvent } from "../tools/registry.js";

export type CoreEventVersion = 1;

export type CoreAssistantStartEvent = {
  type: "assistant_start";
  historyEntryId: string;
};

export type CoreAssistantFinalEvent = {
  type: "assistant_final";
  historyEntryId: string;
  message: AssistantMessage;
};

export type CoreAssistantPartialEvent = {
  type: "assistant_partial";
  historyEntryId: string;
  snapshot: AssistantPartialSnapshot;
};

export type CoreNoticeEvent = {
  type: "notice";
  severity: "info" | "warn" | "error";
  text: string;
};

export type CoreToolUiEvent = {
  type: "tool_ui";
  uiEvent: ToolUiEvent;
};

export type CoreSubagentUiEvent = {
  type: "subagent_ui";
  event: SubagentUiEvent;
  originHistoryEntryId: string;
};

export type CoreToolResultEvent = {
  type: "tool_result";
  historyEntryId: string;
  message: ToolResultMessage;
};

export type CoreEvent =
  | CoreAssistantStartEvent
  | CoreAssistantFinalEvent
  | CoreAssistantPartialEvent
  | CoreNoticeEvent
  | CoreToolUiEvent
  | CoreSubagentUiEvent
  | CoreToolResultEvent;

export type RunnerAssistantPartialEvent = {
  type: "assistant_partial";
  snapshot: AssistantPartialSnapshot;
};

export type RunnerToolResultEvent = {
  type: "tool_result";
  message: ToolResultMessage;
};

export type RunnerEvent =
  | CoreNoticeEvent
  | RunnerAssistantPartialEvent
  | CoreToolUiEvent
  | RunnerToolResultEvent;

export type CoreEventEnvelope = {
  version: CoreEventVersion;
  event: CoreEvent;
};

export const CORE_EVENT_VERSION: CoreEventVersion = 1;

export function wrapCoreEvent(event: CoreEvent): CoreEventEnvelope {
  return { version: CORE_EVENT_VERSION, event };
}

export function serializeCoreEvent(event: CoreEvent): string {
  return JSON.stringify(wrapCoreEvent(event));
}
