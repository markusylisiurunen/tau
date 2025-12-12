import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@mariozechner/pi-tui";
import { Chalk } from "chalk";

const chalk = new Chalk({ level: 3 });

export interface Palette {
  accent: (text: string) => string;
  muted: (text: string) => string;
  dim: (text: string) => string;
  link: (text: string) => string;
  codeInline: (text: string) => string;
  success: (text: string) => string;
  warn: (text: string) => string;
  error: (text: string) => string;
  bash: (text: string) => string;
  userBg: (text: string) => string;
  userText: (text: string) => string;
  assistantLabel: (text: string) => string;
  systemLabel: (text: string) => string;
  border: (text: string) => string;
}

export interface Theme {
  palette: Palette;
  markdownTheme: MarkdownTheme;
  editorTheme: EditorTheme;
  formatPersonaLabel(label: string, modelId: string): string;
}

const palette: Palette = {
  // Warm, calm palette tuned for dark terminals.
  // Primary
  accent: chalk.hex("#d4a06a"), // sand / amber
  muted: chalk.hex("#a79f97"), // warm stone gray
  dim: chalk.dim,
  link: chalk.hex("#92a6b3"), // dusty slate-blue
  codeInline: chalk.hex("#d8b27a"), // soft honey

  // Semantics (kept low-saturation / warm)
  success: chalk.hex("#9ab58d"), // muted sage
  warn: chalk.hex("#dcb076"), // soft gold
  error: chalk.hex("#d08a7c"), // soft clay
  bash: chalk.hex("#86afa9"), // desaturated teal for bash mode

  // Surfaces & chrome
  userBg: chalk.bgHex("#201a18"), // deep warm charcoal
  userText: chalk.hex("#e8dfd4"), // warm parchment
  assistantLabel: chalk.hex("#9ab58d"),
  systemLabel: chalk.hex("#c4b2a3"), // subtle warm beige
  border: chalk.hex("#3f3935"), // low-contrast warm border
};

const markdownTheme: MarkdownTheme = {
  heading: (text) => chalk.bold(palette.accent(text)),
  link: (text) => palette.link(text),
  linkUrl: (text) => palette.dim(text),
  code: (text) => palette.codeInline(text),
  codeBlock: (text) => palette.success(text),
  codeBlockBorder: (text) => palette.muted(text),
  quote: (text) => chalk.italic(palette.muted(text)),
  quoteBorder: (text) => palette.muted(text),
  hr: (text) => palette.muted(text),
  listBullet: (text) => palette.accent(text),
  bold: (text) => chalk.bold(text),
  italic: (text) => chalk.italic(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
};

const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => palette.accent(text),
  selectedText: (text) => chalk.bold(palette.accent(text)),
  description: (text) => palette.muted(text),
  scrollInfo: (text) => palette.muted(text),
  noMatch: (text) => palette.muted(text),
};

const editorTheme: EditorTheme = {
  borderColor: (text) => palette.border(text),
  selectList: selectListTheme,
};

export const theme: Theme = {
  palette,
  markdownTheme,
  editorTheme,
  formatPersonaLabel: (label: string, modelId: string) =>
    `${palette.accent(label)} ${palette.muted(`(${modelId})`)}`,
};

export function editorBorderForReasoning(reasoning?: string): (text: string) => string {
  // Make this clearly noticeable. We ramp both lightness and saturation with effort,
  // ending near the heading accent color (#d4a06a) at xhigh.
  switch (reasoning) {
    case "minimal":
      return chalk.hex("#6f6259");
    case "low":
      return chalk.hex("#8a7260");
    case "medium":
      return chalk.hex("#a98064");
    case "high":
      return chalk.hex("#c19268");
    case "xhigh":
      return chalk.hex("#d0a06a");
    default:
      return palette.border;
  }
}

// Backwards-compatible named exports (avoid churn in future refactors).
export { palette, markdownTheme, editorTheme };
