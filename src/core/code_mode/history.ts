import { z } from "zod";
import type { HistoryQuery } from "../history/types.js";
import { formatZodError } from "../utils/zod.js";
import type { CodeModeCapability } from "./capability.js";

const description = [
  "Search and read saved conversation transcripts across repositories and machines. It is read-only.",
  "Use @tau/history only when the user or active instructions explicitly ask to reference, search, or read historical transcripts, not merely because prior sessions might be relevant.",
].join(" ");

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
    source: z.literal("local").optional(),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2_048).optional(),
  })
  .strict();

async function handleHistoryRequest(
  method: "search" | "read",
  args: unknown[],
  history: HistoryQuery,
  signal: AbortSignal,
): Promise<unknown> {
  if (method === "search") {
    const parsed = z.tuple([searchInputSchema.optional()]).safeParse(args);
    if (!parsed.success) {
      throw new Error(`Invalid @tau/history.search options: ${formatZodError(parsed.error)}`);
    }
    return await history.search(parsed.data[0] ?? searchInputSchema.parse({}), signal);
  }
  if (method === "read") {
    const parsed = z
      .tuple([z.string().trim().min(1).max(256), readInputSchema.optional()])
      .safeParse(args);
    if (!parsed.success) {
      throw new Error(`Invalid @tau/history.read options: ${formatZodError(parsed.error)}`);
    }
    return await history.read(
      { ...(parsed.data[1] ?? readInputSchema.parse({})), sessionId: parsed.data[0] },
      signal,
    );
  }
  throw new Error(`unsupported history method '${method}'`);
}

export function createHistoryCapability(history: HistoryQuery): CodeModeCapability {
  return {
    name: "history",
    description,
    api: {
      search: (args, context) => handleHistoryRequest("search", args, history, context.signal),
      read: (args, context) => handleHistoryRequest("read", args, history, context.signal),
    },
  };
}
