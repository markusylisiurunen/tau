import { formatTokenEstimate } from "../utils/token.js";
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
  added: number;
  removed: number;
}

function* iterateTextLinesForDiff(text: string): Iterable<string> {
  if (text.length === 0) return;

  let start = 0;
  while (true) {
    const idx = text.indexOf("\n", start);
    if (idx === -1) {
      yield text.slice(start);
      break;
    }
    yield text.slice(start, idx);
    start = idx + 1;
    if (start === text.length) {
      yield "";
      break;
    }
  }
}

function buildSimpleDiff(oldText: string, newText: string): DiffResult {
  const safeMaxLines = Math.max(1, EDIT_DIFF_MAX_LINES);
  const headCount = Math.floor(safeMaxLines / 2);
  const tailCount = safeMaxLines - headCount;

  let totalLines = 0;
  let added = 0;
  let removed = 0;

  let allLines: string[] | undefined = [];
  const headLines: string[] = [];

  const tailBuffer = tailCount > 0 ? new Array<string>(tailCount) : [];
  let tailSize = 0;
  let tailPos = 0;

  const handleLine = (line: string): void => {
    totalLines++;

    if (allLines) {
      allLines.push(line);
      if (allLines.length > safeMaxLines) {
        allLines = undefined;
      }
    }

    if (headLines.length < headCount) {
      headLines.push(line);
    }

    if (tailCount > 0) {
      tailBuffer[tailPos] = line;
      tailPos = (tailPos + 1) % tailCount;
      tailSize = Math.min(tailSize + 1, tailCount);
    }
  };

  for (const line of iterateTextLinesForDiff(oldText)) {
    removed++;
    handleLine(`- ${line}`);
  }

  for (const line of iterateTextLinesForDiff(newText)) {
    added++;
    handleLine(`+ ${line}`);
  }

  if (totalLines === 0) {
    return {
      diff: "",
      truncation: {
        truncated: false,
        totalLines: 0,
        outputLines: 0,
      },
      added,
      removed,
    };
  }

  const truncatedByLines = totalLines > safeMaxLines;

  let diffCandidate: string;
  if (!truncatedByLines) {
    diffCandidate = (allLines ?? []).join("\n");
  } else {
    const tailLines: string[] = [];
    for (let i = 0; i < tailSize; i++) {
      const idx = (tailPos - tailSize + i + tailCount) % tailCount;
      tailLines.push(tailBuffer[idx]!);
    }
    diffCandidate = [...headLines, ...tailLines].join("\n");
  }

  const display = truncateForUi(diffCandidate, {
    maxLines: Math.min(totalLines, safeMaxLines),
    maxTokens: EDIT_DIFF_MAX_TOKENS,
    strategy: "middle",
  });

  const truncated = truncatedByLines || display.truncated;

  return {
    diff: display.content,
    truncation: {
      truncated,
      totalLines,
      outputLines: display.outputLines,
    },
    added,
    removed,
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
  const successBullet = (s: string) => palette.diffAdded(s);

  const { truncation: previewTruncation, previewLines } = applyPreviewPolicy(content, {
    maxLines: WRITE_UI_PREVIEW_LINES,
    strategy: "head",
  });

  const preview = previewTruncation.content;
  const expandedSections: Array<string | undefined> = [];
  expandedSections.push(
    palette.muted(`${lines} lines · ${formatTokenEstimate(bytes)} · ${bytes} bytes`),
  );

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
    bulletStyle: successBullet,
    bullet: "✓",
    label: "wrote",
    labelStyle: palette.muted,
    accent: pathInline,
    accentStyle: palette.accent,
  });

  const compactLines = buildCompactPreviewLines(previewLines, {
    totalLines: lines,
    maxLines: 16,
    lineStyle: palette.dim,
    moreStyle: palette.dim,
  });
  const infoText = `${lines} lines · ${formatTokenEstimate(bytes)} · ${bytes} bytes`;
  const summaryLine = `    ${palette.muted(`(${infoText})`)}`;
  const compactText = [compactLines, summaryLine].filter(Boolean).join("\n");

  return {
    borderColor: writeColor,
    expanded: {
      title: writeColor(text.bold(`write ${path}`)),
      sections: expandedSections,
    },
    compact: {
      header,
      extraText: compactText,
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
  const successBullet = (s: string) => palette.diffAdded(s);

  const { diff, truncation: diffTruncation, added, removed } = buildSimpleDiff(oldText, newText);
  const diffLines = diff ? diff.split("\n") : [];

  const sizeDiff = newLength - oldLength;
  const diffStr =
    sizeDiff === 0 ? "same size" : sizeDiff > 0 ? `+${sizeDiff} chars` : `${sizeDiff} chars`;

  const expandedSections: Array<string | undefined> = [];
  expandedSections.push(palette.muted(`replaced ${oldLength} → ${newLength} chars (${diffStr})`));
  if (diffLines.length > 0) {
    expandedSections.push(diffLines.map((line) => colorDiffLine(palette, line)).join("\n"));
  }

  if (diffTruncation.truncated) {
    const icon = palette.warn("◆");
    const msg = palette.dim(
      `truncated: ${diffTruncation.outputLines} of ${diffTruncation.totalLines} lines`,
    );
    expandedSections.push(`${icon} ${msg}`);
  }

  const pathInline = inlineText(path);

  const header = buildHeaderLine({
    bulletStyle: successBullet,
    bullet: "✓",
    label: "edited",
    labelStyle: palette.muted,
    accent: pathInline,
    accentStyle: palette.accent,
  });

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
  const summaryLine = `    ${palette.muted(`(+${added}, -${removed})`)}`;
  compactLines.push(summaryLine);

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
  });

  return {
    borderColor: errorColor,
    expanded: {
      title: errorColor(text.bold(`edit ${path}`)),
      sections: section ? [section] : [],
    },
    compact: {
      header,
      extraText: whyInline ? errorColor(`    blocked: ${whyInline}`) : undefined,
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
