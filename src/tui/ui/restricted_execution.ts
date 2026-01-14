import { inlineText } from "./inline.js";
import type { Theme } from "./theme.js";
import { buildBlockedToolView } from "./tool_output_helpers.js";
import {
  buildHeaderLine,
  buildSection,
  renderToolOutput,
  type ToolOutputViewModel,
} from "./tool_output_layout.js";
import { applyPreviewPolicy, buildCompactPreviewLines } from "./tool_output_preview.js";
import {
  GREP_UI_MAX_LINES,
  GREP_UI_MAX_TOKENS,
  READ_UI_MAX_LINES,
  READ_UI_MAX_TOKENS,
} from "./tool_truncation.js";

interface PreviewTruncation {
  truncated: boolean;
  totalLines: number;
  outputLines: number;
}

function formatRange(startLine: number, endLine?: number): string {
  if (endLine === undefined) {
    return `${startLine}-EOF`;
  }
  return `${startLine}-${endLine}`;
}

export function buildReadSuccessView(
  theme: Theme,
  path: string,
  startLine: number,
  endLine: number | undefined,
  content: string,
  modelTruncation: PreviewTruncation,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const readColor = (s: string) => palette.actionSuccess(s);
  const successBullet = (s: string) => palette.actionSuccess(s);

  const { truncation: previewTruncation, previewLines } = applyPreviewPolicy(content, {
    maxLines: READ_UI_MAX_LINES,
    maxTokens: READ_UI_MAX_TOKENS,
    strategy: "middle",
  });

  const out = previewTruncation.content.trimEnd();
  const expandedSections: Array<string | undefined> = [];
  if (out) {
    expandedSections.push(palette.actionOutput(out));
  }

  if (previewTruncation.truncated) {
    const icon = palette.statusWarn("◆");
    const msg = palette.textDim(
      `preview: ${previewTruncation.outputLines} of ${previewTruncation.totalLines} lines`,
    );
    expandedSections.push(`${icon} ${msg}`);
  }

  if (modelTruncation.truncated) {
    const icon = palette.statusWarn("◆");
    const msg = palette.statusWarn(
      `truncated for model: ${modelTruncation.outputLines} of ${modelTruncation.totalLines} lines`,
    );
    expandedSections.push(`${icon} ${msg}`);
  }

  const pathInline = inlineText(path);
  const totalLinesForSummary = modelTruncation.truncated
    ? modelTruncation.totalLines
    : previewTruncation.totalLines;
  const header = buildHeaderLine({
    bulletStyle: successBullet,
    bullet: "✓",
    label: "read",
    labelStyle: palette.textMuted,
    accent: pathInline,
    accentStyle: palette.brandAccent,
  });

  const compactLines = buildCompactPreviewLines(previewLines, {
    totalLines: totalLinesForSummary,
    maxLines: 16,
    lineStyle: palette.textDim,
    moreStyle: palette.textDim,
  });
  const infoText = `${totalLinesForSummary} lines · ${formatRange(startLine, endLine)}`;
  const summaryLine = `    ${palette.textMuted(`(${infoText})`)}`;
  const compactText = [compactLines, summaryLine].filter(Boolean).join("\n");

  return {
    borderColor: readColor,
    expanded: {
      title: readColor(text.bold(`read ${path} (${formatRange(startLine, endLine)})`)),
      sections: expandedSections,
    },
    compact: {
      header,
      extraText: compactText,
    },
  };
}

export function buildReadBlockedView(
  theme: Theme,
  path: string,
  reason: string,
): ToolOutputViewModel {
  return buildBlockedToolView({
    theme,
    label: "read blocked",
    title: `read ${path}`,
    accent: path,
    reason,
  });
}

export function buildListSuccessView(
  theme: Theme,
  path: string,
  offset: number,
  limit: number,
  total: number,
  returned: number,
  entries: string[],
): ToolOutputViewModel {
  const { palette, text } = theme;
  const listColor = (s: string) => palette.actionSuccess(s);
  const successBullet = (s: string) => palette.actionSuccess(s);

  const expandedSections: Array<string | undefined> = [];
  expandedSections.push(
    palette.textMuted(`${returned} of ${total} entries (offset ${offset}, limit ${limit})`),
  );

  if (entries.length > 0) {
    expandedSections.push(palette.actionOutput(entries.join("\n")));
  }

  const pathInline = inlineText(path);

  const header = buildHeaderLine({
    bulletStyle: successBullet,
    bullet: "✓",
    label: "listed",
    labelStyle: palette.textMuted,
    accent: pathInline,
    accentStyle: palette.brandAccent,
  });

  const compactLines = buildCompactPreviewLines(entries, {
    totalLines: entries.length,
    maxLines: 16,
    unitLabel: "entries",
    lineStyle: palette.textDim,
    moreStyle: palette.textDim,
  });
  const infoText = `${returned} of ${total} entries · offset ${offset} · limit ${limit}`;
  const summaryLine = `    ${palette.textMuted(`(${infoText})`)}`;
  const compactText = [compactLines, summaryLine].filter(Boolean).join("\n");

  return {
    borderColor: listColor,
    expanded: {
      title: listColor(text.bold(`list ${path}`)),
      sections: expandedSections,
    },
    compact: {
      header,
      extraText: compactText,
    },
  };
}

export function buildListBlockedView(
  theme: Theme,
  path: string,
  reason: string,
): ToolOutputViewModel {
  return buildBlockedToolView({
    theme,
    label: "list blocked",
    title: `list ${path}`,
    accent: path,
    reason,
  });
}

export function buildGrepRunningView(theme: Theme, pattern: string): ToolOutputViewModel {
  const { palette, text } = theme;
  const runningColor = (s: string) => palette.actionRunning(s);

  const patternInline = inlineText(pattern);
  const header = buildHeaderLine({
    bulletStyle: runningColor,
    label: "grep",
    labelStyle: palette.textMuted,
    accent: patternInline,
    accentStyle: palette.brandAccent,
    tailSegments: [
      { text: " ", style: (s) => s },
      { text: "(running)", style: palette.textMuted },
    ],
  });

  return {
    borderColor: runningColor,
    expanded: { title: runningColor(text.bold(`grep ${pattern}`)) },
    compact: { header },
  };
}

export function buildGrepFinishedView(
  theme: Theme,
  pattern: string,
  status: "success" | "error",
  exitCode: number | null,
  stdout: string,
  stderr: string,
  captureTruncated: boolean,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const grepColor = (s: string) => palette.actionSuccess(s);
  const errorColor = (s: string) => palette.actionError(s);
  const successBullet = (s: string) => palette.actionSuccess(s);
  const isSuccess = status === "success";
  const borderColor = isSuccess ? grepColor : errorColor;

  const { truncation: stdoutPreview, previewLines: stdoutLines } = applyPreviewPolicy(stdout, {
    maxLines: GREP_UI_MAX_LINES,
    maxTokens: GREP_UI_MAX_TOKENS,
    strategy: "middle",
  });

  const { truncation: stderrPreview, previewLines: stderrLines } = applyPreviewPolicy(stderr, {
    maxLines: GREP_UI_MAX_LINES,
    maxTokens: GREP_UI_MAX_TOKENS,
    strategy: "middle",
  });

  const out = stdoutPreview.content.trimEnd();
  const expandedSections: Array<string | undefined> = [];
  if (out) {
    expandedSections.push(palette.actionOutput(out));
  }

  const err = stderrPreview.content.trimEnd();
  if (err) {
    const errSection = buildSection([palette.actionError("stderr:"), palette.actionError(err)]);
    if (errSection) {
      expandedSections.push(errSection);
    }
  }

  if (stdoutPreview.truncated || stderrPreview.truncated || captureTruncated) {
    const icon = palette.statusWarn("◆");
    const msg = palette.textDim(
      `truncated: ${stdoutPreview.outputLines} of ${stdoutPreview.totalLines} lines`,
    );
    expandedSections.push(`${icon} ${msg}`);
  }

  if (exitCode !== null && exitCode !== 0 && exitCode !== 1) {
    expandedSections.push(palette.actionError(`(exit ${exitCode})`));
  }

  const patternInline = inlineText(pattern);

  const header = buildHeaderLine({
    bulletStyle: isSuccess ? successBullet : errorColor,
    bullet: isSuccess ? "✓" : undefined,
    label: "grep",
    labelStyle: palette.textMuted,
    accent: patternInline,
    accentStyle: palette.brandAccent,
  });

  const extraText = err
    ? buildCompactPreviewLines(stderrLines, {
        totalLines: stderrPreview.totalLines,
        maxLines: 16,
        lineStyle: palette.actionError,
        moreStyle: palette.actionError,
      })
    : out
      ? buildCompactPreviewLines(stdoutLines, {
          totalLines: stdoutPreview.totalLines,
          maxLines: 16,
          lineStyle: palette.textDim,
          moreStyle: palette.textDim,
        })
      : undefined;

  return {
    borderColor,
    expanded: {
      title: borderColor(text.bold(`grep ${pattern}`)),
      sections: expandedSections,
    },
    compact: {
      header,
      extraText,
    },
  };
}

export function buildGrepBlockedView(
  theme: Theme,
  pattern: string,
  reason: string,
): ToolOutputViewModel {
  return buildBlockedToolView({
    theme,
    label: "grep blocked",
    title: `grep ${pattern}`,
    accent: pattern,
    reason,
  });
}

export function renderReadSuccess(
  theme: Theme,
  path: string,
  startLine: number,
  endLine: number | undefined,
  content: string,
  modelTruncation: PreviewTruncation,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(
    buildReadSuccessView(theme, path, startLine, endLine, content, modelTruncation),
    compact,
  );
}

export function renderReadBlocked(
  theme: Theme,
  path: string,
  reason: string,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildReadBlockedView(theme, path, reason), compact);
}

export function renderListSuccess(
  theme: Theme,
  path: string,
  offset: number,
  limit: number,
  total: number,
  returned: number,
  entries: string[],
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(
    buildListSuccessView(theme, path, offset, limit, total, returned, entries),
    compact,
  );
}

export function renderListBlocked(
  theme: Theme,
  path: string,
  reason: string,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildListBlockedView(theme, path, reason), compact);
}

export function renderGrepRunning(
  theme: Theme,
  pattern: string,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildGrepRunningView(theme, pattern), compact);
}

export function renderGrepFinished(
  theme: Theme,
  pattern: string,
  status: "success" | "error",
  exitCode: number | null,
  stdout: string,
  stderr: string,
  captureTruncated: boolean,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(
    buildGrepFinishedView(theme, pattern, status, exitCode, stdout, stderr, captureTruncated),
    compact,
  );
}

export function renderGrepBlocked(
  theme: Theme,
  pattern: string,
  reason: string,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildGrepBlockedView(theme, pattern, reason), compact);
}
