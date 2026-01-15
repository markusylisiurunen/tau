import type { ToolUiText } from "../../core/tools/registry.js";
import type { Theme } from "./theme/index.js";
import {
  buildHeaderLine,
  buildSection,
  inlineText,
  renderToolOutput,
  type ToolOutputViewModel,
} from "./tool_output.js";

export function buildBashRunningView(theme: Theme, command: string): ToolOutputViewModel {
  const { palette, text } = theme;
  const runningColor = (s: string) => palette.actionRunning(s);

  const commandInline = inlineText(command);
  const header = buildHeaderLine({
    bulletStyle: runningColor,
    label: "running",
    labelStyle: palette.textMuted,
    accent: commandInline,
    accentStyle: palette.brandAccent,
    wrapIndex: 5,
  });

  return {
    borderColor: runningColor,
    expanded: { title: runningColor(text.bold(`$ ${command}`)) },
    compact: { header },
  };
}

export function buildBashExecutionView(
  theme: Theme,
  command: string,
  exitCode: number | null,
  uiText: ToolUiText,
  labelOverride?: string,
): ToolOutputViewModel {
  const { palette } = theme;
  const successColor = (s: string) => palette.actionSuccess(s);
  const errorColor = (s: string) => palette.actionError(s);
  const successBullet = (s: string) => palette.actionSuccess(s);
  const isSuccess = exitCode === 0;
  const resultColor = isSuccess ? successColor : errorColor;

  const commandInline = inlineText(command);

  const header = buildHeaderLine({
    bulletStyle: isSuccess ? successBullet : errorColor,
    bullet: isSuccess ? "✓" : undefined,
    label: labelOverride ?? "ran",
    labelStyle: palette.textMuted,
    accent: commandInline,
    accentStyle: palette.brandAccent,
    wrapIndex: 5,
  });

  const previewStyle = isSuccess ? palette.textDim : palette.actionError;
  const compactText = uiText.previewText ? previewStyle(uiText.previewText) : undefined;
  const fullStyle = isSuccess ? palette.actionOutput : palette.actionError;
  const fullText = uiText.fullText.trim() ? fullStyle(uiText.fullText) : undefined;
  const sections = fullText ? [fullText] : [];
  return {
    borderColor: resultColor,
    expanded: {
      title: resultColor(theme.text.bold(`$ ${command}`)),
      sections,
    },
    compact: {
      header,
      extraText: compactText,
    },
  };
}

export function buildBashBlockedView(
  theme: Theme,
  command: string,
  reason: string,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const errorColor = (s: string) => palette.actionError(s);

  const msg = reason.trim();
  const sections = buildSection(msg ? [errorColor(msg)] : []);

  const commandInline = inlineText(command);
  const why = inlineText(reason);

  const header = buildHeaderLine({
    bulletStyle: errorColor,
    label: "bash blocked",
    labelStyle: palette.textMuted,
    accent: commandInline,
    accentStyle: palette.brandAccent,
    wrapIndex: 5,
  });

  return {
    borderColor: errorColor,
    expanded: {
      title: errorColor(text.bold(`$ ${command}`)),
      sections: sections ? [sections] : [],
    },
    compact: {
      header,
      extraText: why ? `    ${errorColor(why)}` : undefined,
    },
  };
}

export function buildBashAbortedView(
  theme: Theme,
  command: string,
  reason: string,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const warnColor = (s: string) => palette.statusWarn(s);

  const msg = reason.trim();
  const sections = buildSection(msg ? [warnColor(msg)] : []);

  const commandInline = inlineText(command);
  const why = inlineText(reason);

  const details = why ? palette.textMuted(`(${why})`) : undefined;

  const header = buildHeaderLine({
    bulletStyle: warnColor,
    label: inlineText(reason) || "aborted",
    labelStyle: palette.textMuted,
    accent: commandInline,
    accentStyle: palette.brandAccent,
    wrapIndex: 5,
  });

  return {
    borderColor: warnColor,
    expanded: {
      title: warnColor(text.bold(`$ ${command}`)),
      sections: sections ? [sections] : [],
    },
    compact: {
      header,
      extraText: details ? `    ${details}` : undefined,
    },
  };
}

export function renderBashRunning(
  theme: Theme,
  command: string,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildBashRunningView(theme, command), compact);
}

export function renderBashExecution(
  theme: Theme,
  command: string,
  exitCode: number | null,
  uiText: ToolUiText,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildBashExecutionView(theme, command, exitCode, uiText), compact);
}

export function renderBashBlocked(
  theme: Theme,
  command: string,
  reason: string,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildBashBlockedView(theme, command, reason), compact);
}

export function renderBashAborted(
  theme: Theme,
  command: string,
  reason: string,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildBashAbortedView(theme, command, reason), compact);
}
