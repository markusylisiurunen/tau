import { inlineText } from "./inline.js";
import type { Theme } from "./theme.js";
import { buildHeaderLine, buildSection, type ToolOutputViewModel } from "./tool_output_layout.js";

export function buildBlockedToolView(args: {
  theme: Theme;
  label: string;
  title: string;
  accent: string;
  reason: string;
}): ToolOutputViewModel {
  const { theme, label, title, accent, reason } = args;
  const { palette, text } = theme;
  const errorColor = (s: string) => palette.actionError(s);

  const msg = reason.trim();
  const section = buildSection(msg ? [errorColor(msg)] : []);

  const accentInline = inlineText(accent);
  const whyInline = inlineText(reason);

  const header = buildHeaderLine({
    bulletStyle: errorColor,
    label,
    labelStyle: palette.textMuted,
    accent: accentInline,
    accentStyle: palette.brandAccent,
  });

  return {
    borderColor: errorColor,
    expanded: {
      title: errorColor(text.bold(title)),
      sections: section ? [section] : [],
    },
    compact: {
      header,
      extraText: whyInline ? `    ${errorColor(whyInline)}` : undefined,
    },
  };
}
