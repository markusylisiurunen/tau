import type { ToolUiText } from "../../core/tools/registry.js";
import type { Theme } from "./theme/index.js";
import {
  buildBlockedToolView,
  buildToolHeaderLine,
  inlineText,
  renderToolOutput,
  renderToolUiCompactText,
  renderToolUiTextLines,
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
  headerTarget: string,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const readColor = (s: string) => palette.actionSuccess(s);
  const successBullet = (s: string) => palette.actionSuccess(s);
  const expandedSections: Array<string | undefined> = [];
  const fullText = renderToolUiTextLines({
    uiText,
    kind: "full",
    theme,
    baseStyle: palette.actionOutput,
  });
  if (fullText) {
    expandedSections.push(fullText);
  }

  const pathInline = inlineText(headerTarget);
  const header = buildToolHeaderLine({
    bulletStyle: successBullet,
    bullet: "✓",
    label: "read",
    labelStyle: palette.textMuted,
    accent: pathInline,
    accentStyle: palette.brandAccent,
  });
  const compactText = renderToolUiCompactText({
    uiText,
    theme,
    previewStyle: palette.textDim,
    statusStyle: palette.textMuted,
  });

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
  headerTarget: string,
): ToolOutputViewModel {
  return buildBlockedToolView({
    theme,
    label: "read blocked",
    title: `read ${path}`,
    accent: headerTarget,
    reason,
  });
}

export function buildListSuccessView(
  theme: Theme,
  path: string,
  uiText: ToolUiText,
  headerTarget: string,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const listColor = (s: string) => palette.actionSuccess(s);
  const successBullet = (s: string) => palette.actionSuccess(s);

  const expandedSections: Array<string | undefined> = [];
  const fullText = renderToolUiTextLines({
    uiText,
    kind: "full",
    theme,
    baseStyle: palette.actionOutput,
  });
  if (fullText) {
    expandedSections.push(fullText);
  }

  const pathInline = inlineText(headerTarget);

  const header = buildToolHeaderLine({
    bulletStyle: successBullet,
    bullet: "✓",
    label: "listed",
    labelStyle: palette.textMuted,
    accent: pathInline,
    accentStyle: palette.brandAccent,
  });

  const compactText = renderToolUiCompactText({
    uiText,
    theme,
    previewStyle: palette.textDim,
    statusStyle: palette.textMuted,
  });

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
  headerTarget: string,
): ToolOutputViewModel {
  return buildBlockedToolView({
    theme,
    label: "list blocked",
    title: `list ${path}`,
    accent: headerTarget,
    reason,
  });
}

export function buildGrepRunningView(
  theme: Theme,
  pattern: string,
  headerTarget: string,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const runningColor = (s: string) => palette.actionRunning(s);

  const patternInline = inlineText(headerTarget);
  const header = buildToolHeaderLine({
    bulletStyle: runningColor,
    bullet: "⏵",
    label: "grep (running)",
    labelStyle: palette.textMuted,
    accent: patternInline,
    accentStyle: palette.brandAccent,
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
  headerTarget: string,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const grepColor = (s: string) => palette.actionSuccess(s);
  const errorColor = (s: string) => palette.actionError(s);
  const successBullet = (s: string) => palette.actionSuccess(s);
  const isSuccess = status === "success";
  const borderColor = isSuccess ? grepColor : errorColor;
  const expandedSections: Array<string | undefined> = [];
  const fullStyle = isSuccess ? palette.actionOutput : palette.actionError;
  const fullText = renderToolUiTextLines({
    uiText,
    kind: "full",
    theme,
    baseStyle: fullStyle,
  });
  if (fullText) {
    expandedSections.push(fullText);
  }

  const patternInline = inlineText(headerTarget);

  const header = buildToolHeaderLine({
    bulletStyle: isSuccess ? successBullet : errorColor,
    bullet: isSuccess ? "✓" : "✗",
    label: "grep",
    labelStyle: palette.textMuted,
    accent: patternInline,
    accentStyle: palette.brandAccent,
  });
  const previewStyle = isSuccess ? palette.textDim : palette.actionError;
  const statusStyle = isSuccess ? palette.textMuted : palette.actionError;
  const extraText = renderToolUiCompactText({
    uiText,
    theme,
    previewStyle,
    statusStyle,
  });

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
  headerTarget: string,
): ToolOutputViewModel {
  return buildBlockedToolView({
    theme,
    label: "grep blocked",
    title: `grep ${pattern}`,
    accent: headerTarget,
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
  headerTarget: string,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(
    buildReadSuccessView(theme, path, startLine, endLine, uiText, headerTarget),
    compact,
  );
}

export function renderReadBlocked(
  theme: Theme,
  path: string,
  reason: string,
  compact: boolean,
  headerTarget: string,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildReadBlockedView(theme, path, reason, headerTarget), compact);
}

export function renderListSuccess(
  theme: Theme,
  path: string,
  uiText: ToolUiText,
  compact: boolean,
  headerTarget: string,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildListSuccessView(theme, path, uiText, headerTarget), compact);
}

export function renderListBlocked(
  theme: Theme,
  path: string,
  reason: string,
  compact: boolean,
  headerTarget: string,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildListBlockedView(theme, path, reason, headerTarget), compact);
}

export function renderGrepRunning(
  theme: Theme,
  pattern: string,
  compact: boolean,
  headerTarget: string,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildGrepRunningView(theme, pattern, headerTarget), compact);
}

export function renderGrepFinished(
  theme: Theme,
  pattern: string,
  status: "success" | "error",
  uiText: ToolUiText,
  compact: boolean,
  headerTarget: string,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(
    buildGrepFinishedView(theme, pattern, status, uiText, headerTarget),
    compact,
  );
}

export function renderGrepBlocked(
  theme: Theme,
  pattern: string,
  reason: string,
  compact: boolean,
  headerTarget: string,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildGrepBlockedView(theme, pattern, reason, headerTarget), compact);
}
