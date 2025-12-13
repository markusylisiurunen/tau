import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@mariozechner/pi-tui";
import { Chalk } from "chalk";

const chalk = new Chalk({ level: 3 });

export interface Palette {
  // Primary colors
  accent: (text: string) => string;
  muted: (text: string) => string;
  dim: (text: string) => string;
  link: (text: string) => string;
  codeInline: (text: string) => string;
  codeBlock: (text: string) => string;

  // Semantic colors
  success: (text: string) => string;
  warn: (text: string) => string;
  error: (text: string) => string;
  bash: (text: string) => string;
  bashRunning: (text: string) => string;
  bashOutput: (text: string) => string;

  // Diff colors
  diffAdded: (text: string) => string;
  diffRemoved: (text: string) => string;

  // Notices (short system acknowledgements)
  noticeSuccess: (text: string) => string;

  // Surfaces & chrome
  userBg: (text: string) => string;
  userText: (text: string) => string;
  assistantLabel: (text: string) => string;
  systemLabel: (text: string) => string;
  border: (text: string) => string;

  // Tool access level indicators
  accessRead: (text: string) => string;
  accessAll: (text: string) => string;
}

export interface Theme {
  palette: Palette;
  markdownTheme: MarkdownTheme;
  editorTheme: EditorTheme;
  formatPersonaLabel(label: string, modelId: string): string;
}

const palette: Palette = {
  // Primary colors
  accent: chalk.hex("#d4a06a"), // sand / amber
  muted: chalk.hex("#a79f97"), // warm stone gray
  dim: chalk.dim, // built-in dim
  link: chalk.hex("#92a6b3"), // dusty slate-blue
  codeInline: chalk.hex("#d8b27a"), // soft honey
  codeBlock: chalk.hex("#9ab58d"), // muted sage (distinct from success semantics)

  // Semantic colors (kept low-saturation / warm)
  success: chalk.hex("#9ab58d"), // muted sage
  warn: chalk.hex("#dcb076"), // soft gold
  error: chalk.hex("#d08a7c"), // soft clay
  bash: chalk.hex("#86afa9"), // desaturated teal
  bashRunning: chalk.hex("#d4c87a"), // brighter yellow-gold (running state, distinct from success)
  bashOutput: chalk.hex("#9a928a"), // warm gray for bash stdout/stderr (dim, but distinct from prose)

  // Diff colors
  diffAdded: chalk.hex("#8fad83"), // desaturated green
  diffRemoved: chalk.hex("#c08877"), // desaturated red

  // Notices (short system acknowledgements)
  noticeSuccess: chalk.hex("#9ab58d"), // muted sage (positive acknowledgement, not diff semantics)

  // Surfaces & chrome
  userBg: chalk.bgHex("#1a1615"), // deep warm charcoal
  userText: chalk.hex("#e8dfd4"), // warm parchment
  assistantLabel: chalk.hex("#9ab58d"), // same as success (assistant = good)
  systemLabel: chalk.hex("#c4b2a3"), // subtle warm beige
  border: chalk.hex("#3f3935"), // low-contrast warm border

  // Tool access level indicators (distinct from success/warn/error semantics)
  accessRead: chalk.hex("#8ad199"),
  accessAll: chalk.hex("#ffc9b0"),
};

const markdownTheme: MarkdownTheme = {
  heading: (text) => chalk.bold(palette.accent(text)),
  link: (text) => palette.link(text),
  linkUrl: (text) => palette.dim(text),
  code: (text) => palette.codeInline(text),
  codeBlock: (text) => palette.codeBlock(text),
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
  // Ramps both lightness and saturation with effort, ending near the heading
  // accent color (#d4a06a) at xhigh.
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

export { editorTheme, markdownTheme, palette };
