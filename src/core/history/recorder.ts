import { z } from "zod";
import type { HistorySessionWriter } from "./history_manager.js";
import { historyTextEntrySchema } from "./schema.js";

export const historyRecordEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    entry: historyTextEntrySchema,
  }),
  z.object({
    type: z.literal("toolCall"),
    callId: z.string(),
    sourceId: z.string(),
    name: z.string(),
    arguments: z.unknown(),
  }),
  z.object({
    type: z.literal("toolResult"),
    callId: z.string(),
    sourceId: z.string(),
    timestamp: z.number(),
    result: z.unknown(),
    outcome: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
  }),
  z.object({ type: z.literal("diagnostic"), message: z.string() }),
  z.object({ type: z.literal("endTurn") }),
  z.object({ type: z.literal("rewind"), sourceIds: z.array(z.string()) }),
]);

export type HistoryRecordEvent = z.infer<typeof historyRecordEventSchema>;
export type HistoryRecordSink = (event: HistoryRecordEvent) => Promise<void>;
export type OpenSubagentHistory = (session: {
  sessionId: string;
  parentSessionId: string;
  workingDirectory: string;
  createdAt: number;
}) => HistoryRecordSink;

export class HistoryRecorder {
  private readonly calls = new Map<string, Extract<HistoryRecordEvent, { type: "toolCall" }>>();

  constructor(private readonly writer: HistorySessionWriter) {}

  record(event: HistoryRecordEvent): string | undefined {
    switch (event.type) {
      case "message":
        return this.writer.append([event.entry]);
      case "toolCall":
        this.calls.set(event.callId, structuredClone(event));
        return;
      case "toolResult": {
        const call = this.calls.get(event.callId);
        this.calls.delete(event.callId);
        if (!call) return `missing history tool call for '${event.callId}'`;
        return this.writer.append([
          {
            id: event.callId,
            sourceIds: [call.sourceId, event.sourceId],
            type: "tool",
            timestamp: event.timestamp,
            name: call.name,
            arguments: call.arguments,
            result: structuredClone(event.result),
            outcome: event.outcome,
          },
        ]);
      }
      case "diagnostic":
        return event.message;
      case "endTurn":
        this.calls.clear();
        return;
      case "rewind":
        this.calls.clear();
        return this.writer.truncateFromSources(event.sourceIds);
    }
  }
}
