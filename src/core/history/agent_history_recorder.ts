import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentEvent } from "../agent/events.js";
import type { HistorySessionWriter } from "./history_manager.js";
import { type HistoryRecordEvent, HistoryRecorder } from "./recorder.js";
import { assistantHistoryEntries, systemHistoryEntry, userHistoryEntry } from "./transcript.js";
import type { HistoryToolEntry } from "./types.js";

export class NativeHistoryAdapter {
  private readonly outcomes = new Map<string, HistoryToolEntry["outcome"]>();

  translate(event: AgentEvent): HistoryRecordEvent[] {
    switch (event.type) {
      case "user_message":
        return [{ type: "message", entry: userHistoryEntry(event.historyEntryId, event.message) }];
      case "system_message":
        return [
          { type: "message", entry: systemHistoryEntry(event.historyEntryId, event.message) },
        ];
      case "assistant_final":
        return [
          ...event.message.content.flatMap((call): HistoryRecordEvent[] =>
            call.type === "toolCall"
              ? [
                  {
                    type: "toolCall",
                    callId: call.id,
                    sourceId: event.historyEntryId,
                    name: call.name,
                    arguments: call.arguments,
                  },
                ]
              : [],
          ),
          ...assistantHistoryEntries(event.historyEntryId, event.message).map(
            (entry): HistoryRecordEvent => ({ type: "message", entry }),
          ),
        ];
      case "tool_run_finished":
      case "tool_run_blocked":
        this.outcomes.set(
          event.toolCallId,
          event.type === "tool_run_blocked" ? "blocked" : event.outcome,
        );
        return [];
      case "tool_result":
      case "tool_recovery":
        return (event.type === "tool_result" ? [event.message] : event.toolResults).map(
          (result): HistoryRecordEvent => {
            const outcome = this.outcomes.get(result.toolCallId);
            this.outcomes.delete(result.toolCallId);
            if (!outcome)
              return {
                type: "diagnostic",
                message: `missing history tool outcome for '${result.toolCallId}'`,
              };
            return {
              type: "toolResult",
              callId: result.toolCallId,
              sourceId: event.historyEntryId,
              timestamp: result.timestamp,
              result: result.content,
              outcome,
            };
          },
        );
      case "history_rewound":
        this.outcomes.clear();
        return [{ type: "rewind", sourceIds: event.removedEntryIds }];
      case "turn_finished":
        this.outcomes.clear();
        return [{ type: "endTurn" }];
      default:
        return [];
    }
  }
}

export class AgentHistoryRecorder {
  private readonly adapter = new NativeHistoryAdapter();
  private readonly recorder: HistoryRecorder;
  constructor(writer: HistorySessionWriter) {
    this.recorder = new HistoryRecorder(writer);
  }

  recordTool(options: {
    callHistoryEntryId: string;
    resultHistoryEntryId: string;
    call: ToolCall;
    result: ToolResultMessage;
    outcome: HistoryToolEntry["outcome"];
  }): string | undefined {
    this.recorder.record({
      type: "toolCall",
      callId: options.call.id,
      sourceId: options.callHistoryEntryId,
      name: options.call.name,
      arguments: options.call.arguments,
    });
    return this.recorder.record({
      type: "toolResult",
      callId: options.call.id,
      sourceId: options.resultHistoryEntryId,
      timestamp: options.result.timestamp,
      result: options.result.content,
      outcome: options.outcome,
    });
  }

  record(event: AgentEvent): string | undefined {
    let failure: string | undefined;
    for (const input of this.adapter.translate(event)) {
      const nextFailure = this.recorder.record(input);
      failure ??= nextFailure;
    }
    return failure;
  }
}
