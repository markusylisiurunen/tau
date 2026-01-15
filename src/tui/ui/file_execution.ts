import type { ToolUiText } from "../../core/tools/registry.js";
import type { Theme } from "./theme/index.js";
import {
  buildBlockedToolView,
  buildHeaderLine,
  inlineText,
  renderToolOutput,
  type ToolOutputViewModel,
} from "./tool_output.js";

export function buildWriteSuccessView(
  theme: Theme,
  path: string,
  uiText: ToolUiText,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const writeColor = (s: string) => palette.actionSuccess(s);
  const successBullet = (s: string) => palette.actionSuccess(s);

  const pathInline = inlineText(path);
  const header = buildHeaderLine({
    bulletStyle: successBullet,
    bullet: "✓",
    label: "wrote",
    labelStyle: palette.textMuted,
    accent: pathInline,
    accentStyle: palette.brandAccent,
  });

  const compactParts: string[] = [];
  if (uiText.previewText.trim()) {
    compactParts.push(palette.textDim(uiText.previewText));
  }
  if (uiText.statusLine?.trim()) {
    compactParts.push(palette.textMuted(uiText.statusLine));
  }
  const compactText = compactParts.length > 0 ? compactParts.join("\n") : undefined;
  const fullText = uiText.fullText.trim() ? palette.actionOutput(uiText.fullText) : undefined;

  return {
    borderColor: writeColor,
    expanded: {
      title: writeColor(text.bold(`write ${path}`)),
      sections: fullText ? [fullText] : [],
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
  return buildBlockedToolView({
    theme,
    label: "write blocked",
    title: `write ${path}`,
    accent: path,
    reason,
  });
}

export function buildEditSuccessView(
  theme: Theme,
  path: string,
  uiText: ToolUiText,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const editColor = (s: string) => palette.actionSuccess(s);
  const successBullet = (s: string) => palette.actionSuccess(s);

  const pathInline = inlineText(path);

  const header = buildHeaderLine({
    bulletStyle: successBullet,
    bullet: "✓",
    label: "edited",
    labelStyle: palette.textMuted,
    accent: pathInline,
    accentStyle: palette.brandAccent,
  });

  const compactParts: string[] = [];
  if (uiText.previewText.trim()) {
    compactParts.push(palette.textDim(uiText.previewText));
  }
  if (uiText.statusLine?.trim()) {
    compactParts.push(palette.textMuted(uiText.statusLine));
  }
  const compactText = compactParts.length > 0 ? compactParts.join("\n") : undefined;
  const fullText = uiText.fullText.trim() ? palette.actionOutput(uiText.fullText) : undefined;

  return {
    borderColor: editColor,
    expanded: {
      title: editColor(text.bold(`edit ${path}`)),
      sections: fullText ? [fullText] : [],
    },
    compact: {
      header,
      extraText: compactText,
    },
  };
}

export function buildEditBlockedView(
  theme: Theme,
  path: string,
  reason: string,
): ToolOutputViewModel {
  return buildBlockedToolView({
    theme,
    label: "edit blocked",
    title: `edit ${path}`,
    accent: path,
    reason,
  });
}

export function renderWriteSuccess(
  theme: Theme,
  path: string,
  uiText: ToolUiText,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildWriteSuccessView(theme, path, uiText), compact);
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
  uiText: ToolUiText,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildEditSuccessView(theme, path, uiText), compact);
}

export function renderEditBlocked(
  theme: Theme,
  path: string,
  reason: string,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildEditBlockedView(theme, path, reason), compact);
}
