import type { OneLineSegment } from "./components/one_line_segments.js";
import type { Theme } from "./theme.js";
import { ToolOutputComponent } from "./tool_output.js";

interface PreviewTruncation {
  truncated: boolean;
  totalLines: number;
  outputLines: number;
}

interface DiffTruncation {
  truncated: boolean;
  totalLines: number;
  outputLines: number;
}

function inline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function renderWriteSuccess(
  theme: Theme,
  path: string,
  bytes: number,
  lines: number,
  preview: string,
  previewTruncation: PreviewTruncation,
  compact: boolean,
): ToolOutputComponent {
  const { palette, text } = theme;
  const writeColor = (s: string) => palette.toolFileRan(s);

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

  const pathInline = inline(path);
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

  const pathInline = inline(path);
  const whyInline = inline(reason);

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
  diff: string,
  diffTruncation: DiffTruncation,
  compact: boolean,
): ToolOutputComponent {
  const { palette, text } = theme;
  const editColor = (s: string) => palette.toolFileRan(s);

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
  const pathInline = inline(path);

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

  const pathInline = inline(path);
  const whyInline = inline(reason);

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
