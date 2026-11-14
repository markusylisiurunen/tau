import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { truncateMiddle } from "../utils/truncate.js";
import { historyEntrySchema, historySessionDescriptorSchema } from "./schema.js";
import type { HistoryQuery } from "./types.js";

export type HistoryExport = z.infer<typeof historyExportSchema>;

export const historyExportSchema = z
  .object({
    session: historySessionDescriptorSchema
      .extend({ childSessionIds: z.array(z.string()) })
      .strict(),
    entries: z.array(historyEntrySchema),
  })
  .strict();

export async function readHistoryExport(
  query: HistoryQuery,
  sessionId: string,
): Promise<HistoryExport> {
  const first = await query.read({ sessionId, limit: 100 });
  const entries = [...first.entries];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await query.read({ sessionId, limit: 100, cursor });
    entries.push(...page.entries);
    cursor = page.nextCursor;
  }
  const childSessionIds: string[] = [];
  do {
    const page = await query.search({
      parent: { sessionId },
      order: "sessionId",
      limit: 75,
      cursor,
    });
    childSessionIds.push(...page.sessions.map((child) => child.sessionId));
    cursor = page.nextCursor;
  } while (cursor);
  return {
    session: { ...first.session, childCount: childSessionIds.length, childSessionIds },
    entries,
  };
}

function fence(text: string, language: string): string {
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const delimiter = "`".repeat(longest + 1);
  return `${delimiter}${language}\n${text}\n${delimiter}`;
}

function contentBlockText(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) return undefined;
  if (
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string" &&
    Object.keys(value).every((key) => ["type", "text", "textSignature"].includes(key))
  )
    return value.text;
  if (
    value.type === "image" &&
    "mimeType" in value &&
    typeof value.mimeType === "string" &&
    "data" in value &&
    typeof value.data === "string" &&
    Object.keys(value).every((key) => ["type", "mimeType", "data"].includes(key))
  ) {
    return `[image: ${value.mimeType}; binary data omitted]`;
  }
  return undefined;
}

function readableJson(value: unknown, compact = false): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => {
      if (item && typeof item === "object" && "type" in item && item.type === "image") {
        if ("data" in item && typeof item.data === "string" && "mimeType" in item) {
          return { ...item, data: "[binary data omitted]" };
        }
      }
      return item;
    },
    compact ? undefined : 2,
  );
}

function readableValue(value: unknown): { text: string; language: string } {
  if (typeof value === "string") return { text: value, language: "text" };
  if (Array.isArray(value)) {
    const blocks = value.map(contentBlockText);
    if (blocks.every((block) => block !== undefined))
      return { text: blocks.join("\n"), language: "text" };
  }
  return { text: readableJson(value), language: "json" };
}

export function renderHistoryMarkdown(data: HistoryExport, compact: boolean): string {
  const parts = [`---\n${stringifyYaml(data.session).trimEnd()}\n---`];
  for (const [index, entry] of data.entries.entries()) {
    const time = new Date(entry.timestamp).toISOString();
    const tool =
      entry.type === "tool" ? ` · ${entry.name.replace(/[\r\n]/g, " ")} · ${entry.outcome}` : "";
    parts.push(`## ${index + 1} · ${entry.type}${tool} · ${time}`);
    if (entry.type !== "tool") {
      parts.push(fence(readableValue(entry.content).text, "text"));
      continue;
    }
    for (const [label, rendered, budget] of [
      ["arguments", { text: readableJson(entry.arguments, compact), language: "json" }, 256],
      ["result", readableValue(entry.result), 512],
    ] as const) {
      const preview = compact
        ? truncateMiddle(rendered.text, { maxTokens: budget, maxLines: Number.POSITIVE_INFINITY })
        : undefined;
      parts.push(
        `${label}:\n${fence(preview?.content ?? rendered.text, preview?.truncated ? "text" : rendered.language)}`,
      );
    }
  }
  return `${parts.join("\n\n")}\n`;
}
