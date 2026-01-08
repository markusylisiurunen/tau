import { bytesToTokens } from "../utils/token.js";
import type { OneLineSegment } from "./components/one_line_segments.js";
import { inlineText } from "./inline.js";
import type { Theme } from "./theme.js";
import { ToolOutputComponent } from "./tool_output.js";
import {
  EDIT_DIFF_MAX_LINES,
  EDIT_DIFF_MAX_TOKENS,
  truncateForUi,
  WRITE_UI_PREVIEW_LINES,
} from "./tool_truncation.js";

interface DiffTruncation {
  truncated: boolean;
  totalLines: number;
  outputLines: number;
}

interface DiffResult {
  diff: string;
  truncation: DiffTruncation;
}

function buildSimpleDiff(oldText: string, newText: string): DiffResult {
  const oldLines = oldText.length === 0 ? ["(empty)"] : oldText.split("\n");
  const newLines = newText.length === 0 ? ["(empty)"] : newText.split("\n");

  const diffLines: string[] = [];
  for (const line of oldLines) {
    diffLines.push(`- ${line}`);
  }
  for (const line of newLines) {
    diffLines.push(`+ ${line}`);
  }

  const totalLines = diffLines.length;
  let outputLines = diffLines;
  let truncated = false;

  if (outputLines.length > EDIT_DIFF_MAX_LINES) {
    const headCount = Math.floor(EDIT_DIFF_MAX_LINES / 2);
    const tailCount = EDIT_DIFF_MAX_LINES - headCount;
    outputLines = [...outputLines.slice(0, headCount), ...outputLines.slice(-tailCount)];
    truncated = true;
  }

  let diff = outputLines.join("\n");

  if (bytesToTokens(Buffer.byteLength(diff, "utf-8")) > EDIT_DIFF_MAX_TOKENS) {
    const lines = diff.split("\n");
    while (
      bytesToTokens(Buffer.byteLength(lines.join("\n"), "utf-8")) > EDIT_DIFF_MAX_TOKENS &&
      lines.length > 2
    ) {
      const mid = Math.floor(lines.length / 2);
      lines.splice(mid, 1);
    }
    diff = lines.join("\n");
    truncated = true;
  }

  return {
    diff,
    truncation: {
      truncated,
      totalLines,
      outputLines: diff.split("\n").length,
    },
  };
}

export function renderWriteSuccess(
  theme: Theme,
  path: string,
  bytes: number,
  lines: number,
  content: string,
  compact: boolean,
): ToolOutputComponent {
  const { palette, text } = theme;
  const writeColor = (s: string) => palette.toolFileRan(s);

  const previewTruncation = truncateForUi(content, {
    maxLines: WRITE_UI_PREVIEW_LINES,
    strategy: "head",
  });

  const preview = previewTruncation.content;
  const expandedParts: string[] = [];
  expandedParts.push(writeColor(text.bold(`write ${path}`)));
  expandedParts.push("");
  expandedParts.push(palette.muted(`${bytes} bytes (${lines} lines)`));

  if (preview) {
    expandedParts.push("");
    expandedParts.push(palette.filePreview(preview));
  }

  if (previewTruncation.truncated) {
    const icon = palette.warn("◆");
    const msg = palette.dim(
      `preview: ${previewTruncation.outputLines} of ${previewTruncation.totalLines} lines`,
    );
    expandedParts.push("");
    expandedParts.push(`${icon} ${msg}`);
  }

  const pathInline = inlineText(path);
  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: writeColor },
    { text: " ", style: (s) => s },
    { text: "wrote", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: pathInline, style: palette.accent },
    { text: " ", style: (s) => s },
    { text: `(${lines} lines)`, style: palette.muted },
  ];

  const maxPreviewLines = 4;
  const previewLines = preview.trimEnd() ? preview.trimEnd().split("\n") : [];
  const shownPreviewLines = previewLines.slice(0, maxPreviewLines);
  const shownCount = Math.min(lines, shownPreviewLines.length);
  const remaining = Math.max(0, lines - shownCount);

  const compactLines: string[] = [];
  for (const l of shownPreviewLines) {
    compactLines.push(palette.muted(`    ${l}`));
  }
  if (remaining > 0) {
    compactLines.push(palette.dim(`    (${remaining} more lines)`));
  }

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor: writeColor, text: expandedParts.join("\n") },
    compactView: {
      segments,
      flexIndices: [5],
      extraText: compactLines.length > 0 ? compactLines.join("\n") : undefined,
    },
  });
}

export function renderWriteBlocked(
  theme: Theme,
  path: string,
  reason: string,
  compact: boolean,
): ToolOutputComponent {
  const { palette, text } = theme;
  const errorColor = (s: string) => palette.error(s);

  const expandedParts: string[] = [errorColor(text.bold(`write ${path}`))];
  const msg = reason.trim();
  if (msg) {
    expandedParts.push("");
    expandedParts.push(errorColor(msg));
  }

  const pathInline = inlineText(path);
  const whyInline = inlineText(reason);

  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: errorColor },
    { text: " ", style: (s) => s },
    { text: "write", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: pathInline, style: palette.accent },
    { text: " ", style: (s) => s },
    { text: `(blocked: ${whyInline})`, style: palette.muted },
  ];

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor: errorColor, text: expandedParts.join("\n") },
    compactView: { segments, flexIndices: [5, 7] },
  });
}

function countDiffChanges(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+ ")) added++;
    else if (line.startsWith("- ")) removed++;
  }
  return { added, removed };
}

function colorDiffLine(palette: Theme["palette"], line: string): string {
  if (line.startsWith("- ")) return palette.diffRemoved(line);
  if (line.startsWith("+ ")) return palette.diffAdded(line);
  return palette.muted(line);
}

export function renderEditSuccess(
  theme: Theme,
  path: string,
  oldLength: number,
  newLength: number,
  oldText: string,
  newText: string,
  compact: boolean,
): ToolOutputComponent {
  const { palette, text } = theme;
  const editColor = (s: string) => palette.toolFileRan(s);

  const { diff, truncation: diffTruncation } = buildSimpleDiff(oldText, newText);

  const sizeDiff = newLength - oldLength;
  const diffStr =
    sizeDiff === 0 ? "same size" : sizeDiff > 0 ? `+${sizeDiff} chars` : `${sizeDiff} chars`;

  const expandedParts: string[] = [];
  expandedParts.push(editColor(text.bold(`edit ${path}`)));
  expandedParts.push("");
  expandedParts.push(palette.muted(`replaced ${oldLength} → ${newLength} chars (${diffStr})`));
  expandedParts.push("");
  expandedParts.push(
    diff
      .split("\n")
      .map((line) => colorDiffLine(palette, line))
      .join("\n"),
  );

  if (diffTruncation.truncated) {
    const icon = palette.warn("◆");
    const msg = palette.dim(
      `truncated: ${diffTruncation.outputLines} of ${diffTruncation.totalLines} lines`,
    );
    expandedParts.push("");
    expandedParts.push(`${icon} ${msg}`);
  }

  const { added, removed } = countDiffChanges(diff);
  const pathInline = inlineText(path);

  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: editColor },
    { text: " ", style: (s) => s },
    { text: "edited", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: pathInline, style: palette.accent },
    { text: " ", style: (s) => s },
    { text: `(+${added}, -${removed})`, style: palette.muted },
  ];

  const diffLines = diff ? diff.split("\n") : [];
  const compactLines: string[] = [];
  for (const l of diffLines) {
    if (l.startsWith("- ")) {
      compactLines.push(palette.diffRemoved(`    ${l}`));
    } else if (l.startsWith("+ ")) {
      compactLines.push(palette.diffAdded(`    ${l}`));
    } else {
      compactLines.push(palette.muted(`    ${l}`));
    }
  }
  if (diffTruncation.truncated) {
    const icon = palette.warn("◆");
    const msg = palette.dim(
      `truncated: ${diffTruncation.outputLines} of ${diffTruncation.totalLines} lines`,
    );
    compactLines.push(`    ${icon} ${msg}`);
  }

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor: editColor, text: expandedParts.join("\n") },
    compactView: {
      segments,
      flexIndices: [5],
      extraText: compactLines.length > 0 ? compactLines.join("\n") : undefined,
    },
  });
}

export function renderEditBlocked(
  theme: Theme,
  path: string,
  reason: string,
  compact: boolean,
): ToolOutputComponent {
  const { palette, text } = theme;
  const errorColor = (s: string) => palette.error(s);

  const expandedParts: string[] = [errorColor(text.bold(`edit ${path}`))];
  const msg = reason.trim();
  if (msg) {
    expandedParts.push("");
    expandedParts.push(errorColor(msg));
  }

  const pathInline = inlineText(path);
  const whyInline = inlineText(reason);

  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: errorColor },
    { text: " ", style: (s) => s },
    { text: "edit", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: pathInline, style: palette.accent },
    { text: " ", style: (s) => s },
    { text: `(blocked: ${whyInline})`, style: palette.muted },
  ];

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor: errorColor, text: expandedParts.join("\n") },
    compactView: { segments, flexIndices: [5, 7] },
  });
}
