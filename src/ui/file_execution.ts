import { bytesToTokens } from "../utils/token.js";
import { inlineText } from "./inline.js";
import type { Theme } from "./theme.js";
import {
  buildHeaderLine,
  buildSection,
  renderToolOutput,
  type ToolOutputViewModel,
} from "./tool_output_layout.js";
import { applyPreviewPolicy, buildCompactPreviewLines } from "./tool_output_preview.js";
import {
  EDIT_DIFF_MAX_LINES,
  EDIT_DIFF_MAX_TOKENS,
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

export function buildWriteSuccessView(
  theme: Theme,
  path: string,
  bytes: number,
  lines: number,
  content: string,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const writeColor = (s: string) => palette.toolFileRan(s);

  const { truncation: previewTruncation, previewLines } = applyPreviewPolicy(content, {
    maxLines: WRITE_UI_PREVIEW_LINES,
    strategy: "head",
  });

  const preview = previewTruncation.content;
  const expandedSections: Array<string | undefined> = [];
  expandedSections.push(palette.muted(`${bytes} bytes (${lines} lines)`));

  if (preview) {
    expandedSections.push(palette.filePreview(preview));
  }

  if (previewTruncation.truncated) {
    const icon = palette.warn("◆");
    const msg = palette.dim(
      `preview: ${previewTruncation.outputLines} of ${previewTruncation.totalLines} lines`,
    );
    expandedSections.push(`${icon} ${msg}`);
  }

  const pathInline = inlineText(path);
  const header = buildHeaderLine({
    bulletStyle: writeColor,
    label: "wrote",
    labelStyle: palette.muted,
    accent: pathInline,
    accentStyle: palette.accent,
    tailSegments: [
      { text: " ", style: (s) => s },
      { text: `(${lines} lines)`, style: palette.muted },
    ],
  });

  const compactLines = buildCompactPreviewLines(previewLines, {
    totalLines: lines,
    lineStyle: palette.muted,
    moreStyle: palette.dim,
  });

  return {
    borderColor: writeColor,
    expanded: {
      title: writeColor(text.bold(`write ${path}`)),
      sections: expandedSections,
    },
    compact: {
      header,
      extraText: compactLines,
    },
  };
}

export function buildWriteBlockedView(
  theme: Theme,
  path: string,
  reason: string,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const errorColor = (s: string) => palette.error(s);

  const msg = reason.trim();
  const section = buildSection(msg ? [errorColor(msg)] : []);

  const pathInline = inlineText(path);
  const whyInline = inlineText(reason);

  const header = buildHeaderLine({
    bulletStyle: errorColor,
    label: "write",
    labelStyle: palette.muted,
    accent: pathInline,
    accentStyle: palette.accent,
    tailSegments: [
      { text: " ", style: (s) => s },
      { text: `(blocked: ${whyInline})`, style: palette.muted },
    ],
    flexTailIndices: [1],
  });

  return {
    borderColor: errorColor,
    expanded: {
      title: errorColor(text.bold(`write ${path}`)),
      sections: section ? [section] : [],
    },
    compact: { header },
  };
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

export function buildEditSuccessView(
  theme: Theme,
  path: string,
  oldLength: number,
  newLength: number,
  oldText: string,
  newText: string,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const editColor = (s: string) => palette.toolFileRan(s);

  const { diff, truncation: diffTruncation } = buildSimpleDiff(oldText, newText);

  const sizeDiff = newLength - oldLength;
  const diffStr =
    sizeDiff === 0 ? "same size" : sizeDiff > 0 ? `+${sizeDiff} chars` : `${sizeDiff} chars`;

  const expandedSections: Array<string | undefined> = [];
  expandedSections.push(palette.muted(`replaced ${oldLength} → ${newLength} chars (${diffStr})`));
  expandedSections.push(
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
    expandedSections.push(`${icon} ${msg}`);
  }

  const { added, removed } = countDiffChanges(diff);
  const pathInline = inlineText(path);

  const header = buildHeaderLine({
    bulletStyle: editColor,
    label: "edited",
    labelStyle: palette.muted,
    accent: pathInline,
    accentStyle: palette.accent,
    tailSegments: [
      { text: " ", style: (s) => s },
      { text: `(+${added}, -${removed})`, style: palette.muted },
    ],
  });

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

  return {
    borderColor: editColor,
    expanded: {
      title: editColor(text.bold(`edit ${path}`)),
      sections: expandedSections,
    },
    compact: {
      header,
      extraText: compactLines.length > 0 ? compactLines.join("\n") : undefined,
    },
  };
}

export function buildEditBlockedView(
  theme: Theme,
  path: string,
  reason: string,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const errorColor = (s: string) => palette.error(s);

  const msg = reason.trim();
  const section = buildSection(msg ? [errorColor(msg)] : []);

  const pathInline = inlineText(path);
  const whyInline = inlineText(reason);

  const header = buildHeaderLine({
    bulletStyle: errorColor,
    label: "edit",
    labelStyle: palette.muted,
    accent: pathInline,
    accentStyle: palette.accent,
    tailSegments: [
      { text: " ", style: (s) => s },
      { text: `(blocked: ${whyInline})`, style: palette.muted },
    ],
    flexTailIndices: [1],
  });

  return {
    borderColor: errorColor,
    expanded: {
      title: errorColor(text.bold(`edit ${path}`)),
      sections: section ? [section] : [],
    },
    compact: { header },
  };
}

export function renderWriteSuccess(
  theme: Theme,
  path: string,
  bytes: number,
  lines: number,
  content: string,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildWriteSuccessView(theme, path, bytes, lines, content), compact);
}

export function renderWriteBlocked(
  theme: Theme,
  path: string,
  reason: string,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildWriteBlockedView(theme, path, reason), compact);
}

export function renderEditSuccess(
  theme: Theme,
  path: string,
  oldLength: number,
  newLength: number,
  oldText: string,
  newText: string,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(
    buildEditSuccessView(theme, path, oldLength, newLength, oldText, newText),
    compact,
  );
}

export function renderEditBlocked(
  theme: Theme,
  path: string,
  reason: string,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildEditBlockedView(theme, path, reason), compact);
}
