import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentEventSink } from "../agent/events.js";
import type { HistorySessionWriter } from "./history_manager.js";
import {
  assistantHistoryEntries,
  systemHistoryEntry,
  toolHistoryEntry,
  userHistoryEntry,
} from "./transcript.js";
import type { HistoryToolEntry } from "./types.js";

export type OpenSubagentHistory = (session: {
  sessionId: string;
  workingDirectory: string;
  createdAt: number;
}) => AgentEventSink;

export class AgentHistoryRecorder {
  private readonly calls = new Map<string, { historyEntryId: string; call: ToolCall }>();
  private readonly outcomes = new Map<string, HistoryToolEntry["outcome"]>();
  constructor(private readonly writer: HistorySessionWriter) {}

  recordTool(options: Parameters<typeof toolHistoryEntry>[0]): string | undefined {
    return this.writer.append([toolHistoryEntry(options)]);
  }

  record(event: AgentEvent): string | undefined {
    switch (event.type) {
      case "user_message":
        return this.writer.append([userHistoryEntry(event.historyEntryId, event.message)]);
      case "system_message":
        return this.writer.append([systemHistoryEntry(event.historyEntryId, event.message)]);
      case "assistant_final":
        for (const call of event.message.content) {
          if (call.type === "toolCall")
            this.calls.set(call.id, { historyEntryId: event.historyEntryId, call });
        }
        return this.writer.append(assistantHistoryEntries(event.historyEntryId, event.message));
      case "tool_run_finished":
      case "tool_run_blocked":
        this.outcomes.set(
          event.toolCallId,
          event.type === "tool_run_blocked" ? "blocked" : event.outcome,
        );
        return;
      case "tool_result":
        return this.recordToolResult(event.historyEntryId, event.message);
      case "tool_recovery": {
        let failure: string | undefined;
        for (const result of event.toolResults) {
          const nextFailure = this.recordToolResult(event.historyEntryId, result);
          failure ??= nextFailure;
        }
        return failure;
      }
      case "history_rewound":
        this.calls.clear();
        this.outcomes.clear();
        return this.writer.truncateFromSources(event.removedEntryIds);
      case "turn_finished":
        this.calls.clear();
        this.outcomes.clear();
        return;
    }
  }

  private recordToolResult(historyEntryId: string, result: ToolResultMessage): string | undefined {
    const call = this.calls.get(result.toolCallId);
    const outcome = this.outcomes.get(result.toolCallId);
    this.calls.delete(result.toolCallId);
    this.outcomes.delete(result.toolCallId);
    if (!call || !outcome) return `missing history tool call or outcome for '${result.toolCallId}'`;
    return this.recordTool({
      callHistoryEntryId: call.historyEntryId,
      resultHistoryEntryId: historyEntryId,
      call: call.call,
      result,
      outcome,
    });
  }
}
