import type { ToolUiText } from "../../core/tools/registry.js";
import type { Theme } from "./theme/index.js";
import {
  buildBlockedToolView,
  buildHeaderLine,
  buildSection,
  inlineText,
  renderToolOutput,
  renderToolUiTextLines,
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
    wrapIndex: 5,
  });

  const compactParts: string[] = [];
  const previewText = renderToolUiTextLines({
    uiText,
    kind: "preview",
    theme,
    baseStyle: palette.textDim,
  });
  if (previewText) {
    compactParts.push(previewText);
  }
  if (uiText.statusLine?.trim()) {
    compactParts.push(palette.textMuted(uiText.statusLine));
  }
  const compactText = compactParts.length > 0 ? compactParts.join("\n") : undefined;
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
    wrapIndex: 5,
  });

  const compactParts: string[] = [];
  const previewText = renderToolUiTextLines({
    uiText,
    kind: "preview",
    theme,
    baseStyle: palette.textDim,
  });
  if (previewText) {
    compactParts.push(previewText);
  }
  if (uiText.statusLine?.trim()) {
    compactParts.push(palette.textMuted(uiText.statusLine));
  }
  const compactText = compactParts.length > 0 ? compactParts.join("\n") : undefined;
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
): ToolOutputViewModel {
  return buildBlockedToolView({
    theme,
    label: "edit blocked",
    title: `edit ${path}`,
    accent: path,
    reason,
  });
}

export function buildViewImageSuccessView(
  theme: Theme,
  path: string,
  uiText: ToolUiText,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const viewColor = (s: string) => palette.actionSuccess(s);
  const successBullet = (s: string) => palette.actionSuccess(s);

  const pathInline = inlineText(path);
  const header = buildHeaderLine({
    bulletStyle: successBullet,
    bullet: "✓",
    label: "viewed",
    labelStyle: palette.textMuted,
    accent: pathInline,
    accentStyle: palette.brandAccent,
    wrapIndex: 5,
  });

  const indentLine = (text: string) => `    ${text}`;
  const indentedUiText: ToolUiText = {
    ...uiText,
    previewLines: uiText.previewLines.map((line) => ({
      ...line,
      text: indentLine(line.text),
    })),
    statusLine: uiText.statusLine ? indentLine(uiText.statusLine) : undefined,
  };

  const compactParts: string[] = [];
  const previewText = renderToolUiTextLines({
    uiText: indentedUiText,
    kind: "preview",
    theme,
    baseStyle: palette.textDim,
  });
  if (previewText) {
    compactParts.push(previewText);
  }
  if (indentedUiText.statusLine?.trim()) {
    compactParts.push(palette.textMuted(indentedUiText.statusLine));
  }
  const compactText = compactParts.length > 0 ? compactParts.join("\n") : undefined;
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
): ToolOutputViewModel {
  const { palette, text } = theme;
  const errorColor = (s: string) => palette.actionError(s);

  const msg = reason.trim();
  const sections = buildSection(msg ? [errorColor(msg)] : []);

  const accentInline = inlineText(path);
  const whyInline = inlineText(reason);

  const header = buildHeaderLine({
    bulletStyle: errorColor,
    bullet: "✗",
    label: "view image blocked",
    labelStyle: palette.textMuted,
    accent: accentInline,
    accentStyle: palette.brandAccent,
    wrapIndex: 5,
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

export function renderViewImageSuccess(
  theme: Theme,
  path: string,
  uiText: ToolUiText,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildViewImageSuccessView(theme, path, uiText), compact);
}

export function renderViewImageBlocked(
  theme: Theme,
  path: string,
  reason: string,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildViewImageBlockedView(theme, path, reason), compact);
}
