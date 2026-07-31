import { formatAdaptiveNumber, formatDurationMs } from "../utils/format.js";
import { buildCompactPreviewLines } from "../utils/tool_preview.js";
import type { ToolUiLine, ToolUiText } from "./activity.js";

type SubagentUiTextOptions = {
  output: string;
  statusText?: string;
  maxOutputLines?: number;
  maxPreviewLines?: number;
  fullText?: string;
};

type SubagentStatusOptions = {
  costTotal: number;
  durationMs?: number;
};

export function truncateOutputLines(lines: string[], maxLines: number): string[] {
  if (maxLines <= 0) return [];
  if (lines.length <= maxLines) return lines;
  const keptCount = Math.max(0, maxLines - 1);
  const remaining = Math.max(1, lines.length - keptCount);
  const marker = `…${remaining} more lines…`;
  return [...lines.slice(0, keptCount), marker];
}

export function buildSubagentUiText({
  output,
  statusText,
  maxOutputLines,
  maxPreviewLines,
  fullText,
}: SubagentUiTextOptions): ToolUiText {
  const trimmed = output.trimEnd();
  const outputLines = trimmed ? trimmed.split("\n") : [];
  const truncatedLines =
    typeof maxOutputLines === "number"
      ? truncateOutputLines(outputLines, maxOutputLines)
      : outputLines;
  const previewLimit = maxPreviewLines ?? maxOutputLines ?? truncatedLines.length;
  const preview = buildCompactPreviewLines(truncatedLines, {
    maxLines: previewLimit,
    totalLines: truncatedLines.length,
    unitLabel: "lines",
    indent: 0,
  });
  const previewLines: ToolUiLine[] = preview ? preview.split("\n").map((text) => ({ text })) : [];
  const trimmedFullText = fullText?.trimEnd();
  const fullLines: ToolUiLine[] = trimmedFullText
    ? trimmedFullText.split("\n").map((text) => ({ text }))
    : truncatedLines.map((text) => ({ text }));
  const statusLine = statusText || undefined;

  return {
    previewLines,
    statusLine,
    fullLines,
  };
}

export function formatSubagentStatusLine({ costTotal, durationMs }: SubagentStatusOptions): string {
  const cost = `$${formatAdaptiveNumber(costTotal, 2, 5)}`;
  const duration = formatDurationMs(durationMs);
  return `cost ${cost} · duration ${duration}`;
}
