import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { AssistantPartialSnapshot } from "../session/message_accumulator.js";
import type { SubagentUiEvent } from "../subagents/types.js";
import type { ToolUiEvent } from "../tools/registry.js";

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

export type CoreToolCallStreamingEvent = {
  type: "tool_call_streaming";
  historyEntryId: string;
  toolCallId: string;
  toolName: string;
  contentIndex: number;
  replacesToolCallId?: string;
};

export type CoreToolCallDiscardedEvent = {
  type: "tool_call_discarded";
  historyEntryId: string;
  toolCallId: string;
  contentIndex: number;
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
  historyEntryId: string;
  message: ToolResultMessage;
};

export type CoreToolRecoveryEvent = {
  type: "tool_recovery";
  historyEntryId: string;
  message: UserMessage;
  toolResults: ToolResultMessage[];
};

export type CoreCompactionStartEvent = {
  type: "compaction_start";
  reason: "threshold";
};

export type CoreCompactionResult = {
  summaryHistoryEntryId: string;
  continuationHistoryEntryId: string;
  compactionMessage: string;
  cutType: "turn-boundary" | "split-turn";
  retainedMessageCount: number;
};

export type CoreCompactionEndEvent =
  | {
      type: "compaction_end";
      reason: "threshold";
      outcome: "compacted";
      result: CoreCompactionResult;
    }
  | {
      type: "compaction_end";
      reason: "threshold";
      outcome: "skipped";
    }
  | {
      type: "compaction_end";
      reason: "threshold";
      outcome: "aborted";
    }
  | {
      type: "compaction_end";
      reason: "threshold";
      outcome: "failed";
      errorMessage: string;
    };

export type CoreEvent =
  | CoreAssistantStartEvent
  | CoreAssistantFinalEvent
  | CoreAssistantPartialEvent
  | CoreNoticeEvent
  | CoreToolCallStreamingEvent
  | CoreToolCallDiscardedEvent
  | CoreToolUiEvent
  | CoreSubagentUiEvent
  | CoreToolResultEvent
  | CoreToolRecoveryEvent
  | CoreCompactionStartEvent
  | CoreCompactionEndEvent;

export type RunnerAssistantPartialEvent = {
  type: "assistant_partial";
  snapshot: AssistantPartialSnapshot;
};

export type RunnerToolCallStreamingEvent = {
  type: "tool_call_streaming";
  toolCallId: string;
  toolName: string;
  contentIndex: number;
  replacesToolCallId?: string;
};

export type RunnerToolCallDiscardedEvent = {
  type: "tool_call_discarded";
  toolCallId: string;
  contentIndex: number;
};

export type RunnerToolResultEvent = {
  type: "tool_result";
  message: ToolResultMessage;
};
