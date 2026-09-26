import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";

export type SystemMessageMetadata = {
  type: "instruction" | "auto-compaction-continuation";
  version: 1;
};

export type IntermediateSystemMessage = {
  role: "system";
  content: string;
  timestamp: number;
  metadata: SystemMessageMetadata;
};

const intermediateSystemMessageSchema = z.strictObject({
  role: z.literal("system"),
  content: z.string(),
  timestamp: z.number().finite(),
  metadata: z.strictObject({
    type: z.enum(["instruction", "auto-compaction-continuation"]),
    version: z.literal(1),
  }),
});

export function parseIntermediateSystemMessage(value: unknown): IntermediateSystemMessage {
  return intermediateSystemMessageSchema.parse(value);
}

export function isIntermediateSystemMessage(value: unknown): value is IntermediateSystemMessage {
  return intermediateSystemMessageSchema.safeParse(value).success;
}

export function isSystemCompactionContinuation(message: Message): boolean {
  return (
    isIntermediateSystemMessage(message) && message.metadata.type === "auto-compaction-continuation"
  );
}

export function projectSystemMessage(message: Message): Message {
  if (message.role !== "system") return message;
  const systemMessage = intermediateSystemMessageSchema.parse(message);
  return {
    role: systemMessage.role,
    content: systemMessage.content,
    timestamp: systemMessage.timestamp,
  };
}
