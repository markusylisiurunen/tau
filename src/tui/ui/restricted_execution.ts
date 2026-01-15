import type { ToolUiText } from "../../core/tools/registry.js";
import type { Theme } from "./theme/index.js";
import {
  buildBlockedToolView,
  buildHeaderLine,
  inlineText,
  renderToolOutput,
  type ToolOutputViewModel,
} from "./tool_output.js";

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
  uiText: ToolUiText,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const readColor = (s: string) => palette.actionSuccess(s);
  const successBullet = (s: string) => palette.actionSuccess(s);
  const expandedSections: Array<string | undefined> = [];
  if (uiText.fullText.trim()) {
    expandedSections.push(palette.actionOutput(uiText.fullText));
  }

  const pathInline = inlineText(path);
  const header = buildHeaderLine({
    bulletStyle: successBullet,
    bullet: "✓",
    label: "read",
    labelStyle: palette.textMuted,
    accent: pathInline,
    accentStyle: palette.brandAccent,
  });
  const compactText = uiText.previewText ? palette.textDim(uiText.previewText) : undefined;

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
  uiText: ToolUiText,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const listColor = (s: string) => palette.actionSuccess(s);
  const successBullet = (s: string) => palette.actionSuccess(s);

  const expandedSections: Array<string | undefined> = [];
  if (uiText.fullText.trim()) {
    expandedSections.push(palette.actionOutput(uiText.fullText));
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

  const compactText = uiText.previewText ? palette.textDim(uiText.previewText) : undefined;

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
  uiText: ToolUiText,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const grepColor = (s: string) => palette.actionSuccess(s);
  const errorColor = (s: string) => palette.actionError(s);
  const successBullet = (s: string) => palette.actionSuccess(s);
  const isSuccess = status === "success";
  const borderColor = isSuccess ? grepColor : errorColor;
  const expandedSections: Array<string | undefined> = [];
  if (uiText.fullText.trim()) {
    const fullStyle = isSuccess ? palette.actionOutput : palette.actionError;
    expandedSections.push(fullStyle(uiText.fullText));
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
  const previewStyle = isSuccess ? palette.textDim : palette.actionError;
  const extraText = uiText.previewText ? previewStyle(uiText.previewText) : undefined;

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
  uiText: ToolUiText,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildReadSuccessView(theme, path, startLine, endLine, uiText), compact);
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
  uiText: ToolUiText,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildListSuccessView(theme, path, uiText), compact);
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
  uiText: ToolUiText,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildGrepFinishedView(theme, pattern, status, uiText), compact);
}

export function renderGrepBlocked(
  theme: Theme,
  pattern: string,
  reason: string,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildGrepBlockedView(theme, pattern, reason), compact);
}
