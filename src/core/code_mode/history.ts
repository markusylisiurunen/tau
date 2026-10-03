import { readFileSync } from "node:fs";
import { z } from "zod";
import type { HistoryQuery } from "../history/types.js";
import { formatZodError } from "../utils/zod.js";
import type { CodeModeCapability } from "./capability.js";

const description = [
  "Search and read saved conversation transcripts across repositories and machines; tau.history is read-only.",
  "Use tau.history only when the user or active instructions explicitly ask to reference, search, or read historical transcripts, not merely because prior sessions might be relevant.",
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
    limit: z.number().int().min(1).max(75).default(10),
    cursor: z.string().min(1).max(2_048).optional(),
  })
  .strict();
const readInputSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(256),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2_048).optional(),
  })
  .strict();

const documentation = readFileSync(
  new URL("../static/code_mode/history/documentation.md", import.meta.url),
  "utf8",
);

async function handleHistoryRequest(
  method: "search" | "read",
  args: unknown[],
  history: HistoryQuery,
  signal: AbortSignal,
): Promise<unknown> {
  if (args.length !== 1) {
    throw new Error(`tau.history.${method} expects one options object`);
  }
  if (method === "search") {
    const parsed = searchInputSchema.safeParse(args[0] ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid tau.history.search options: ${formatZodError(parsed.error)}`);
    }
    return await history.search(parsed.data, signal);
  }
  if (method === "read") {
    const parsed = readInputSchema.safeParse(args[0]);
    if (!parsed.success) {
      throw new Error(`Invalid tau.history.read options: ${formatZodError(parsed.error)}`);
    }
    return await history.read(parsed.data, signal);
  }
  throw new Error(`unsupported history method '${method}'`);
}

export function createHistoryCapability(history: HistoryQuery): CodeModeCapability {
  return {
    name: "history",
    description,
    documentation,
    api: {
      search: (args, context) => handleHistoryRequest("search", args, history, context.signal),
      read: (args, context) => handleHistoryRequest("read", args, history, context.signal),
    },
  };
}
