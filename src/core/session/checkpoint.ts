import type { Message } from "@mariozechner/pi-ai";
import { z } from "zod";
import { type ReasoningEffort, ReasoningEffortSchema, RiskLevelSchema } from "../types.js";
import { APP_VERSION } from "../version.js";

const MessageSchema: z.ZodType<Message> = z.custom<Message>((value) => {
  if (!value || typeof value !== "object") return false;
  const role = (value as { role?: unknown }).role;
  return typeof role === "string";
});

const CheckpointSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  appVersion: z.string(),
  personaId: z.string(),
  reasoning: ReasoningEffortSchema.optional(),
  riskLevel: RiskLevelSchema,
  history: z.array(MessageSchema),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;

export function createCheckpoint(args: {
  personaId: string;
  reasoning?: ReasoningEffort;
  riskLevel: Checkpoint["riskLevel"];
  history: Message[];
  createdAt?: string;
  appVersion?: string;
}): Checkpoint {
  return {
    version: 1,
    createdAt: args.createdAt ?? new Date().toISOString(),
    appVersion: args.appVersion ?? APP_VERSION,
    personaId: args.personaId,
    reasoning: args.reasoning,
    riskLevel: args.riskLevel,
    history: args.history,
  };
}

export function parseCheckpoint(raw: string): Checkpoint {
  const parsed = JSON.parse(raw) as unknown;
  return CheckpointSchema.parse(parsed);
}
