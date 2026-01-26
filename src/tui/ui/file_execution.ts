import type { ToolUiText } from "../../core/tools/registry.js";
import type { Theme } from "./theme/index.js";
import {
  buildBlockedToolView,
  buildSection,
  buildToolHeaderLine,
  inlineText,
  renderToolOutput,
  renderToolUiCompactText,
  renderToolUiTextLines,
  type ToolOutputViewModel,
} from "./tool_output.js";

export function buildWriteSuccessView(
  theme: Theme,
  path: string,
  uiText: ToolUiText,
  headerTarget: string = path,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const writeColor = (s: string) => palette.actionSuccess(s);
  const successBullet = (s: string) => palette.actionSuccess(s);

  const pathInline = inlineText(headerTarget);
  const header = buildToolHeaderLine({
    bulletStyle: successBullet,
    bullet: "✓",
    label: "wrote",
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
  const fullText = renderToolUiTextLines({
    uiText,
    kind: "full",
    theme,
    baseStyle: palette.actionOutput,
  });

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
  headerTarget: string = path,
): ToolOutputViewModel {
  return buildBlockedToolView({
    theme,
    label: "write blocked",
    title: `write ${path}`,
    accent: headerTarget,
    reason,
  });
}

export function buildEditSuccessView(
  theme: Theme,
  path: string,
  uiText: ToolUiText,
  headerTarget: string = path,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const editColor = (s: string) => palette.actionSuccess(s);
  const successBullet = (s: string) => palette.actionSuccess(s);

  const pathInline = inlineText(headerTarget);

  const header = buildToolHeaderLine({
    bulletStyle: successBullet,
    bullet: "✓",
    label: "edited",
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
  const fullText = renderToolUiTextLines({
    uiText,
    kind: "full",
    theme,
    baseStyle: palette.actionOutput,
  });

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
  headerTarget: string = path,
): ToolOutputViewModel {
  return buildBlockedToolView({
    theme,
    label: "edit blocked",
    title: `edit ${path}`,
    accent: headerTarget,
    reason,
  });
}

export function buildViewImageSuccessView(
  theme: Theme,
  path: string,
  uiText: ToolUiText,
  headerTarget: string = path,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const viewColor = (s: string) => palette.actionSuccess(s);
  const successBullet = (s: string) => palette.actionSuccess(s);

  const pathInline = inlineText(headerTarget);
  const header = buildToolHeaderLine({
    bulletStyle: successBullet,
    bullet: "✓",
    label: "viewed",
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
  const fullText = renderToolUiTextLines({
    uiText,
    kind: "full",
    theme,
    baseStyle: palette.actionOutput,
  });

  return {
    borderColor: viewColor,
    expanded: {
      title: viewColor(text.bold(`view image ${path}`)),
      sections: fullText ? [fullText] : [],
    },
    compact: {
      header,
      extraText: compactText,
    },
  };
}

export function buildViewImageBlockedView(
  theme: Theme,
  path: string,
  reason: string,
  headerTarget: string = path,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const errorColor = (s: string) => palette.actionError(s);

  const msg = reason.trim();
  const sections = buildSection(msg ? [errorColor(msg)] : []);

  const accentInline = inlineText(headerTarget);
  const whyInline = inlineText(reason);

  const header = buildToolHeaderLine({
    bulletStyle: errorColor,
    bullet: "✗",
    label: "view image blocked",
    labelStyle: palette.textMuted,
    accent: accentInline,
    accentStyle: palette.brandAccent,
  });

  return {
    borderColor: errorColor,
    expanded: {
      title: errorColor(text.bold(`view image ${path}`)),
      sections: sections ? [sections] : [],
    },
    compact: {
      header,
      extraText: whyInline ? `    ${errorColor(whyInline)}` : undefined,
    },
  };
}

export function renderWriteSuccess(
  theme: Theme,
  path: string,
  uiText: ToolUiText,
  compact: boolean,
  headerTarget?: string,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildWriteSuccessView(theme, path, uiText, headerTarget), compact);
}

export function renderWriteBlocked(
  theme: Theme,
  path: string,
  reason: string,
  compact: boolean,
  headerTarget?: string,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildWriteBlockedView(theme, path, reason, headerTarget), compact);
}

export function renderEditSuccess(
  theme: Theme,
  path: string,
  uiText: ToolUiText,
  compact: boolean,
  headerTarget?: string,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildEditSuccessView(theme, path, uiText, headerTarget), compact);
}

export function renderEditBlocked(
  theme: Theme,
  path: string,
  reason: string,
  compact: boolean,
  headerTarget?: string,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildEditBlockedView(theme, path, reason, headerTarget), compact);
}

export function renderViewImageSuccess(
  theme: Theme,
  path: string,
  uiText: ToolUiText,
  compact: boolean,
  headerTarget?: string,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildViewImageSuccessView(theme, path, uiText, headerTarget), compact);
}

export function renderViewImageBlocked(
  theme: Theme,
  path: string,
  reason: string,
  compact: boolean,
  headerTarget?: string,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildViewImageBlockedView(theme, path, reason, headerTarget), compact);
}
