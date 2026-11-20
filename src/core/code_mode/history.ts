import { z } from "zod";
import type { HistoryQuery } from "../history/types.js";
import { type CodeModePackage, definePackage, method } from "./package.js";

const description = "Search and read the transcripts of past Tau sessions.";

const attributeFilterSchema = z.union([
  z.string().max(1_024),
  z.object({ contains: z.string().min(1).max(1_024) }).strict(),
]);
const attributeFiltersSchema = z
  .record(z.string().min(1).max(64), attributeFilterSchema)
  .refine((attributes) => Object.keys(attributes).length <= 32);
const searchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(1_000).optional(),
    attributes: attributeFiltersSchema.optional(),
    timeRange: z
      .strictObject({
        field: z.enum(["createdAt", "updatedAt"]),
        since: z.number().optional(),
        until: z.number().optional(),
      })
      .refine((range) => range.since !== undefined || range.until !== undefined, {
        message: "timeRange requires since or until",
      })
      .refine(
        (range) =>
          range.since === undefined || range.until === undefined || range.since < range.until,
        { message: "timeRange.since must be before timeRange.until" },
      )
      .optional(),
    parent: z
      .union([
        z.literal("none"),
        z.literal("any"),
        z.object({ sessionId: z.string().trim().min(1).max(256) }).strict(),
      ])
      .optional(),
    limit: z.number().int().min(1).max(75).default(10),
    cursor: z.string().min(1).max(2_048).optional(),
  })
  .strict();
const readInputSchema = z
  .object({
    afterEntryId: z.string().min(1).max(512).optional(),
    source: z.literal("local").optional(),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2_048).optional(),
  })
  .strict()
  .refine(
    (input): input is typeof input & ({ afterEntryId?: never } | { cursor?: never }) =>
      input.afterEntryId === undefined || input.cursor === undefined,
    "pass afterEntryId or cursor, not both",
  );

export function createHistoryPackage(history: HistoryQuery): CodeModePackage {
  return definePackage("history", description, {
    search: method(z.tuple([searchInputSchema.optional()]), ([options], { signal }) =>
      history.search(options ?? searchInputSchema.parse({}), signal),
    ),
    read: method(
      z.tuple([z.string().trim().min(1).max(256), readInputSchema.optional()]),
      ([sessionId, options], { signal }) =>
        history.read({ ...(options ?? readInputSchema.parse({})), sessionId }, signal),
    ),
  });
}
