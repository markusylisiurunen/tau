import type { OneLineSegment } from "./components/one_line_segments.js";
import { theme } from "./theme.js";
import { ToolOutputComponent } from "./tool_output.js";

interface PreviewTruncation {
  truncated: boolean;
  totalLines: number;
  outputLines: number;
}

function bold(text: string): string {
  return `\u001b[1m${text}\u001b[22m`;
}

function inline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatRange(startLine: number, endLine?: number): string {
  if (endLine === undefined) {
    return `${startLine}-EOF`;
  }
  return `${startLine}-${endLine}`;
}

export function renderReadSuccess(
  path: string,
  startLine: number,
  endLine: number | undefined,
  preview: string,
  previewTruncation: PreviewTruncation,
  modelTruncation: PreviewTruncation,
  compact: boolean,
): ToolOutputComponent {
  const { palette } = theme;
  const readColor = (s: string) => palette.toolFileRan(s);

  const expandedParts: string[] = [];
  expandedParts.push(readColor(bold(`read ${path} (${formatRange(startLine, endLine)})`)));

  const out = preview.trimEnd();
  if (out) {
    expandedParts.push("", palette.filePreview(out));
  }

  if (previewTruncation.truncated) {
    const icon = palette.warn("◆");
    const msg = palette.dim(
      `preview: ${previewTruncation.outputLines} of ${previewTruncation.totalLines} lines`,
    );
    expandedParts.push("", `${icon} ${msg}`);
  }

  if (modelTruncation.truncated) {
    const icon = palette.warn("◆");
    const msg = palette.warn(
      `truncated for model: ${modelTruncation.outputLines} of ${modelTruncation.totalLines} lines`,
    );
    expandedParts.push("", `${icon} ${msg}`);
  }

  const pathInline = inline(path);
  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: readColor },
    { text: " ", style: (s) => s },
    { text: "read", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: pathInline, style: palette.accent },
    { text: " ", style: (s) => s },
    { text: `(${previewTruncation.totalLines} lines)`, style: palette.muted },
  ];

  const maxPreviewLines = 4;
  const previewLines = out ? out.split("\n") : [];
  const shownPreviewLines = previewLines.slice(0, maxPreviewLines);
  const remaining = Math.max(0, previewTruncation.totalLines - shownPreviewLines.length);

  const compactLines: string[] = [];
  for (const l of shownPreviewLines) {
    compactLines.push(palette.muted(`    ${l}`));
  }
  if (remaining > 0) {
    compactLines.push(palette.dim(`    (${remaining} more lines)`));
  }

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor: readColor, text: expandedParts.join("\n") },
    compactView: {
      segments,
      flexIndices: [5],
      extraText: compactLines.length > 0 ? compactLines.join("\n") : undefined,
    },
  });
}

export function renderReadBlocked(
  path: string,
  reason: string,
  compact: boolean,
): ToolOutputComponent {
  const { palette } = theme;
  const errorColor = (s: string) => palette.error(s);

  const expandedParts: string[] = [errorColor(bold(`read ${path}`))];
  const msg = reason.trim();
  if (msg) {
    expandedParts.push("", errorColor(msg));
  }

  const pathInline = inline(path);
  const whyInline = inline(reason);

  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: errorColor },
    { text: " ", style: (s) => s },
    { text: "read", style: palette.muted },
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

export function renderListSuccess(
  path: string,
  offset: number,
  limit: number,
  total: number,
  returned: number,
  entries: string[],
  compact: boolean,
): ToolOutputComponent {
  const { palette } = theme;
  const listColor = (s: string) => palette.toolFileRan(s);

  const expandedParts: string[] = [];
  expandedParts.push(listColor(bold(`list ${path}`)));
  expandedParts.push("");
  expandedParts.push(
    palette.muted(`${returned} of ${total} entries (offset ${offset}, limit ${limit})`),
  );

  if (entries.length > 0) {
    expandedParts.push("");
    expandedParts.push(palette.filePreview(entries.join("\n")));
  }

  const pathInline = inline(path);

  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: listColor },
    { text: " ", style: (s) => s },
    { text: "listed", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: pathInline, style: palette.accent },
    { text: " ", style: (s) => s },
    { text: `(${returned} entries)`, style: palette.muted },
  ];

  const maxPreviewLines = 4;
  const shown = entries.slice(0, maxPreviewLines);
  const remaining = Math.max(0, entries.length - shown.length);

  const compactLines: string[] = [];
  for (const l of shown) {
    compactLines.push(palette.muted(`    ${l}`));
  }
  if (remaining > 0) {
    compactLines.push(palette.dim(`    (${remaining} more entries)`));
  }

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor: listColor, text: expandedParts.join("\n") },
    compactView: {
      segments,
      flexIndices: [5],
      extraText: compactLines.length > 0 ? compactLines.join("\n") : undefined,
    },
  });
}

export function renderListBlocked(
  path: string,
  reason: string,
  compact: boolean,
): ToolOutputComponent {
  const { palette } = theme;
  const errorColor = (s: string) => palette.error(s);

  const expandedParts: string[] = [errorColor(bold(`list ${path}`))];
  const msg = reason.trim();
  if (msg) {
    expandedParts.push("", errorColor(msg));
  }

  const pathInline = inline(path);
  const whyInline = inline(reason);

  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: errorColor },
    { text: " ", style: (s) => s },
    { text: "list", style: palette.muted },
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

export function renderGrepRunning(pattern: string, compact: boolean): ToolOutputComponent {
  const { palette } = theme;
  const runningColor = (s: string) => palette.taskRunning(s);

  const header = runningColor(bold(`grep ${pattern}`));

  const patternInline = inline(pattern);
  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: runningColor },
    { text: " ", style: (s) => s },
    { text: "grep", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: patternInline, style: palette.accent },
    { text: " ", style: (s) => s },
    { text: "(running)", style: palette.muted },
  ];

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor: runningColor, text: header },
    compactView: { segments, flexIndices: [5] },
  });
}

export function renderGrepFinished(
  pattern: string,
  status: "success" | "error",
  exitCode: number | null,
  stdoutPreview: string,
  stdoutPreviewTruncation: PreviewTruncation,
  stderrPreview: string,
  stderrPreviewTruncation: PreviewTruncation,
  captureTruncated: boolean,
  compact: boolean,
): ToolOutputComponent {
  const { palette } = theme;
  const grepColor = (s: string) => palette.toolFileRan(s);

  const expandedParts: string[] = [];
  expandedParts.push(grepColor(bold(`grep ${pattern}`)));

  const out = stdoutPreview.trimEnd();
  if (out) {
    expandedParts.push("", palette.filePreview(out));
  }

  const err = stderrPreview.trimEnd();
  if (err) {
    expandedParts.push("", palette.error("stderr:"), palette.error(err));
  }

  if (stdoutPreviewTruncation.truncated || stderrPreviewTruncation.truncated || captureTruncated) {
    const icon = palette.warn("◆");
    const msg = palette.dim(
      `truncated: ${stdoutPreviewTruncation.outputLines} of ${stdoutPreviewTruncation.totalLines} lines`,
    );
    expandedParts.push("", `${icon} ${msg}`);
  }

  if (exitCode !== null && exitCode !== 0 && exitCode !== 1) {
    expandedParts.push("", palette.warn(`(exit ${exitCode})`));
  }

  const patternInline = inline(pattern);

  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: grepColor },
    { text: " ", style: (s) => s },
    { text: "grep", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: patternInline, style: palette.accent },
    { text: " ", style: (s) => s },
    {
      text: status === "success" ? "(ok)" : "(error)",
      style: status === "success" ? palette.muted : palette.error,
    },
  ];

  const extra: string[] = [];
  if (err) {
    const errLines = err.split("\n").slice(0, 2);
    for (const l of errLines) {
      extra.push(palette.error(`    ${l}`));
    }
    if (stderrPreviewTruncation.truncated) {
      extra.push(palette.dim("    (stderr truncated)"));
    }
  } else if (out) {
    const outLines = out.split("\n").slice(0, 2);
    for (const l of outLines) {
      extra.push(palette.muted(`    ${l}`));
    }
    if (stdoutPreviewTruncation.truncated) {
      extra.push(palette.dim("    (output truncated)"));
    }
  }

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor: grepColor, text: expandedParts.join("\n") },
    compactView: {
      segments,
      flexIndices: [5],
      extraText: extra.length > 0 ? extra.join("\n") : undefined,
    },
  });
}

export function renderGrepBlocked(
  pattern: string,
  reason: string,
  compact: boolean,
): ToolOutputComponent {
  const { palette } = theme;
  const errorColor = (s: string) => palette.error(s);

  const expandedParts: string[] = [errorColor(bold(`grep ${pattern}`))];
  const msg = reason.trim();
  if (msg) {
    expandedParts.push("", errorColor(msg));
  }

  const patternInline = inline(pattern);
  const whyInline = inline(reason);

  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: errorColor },
    { text: " ", style: (s) => s },
    { text: "grep", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: patternInline, style: palette.accent },
    { text: " ", style: (s) => s },
    { text: `(blocked: ${whyInline})`, style: palette.muted },
  ];

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor: errorColor, text: expandedParts.join("\n") },
    compactView: { segments, flexIndices: [5, 7] },
  });
}
