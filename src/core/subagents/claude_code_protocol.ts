import { z } from "zod";
import { CLAUDE_CODE_MODEL_IDS } from "./claude_code_models.js";
import { observableEventSchema } from "./events.js";

const tokenCount = z.number().finite().nonnegative();
const tokenUsageSchema = z.object({
  input: tokenCount,
  output: tokenCount,
  cacheRead: tokenCount,
  cacheWrite: tokenCount,
});

export type ClaudeCodeTokenUsage = z.infer<typeof tokenUsageSchema>;

export const claudeCodeInputSchema = z.object({
  prompt: z.string(),
  cwd: z.string(),
  model: z.enum(CLAUDE_CODE_MODEL_IDS),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  tools: z.array(z.string()),
  sessionId: z.string().uuid().optional(),
});

export type ClaudeCodeInput = z.infer<typeof claudeCodeInputSchema>;

export const claudeCodeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("control"), path: z.string().min(1) }),
  z.object({ type: z.literal("unconsumed_input"), message: z.string() }),
  z.object({ type: z.literal("trace"), event: observableEventSchema }),
  z.object({ type: z.literal("session"), id: z.string().uuid() }),
  z.object({ type: z.literal("assistant"), text: z.string().max(8192) }),
  z.object({
    type: z.literal("usage"),
    messageId: z.string().min(1).max(256),
    usage: tokenUsageSchema,
  }),
  z.object({
    type: z.literal("tool"),
    name: z.string().max(256),
    subject: z.string().max(1024),
    failed: z.boolean(),
  }),
  z.object({
    type: z.literal("result"),
    response: z.string().max(4 * 1024 * 1024),
    failed: z.boolean(),
    usage: tokenUsageSchema.extend({
      contextWindowUsageTokens: tokenCount,
      contextWindow: tokenCount,
    }),
    cost: tokenCount,
  }),
  z.object({ type: z.literal("error"), message: z.string().max(8192) }),
]);

export type ClaudeCodeEvent = z.infer<typeof claudeCodeEventSchema>;
export type ClaudeCodeResult = Extract<ClaudeCodeEvent, { type: "result" }>;
