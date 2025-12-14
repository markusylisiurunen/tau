import type { ReasoningEffort } from "@mariozechner/pi-ai";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@mariozechner/pi-tui";
import { Chalk } from "chalk";
import { hslToHex } from "../utils/color.js";
import { assertNever } from "../utils/never.js";

const chalk = new Chalk({ level: 3 });

export interface Palette {
  // Primary colors
  accent: (text: string) => string;
  muted: (text: string) => string;
  dim: (text: string) => string;
  link: (text: string) => string;
  thinking: (text: string) => string;
  codeInline: (text: string) => string;
  codeBlock: (text: string) => string;

  // Semantic colors
  warn: (text: string) => string;
  error: (text: string) => string;
  bashRunning: (text: string) => string;
  bashRan: (text: string) => string;
  bashOutput: (text: string) => string;
  toolFileRan: (text: string) => string;
  filePreview: (text: string) => string;
  taskRunning: (text: string) => string;
  taskRan: (text: string) => string;
  taskPreview: (text: string) => string;

  // Diff colors
  diffAdded: (text: string) => string;
  diffRemoved: (text: string) => string;

  // Notices
  noticeSuccess: (text: string) => string;
  noticeWarn: (text: string) => string;
  noticeError: (text: string) => string;

  // User message
  userBg: (text: string) => string;
  userText: (text: string) => string;

  // Risk level indicators
  riskNone: (text: string) => string;
  riskReadOnly: (text: string) => string;
  riskReadWrite: (text: string) => string;
}

export interface Theme {
  palette: Palette;
  markdownTheme: MarkdownTheme;
  editorTheme: EditorTheme;
}

const ACCENT_HUE = 28;
const TEXT_HUE = 24;
const LINK_HUE = 328;
const CODE_HUE = 224;
const WARN_HUE = 24;
const ERROR_HUE = 0;

const palette: Palette = {
  // Primary colors
  accent: chalk.hex(hslToHex(ACCENT_HUE, 92, 72)),
  muted: chalk.hex(hslToHex(TEXT_HUE, 8, 56)),
  dim: chalk.hex(hslToHex(TEXT_HUE, 6, 42)),
  link: chalk.hex(hslToHex(LINK_HUE, 84, 72)),
  thinking: chalk.hex(hslToHex(TEXT_HUE, 8, 56)),
  codeInline: chalk.hex(hslToHex(CODE_HUE, 64, 74)),
  codeBlock: chalk.hex(hslToHex(CODE_HUE, 64, 74)),

  // Semantic colors
  warn: chalk.hex(hslToHex(WARN_HUE, 76, 68)),
  error: chalk.hex(hslToHex(ERROR_HUE, 76, 68)),
  bashRunning: chalk.hex(hslToHex(168, 80, 72)),
  bashRan: chalk.hex(hslToHex(192, 80, 72)),
  bashOutput: chalk.hex(hslToHex(TEXT_HUE, 8, 56)),
  toolFileRan: chalk.hex(hslToHex(192, 80, 72)),
  filePreview: chalk.hex(hslToHex(TEXT_HUE, 8, 56)),
  taskRunning: chalk.hex(hslToHex(168, 80, 72)),
  taskRan: chalk.hex(hslToHex(192, 80, 72)),
  taskPreview: chalk.hex(hslToHex(TEXT_HUE, 8, 56)),

  // Diff colors
  diffAdded: chalk.hex(hslToHex(72, 40, 46)),
  diffRemoved: chalk.hex(hslToHex(6, 44, 52)),

  // Notices
  noticeSuccess: chalk.hex(hslToHex(CODE_HUE, 64, 74)),
  noticeWarn: chalk.hex(hslToHex(WARN_HUE, 76, 68)),
  noticeError: chalk.hex(hslToHex(ERROR_HUE, 76, 68)),

  // User message
  userBg: chalk.bgHex(hslToHex(TEXT_HUE, 6, 12)),
  userText: (text) => text,

  // Risk level indicators
  riskNone: chalk.hex(hslToHex(TEXT_HUE, 6, 42)),
  riskReadOnly: chalk.hex(hslToHex(72, 16, 44)),
  riskReadWrite: chalk.hex(hslToHex(8, 20, 56)),
};

const markdownTheme: MarkdownTheme = {
  bold: (text) => chalk.bold(text),
  code: (text) => palette.codeInline(text),
  codeBlock: (text) => palette.codeBlock(text),
  codeBlockBorder: (text) => palette.dim(text),
  heading: (text) => chalk.bold(palette.accent(text)),
  hr: (text) => palette.dim(text),
  italic: (text) => chalk.italic(text),
  link: (text) => palette.link(text),
  linkUrl: (text) => palette.dim(text),
  listBullet: (text) => palette.accent(text),
  quote: (text) => chalk.italic(palette.muted(text)),
  quoteBorder: (text) => palette.dim(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
};

const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => chalk.bold(palette.accent(text)),
  selectedText: (text) => chalk.bold(palette.accent(text)),
  description: (text) => palette.muted(text),
  scrollInfo: (text) => palette.dim(text),
  noMatch: (text) => palette.muted(text),
};

const editorTheme: EditorTheme = {
  borderColor: (text) => editorBorderForReasoning("none")(text),
  selectList: selectListTheme,
};

export const theme: Theme = {
  palette: palette,
  markdownTheme: markdownTheme,
  editorTheme: editorTheme,
};

export function editorBorderForReasoning(effort?: ReasoningEffort): (text: string) => string {
  const [MIN_H, MAX_H] = [20, 28];
  const [MIN_S, MAX_S] = [8, 76];
  const [MIN_L, MAX_L] = [24, 52];
  const [RANGE_H, RANGE_S, RANGE_L] = [MAX_H - MIN_H, MAX_S - MIN_S, MAX_L - MIN_L];
  const h = (x: number) => MIN_H + RANGE_H * x;
  const s = (x: number) => MIN_S + RANGE_S * x;
  const l = (x: number) => MIN_L + RANGE_L * x;
  switch (effort) {
    case undefined:
    case "none":
      return chalk.hex(hslToHex(h(0), s(0), l(0)));
    case "minimal":
      return chalk.hex(hslToHex(h(0.2), s(0.2), l(0.2)));
    case "low":
      return chalk.hex(hslToHex(h(0.4), s(0.4), l(0.4)));
    case "medium":
      return chalk.hex(hslToHex(h(0.6), s(0.6), l(0.6)));
    case "high":
      return chalk.hex(hslToHex(h(0.8), s(0.8), l(0.8)));
    case "xhigh":
      return chalk.hex(hslToHex(h(1), s(1), l(1)));
    default:
      assertNever(effort);
  }
}

export { editorTheme, markdownTheme, palette };
