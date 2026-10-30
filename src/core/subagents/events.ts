import { z } from "zod";
import type { UsageLogEntry } from "../usage/logs.js";
import type { SubagentActivity } from "./types.js";

export const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("json"), value: z.json() }),
  z.object({ type: z.literal("image"), mimeType: z.string(), data: z.string() }),
  z.object({ type: z.literal("unavailable"), reason: z.string() }),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export const observableEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("notice"), code: z.string(), content: z.array(contentBlockSchema) }),
  z.object({ kind: z.literal("assistant"), content: z.array(contentBlockSchema) }),
  z.object({
    kind: z.literal("tool_call"),
    callId: z.string(),
    toolName: z.string(),
    arguments: z.array(contentBlockSchema),
  }),
  z.object({
    kind: z.literal("tool_result"),
    callId: z.string(),
    toolName: z.string(),
    outcome: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
    content: z.array(contentBlockSchema),
  }),
]);
export type ObservableEvent = z.infer<typeof observableEventSchema>;
export type SubagentRuntimeEvent =
  | { type: "trace"; event: ObservableEvent }
  | { type: "activity"; activity: SubagentActivity }
  | {
      type: "usage";
      entry: Omit<UsageLogEntry, "sessionId" | "agent">;
      contextTokens: number;
      contextWindow: number;
    };
