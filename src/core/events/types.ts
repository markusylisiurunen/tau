import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import type { SubagentUiEvent } from "../subagents/types.js";
import type { AssistantPartialSnapshot } from "../session/message_accumulator.js";
import type { ToolUiEvent } from "../tools/registry.js";

export type CoreEventVersion = 1;

export type CoreAssistantStartEvent = {
  type: "assistant_start";
};

export type CoreAssistantFinalEvent = {
  type: "assistant_final";
  message: AssistantMessage;
};

export type CoreAssistantPartialEvent = {
  type: "assistant_partial";
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
};

export type CoreToolResultEvent = {
  type: "tool_result";
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

export type RunnerEvent =
  | CoreNoticeEvent
  | CoreAssistantPartialEvent
  | CoreToolUiEvent
  | CoreToolResultEvent;

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
