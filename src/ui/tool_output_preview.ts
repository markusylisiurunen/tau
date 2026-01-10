import type { TruncationResult } from "../utils/truncate.js";
import { truncateForUi, type UiTruncationOptions } from "./tool_truncation.js";

export const DEFAULT_COMPACT_PREVIEW_LINES = 4;

export type PreviewLineStyle = (line: string) => string;

export interface CompactPreviewOptions {
  totalLines?: number;
  maxLines?: number;
  indent?: number;
  unitLabel?: string;
  lineStyle?: PreviewLineStyle;
  moreStyle?: PreviewLineStyle;
}

export interface PreviewPolicy extends UiTruncationOptions {
  maxPreviewLines?: number;
  unitLabel?: string;
}

export interface PreviewResult {
  truncation: TruncationResult;
  previewLines: string[];
}

export function applyPreviewPolicy(content: string, policy: PreviewPolicy): PreviewResult {
  const truncation = truncateForUi(content, policy);
  const preview = truncation.content.trimEnd();
  const previewLines = preview ? preview.split("\n") : [];
  return { truncation, previewLines };
}

export function buildCompactPreviewLines(
  lines: string[],
  {
    totalLines,
    maxLines = DEFAULT_COMPACT_PREVIEW_LINES,
    indent = 4,
    unitLabel = "lines",
    lineStyle = (line) => line,
    moreStyle = (line) => line,
  }: CompactPreviewOptions = {},
): string | undefined {
  if (lines.length === 0 || maxLines <= 0) return undefined;

  const shownLines = lines.slice(0, maxLines);
  const total = totalLines ?? lines.length;
  const shownCount = Math.min(total, shownLines.length);
  const remaining = Math.max(0, total - shownCount);

  const pad = " ".repeat(Math.max(0, indent));
  const output: string[] = [];
  for (const line of shownLines) {
    output.push(lineStyle(`${pad}${line}`));
  }

  if (remaining > 0) {
    output.push(moreStyle(`${pad}…${remaining} more ${unitLabel}…`));
  }

  return output.length > 0 ? output.join("\n") : undefined;
}
