import { type TruncationResult, truncateHead, truncateMiddle, truncateTail } from "./truncate.js";

export type UiTruncationStrategy = "head" | "middle" | "tail";

export interface UiTruncationOptions {
  maxLines: number;
  maxTokens?: number;
  strategy?: UiTruncationStrategy;
  marker?: string;
}

export function truncateForUi(content: string, options: UiTruncationOptions): TruncationResult {
  const { strategy = "middle", maxLines, maxTokens, marker } = options;
  if (strategy === "head") {
    return truncateHead(content, { maxLines, maxTokens });
  }
  if (strategy === "tail") {
    return truncateTail(content, { maxLines, maxTokens });
  }
  return truncateMiddle(content, { maxLines, maxTokens, marker });
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

export interface CompactPreviewOptions {
  totalLines?: number;
  maxLines?: number;
  indent?: number;
  unitLabel?: string;
}

export const DEFAULT_COMPACT_PREVIEW_LINES = 4;

export function buildCompactPreviewLines(
  lines: string[],
  {
    totalLines,
    maxLines = DEFAULT_COMPACT_PREVIEW_LINES,
    indent = 4,
    unitLabel = "lines",
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
    output.push(`${pad}${line}`);
  }

  if (remaining > 0) {
    output.push(`${pad}…${remaining} more ${unitLabel}…`);
  }

  return output.length > 0 ? output.join("\n") : undefined;
}

export const BASH_UI_MAX_LINES = 32;
export const BASH_UI_MAX_TOKENS = 5000;

export const READ_UI_MAX_LINES = 32;
export const READ_UI_MAX_TOKENS = 5000;

export const GREP_UI_MAX_LINES = 32;
export const GREP_UI_MAX_TOKENS = 5000;

export const WRITE_UI_PREVIEW_LINES = 16;

export const EDIT_DIFF_MAX_LINES = 200;
export const EDIT_DIFF_MAX_TOKENS = 5000;
