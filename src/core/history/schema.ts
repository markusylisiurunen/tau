import { z } from "zod";

const digestSchema = z
  .object({
    title: z.string(),
    summary: z.string(),
    updatedThroughEntryId: z.string(),
  })
  .strict();
export const historySessionDescriptorSchema = z
  .object({
    sessionId: z.string(),
    attributes: z.record(z.string(), z.string()),
    createdAt: z.number(),
    updatedAt: z.number(),
    parentSessionId: z.string().optional(),
    childCount: z.number().int().nonnegative(),
    webUrl: z.url().optional(),
    digest: digestSchema.optional(),
    snippets: z.array(z.string()),
  })
  .strict();
const jsonValueSchema: z.ZodType<unknown> = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);
const entryBaseSchema = z.object({
  id: z.string(),
  sourceIds: z.array(z.string()),
  timestamp: z.number(),
});
export const userContentSchema = z.union([
  z.string(),
  z.array(
    z.discriminatedUnion("type", [
      z
        .object({ type: z.literal("text"), text: z.string(), textSignature: z.string().optional() })
        .strict(),
      z
        .object({ type: z.literal("image"), data: z.string(), mimeType: z.string().min(1) })
        .strict(),
    ]),
  ),
]);
export const historyTextEntrySchema = z.discriminatedUnion("type", [
  entryBaseSchema.extend({ type: z.literal("user"), content: userContentSchema }).strict(),
  entryBaseSchema.extend({ type: z.literal("assistant"), content: z.string() }).strict(),
  entryBaseSchema.extend({ type: z.literal("system"), content: z.string() }).strict(),
]);
export const historyEntrySchema = z.discriminatedUnion("type", [
  ...historyTextEntrySchema.options,
  entryBaseSchema
    .extend({
      type: z.literal("tool"),
      name: z.string(),
      arguments: jsonValueSchema,
      result: jsonValueSchema,
      outcome: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
    })
    .strict(),
]);
