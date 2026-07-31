import type {
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { AssistantPartialSnapshot } from "../session/message_accumulator.js";
import type { ReasoningEffort } from "../types.js";

export type AgentTurnOutcome = "completed" | "stopped" | "interrupted" | "blocked";

export type AgentCompactionResult = {
  summaryHistoryEntryId: string;
  continuationHistoryEntryId: string;
  compactionMessage: string;
  cutType: "turn-boundary" | "split-turn";
  retainedMessageCount: number;
};

export type AgentEvent =
  | { type: "turn_started"; turnId: string; historyEntryId: string }
  | {
      type: "turn_finished";
      turnId: string;
      historyEntryId: string;
      outcome: AgentTurnOutcome;
    }
  | { type: "user_message"; historyEntryId: string; message: UserMessage; revision: number }
  | {
      type: "history_rewound";
      historyEntryId: string;
      text: string;
      removedEntryIds: string[];
      revision: number;
    }
  | { type: "assistant_start"; historyEntryId: string }
  | {
      type: "assistant_partial";
      historyEntryId: string;
      snapshot: AssistantPartialSnapshot;
    }
  | {
      type: "tool_call_streaming";
      historyEntryId: string;
      toolCallId: string;
      toolName: string;
      contentIndex: number;
      replacesToolCallId?: string;
    }
  | {
      type: "tool_call_discarded";
      historyEntryId: string;
      toolCallId: string;
      contentIndex: number;
    }
  | {
      type: "tool_call_admitted";
      historyEntryId: string;
      toolCall: ToolCall;
    }
  | { type: "tool_activity"; activity: unknown }
  | {
      type: "tool_run_queued";
      toolCallId: string;
      toolName: string;
      timestamp: number;
    }
  | {
      type: "tool_run_blocked";
      toolCallId: string;
      toolName: string;
      reason: string;
      timestamp: number;
    }
  | {
      type: "tool_run_started";
      toolCallId: string;
      toolName: string;
      timestamp: number;
    }
  | {
      type: "tool_run_finished";
      toolCallId: string;
      toolName: string;
      outcome: "succeeded" | "failed" | "blocked" | "cancelled";
      timestamp: number;
    }
  | {
      type: "assistant_final";
      historyEntryId: string;
      message: AssistantMessage;
      personaId: string;
      reasoningEffort: ReasoningEffort | "none";
      revision: number;
    }
  | {
      type: "tool_result";
      historyEntryId: string;
      message: ToolResultMessage;
      revision: number;
    }
  | {
      type: "tool_recovery";
      historyEntryId: string;
      message: UserMessage;
      toolResults: ToolResultMessage[];
      revision: number;
    }
  | { type: "model_retry_scheduled"; attempt: number; delayMs: number }
  | { type: "model_retry_started"; attempt: number }
  | { type: "compaction_start"; reason: "threshold" | "manual" }
  | {
      type: "compaction_end";
      reason: "threshold" | "manual";
      outcome: "compacted";
      result: AgentCompactionResult;
      revision: number;
    }
  | {
      type: "compaction_end";
      reason: "threshold" | "manual";
      outcome: "skipped" | "aborted";
    }
  | {
      type: "compaction_end";
      reason: "threshold" | "manual";
      outcome: "failed";
      errorMessage: string;
    }
  | {
      type: "usage_checkpoint";
      historyEntryId: string;
      contextEpoch: string;
      tokens: number;
      revision: number;
    }
  | { type: "notice"; severity: "info" | "warn" | "error"; text: string };

export type AgentEventSink = (event: AgentEvent) => Promise<void>;

export type RunnerAssistantPartialEvent = {
  type: "assistant_partial";
  snapshot: AssistantPartialSnapshot;
};

export type RunnerToolCallStreamingEvent = {
  type: "tool_call_streaming";
  toolCallId: string;
  toolName: string;
  contentIndex: number;
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
