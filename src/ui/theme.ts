import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@mariozechner/pi-tui";
import { Chalk } from "chalk";
import type { ReasoningEffort } from "../types.js";
import { hslToHex } from "../utils/color.js";
import { assertNever } from "../utils/never.js";

const chalk = new Chalk({ level: 3 });

export type ThemeMode = "ansi" | "plain" | "tags";

export interface TextStyles {
  bold: (text: string) => string;
  italic: (text: string) => string;
  underline: (text: string) => string;
  strikethrough: (text: string) => string;
}

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
  memoryMode: (text: string) => string;
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
  noticeSuccessBg: (text: string) => string;
  noticeWarnBg: (text: string) => string;
  noticeErrorBg: (text: string) => string;
  noticeMutedBg: (text: string) => string;

  // User message
  userBg: (text: string) => string;
  userText: (text: string) => string;
  userMemoryBg: (text: string) => string;
  userMemoryText: (text: string) => string;

  // Risk level indicators
  riskRestricted: (text: string) => string;
  riskReadOnly: (text: string) => string;
  riskReadWrite: (text: string) => string;
}

export interface Theme {
  mode: ThemeMode;
  palette: Palette;
  markdownTheme: MarkdownTheme;
  editorTheme: EditorTheme;
  text: TextStyles;
  editorBorderForReasoning: (effort?: ReasoningEffort) => (text: string) => string;
}

const ACCENT_HUE = 28;
const TEXT_HUE = 24;
const LINK_HUE = 328;
const CODE_HUE = 224;
const WARN_HUE = 24;
const ERROR_HUE = 0;

function tagWrapper(label: string): (text: string) => string {
  return (text) => `<${label}>${text}</${label}>`;
}

function plainWrapper(): (text: string) => string {
  return (text) => text;
}

function createTextStyles(mode: ThemeMode): TextStyles {
  if (mode === "ansi") {
    return {
      bold: (text) => chalk.bold(text),
      italic: (text) => chalk.italic(text),
      underline: (text) => chalk.underline(text),
      strikethrough: (text) => chalk.strikethrough(text),
    };
  }

  const wrap = (label: string) => (mode === "tags" ? tagWrapper(label) : plainWrapper());
  return {
    bold: wrap("bold"),
    italic: wrap("italic"),
    underline: wrap("underline"),
    strikethrough: wrap("strikethrough"),
  };
}

function createPalette(mode: ThemeMode): Palette {
  if (mode === "ansi") {
    return {
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
      memoryMode: chalk.hex(hslToHex(280, 80, 72)),
      bashRunning: chalk.hex(hslToHex(48, 80, 72)),
      bashRan: chalk.hex(hslToHex(192, 80, 72)),
      bashOutput: chalk.hex(hslToHex(TEXT_HUE, 8, 56)),
      toolFileRan: chalk.hex(hslToHex(192, 80, 72)),
      filePreview: chalk.hex(hslToHex(TEXT_HUE, 8, 56)),
      taskRunning: chalk.hex(hslToHex(48, 80, 72)),
      taskRan: chalk.hex(hslToHex(192, 80, 72)),
      taskPreview: chalk.hex(hslToHex(TEXT_HUE, 8, 56)),

      // Diff colors
      diffAdded: chalk.hex(hslToHex(72, 40, 46)),
      diffRemoved: chalk.hex(hslToHex(6, 44, 52)),

      // Notices
      noticeSuccess: chalk.hex(hslToHex(CODE_HUE, 64, 74)),
      noticeWarn: chalk.hex(hslToHex(WARN_HUE, 76, 68)),
      noticeError: chalk.hex(hslToHex(ERROR_HUE, 76, 68)),
      noticeSuccessBg: chalk
        .bgHex(hslToHex(CODE_HUE, 52, 28))
        .hex(hslToHex(TEXT_HUE, 10, 92)),
      noticeWarnBg: chalk.bgHex(hslToHex(WARN_HUE, 70, 28)).hex(hslToHex(TEXT_HUE, 10, 92)),
      noticeErrorBg: chalk.bgHex(hslToHex(ERROR_HUE, 70, 28)).hex(hslToHex(TEXT_HUE, 10, 92)),
      noticeMutedBg: chalk.bgHex(hslToHex(TEXT_HUE, 6, 24)).hex(hslToHex(TEXT_HUE, 10, 92)),

      // User message
      userBg: chalk.bgHex(hslToHex(TEXT_HUE, 6, 12)),
      userText: (text) => text,
      userMemoryBg: chalk.bgHex(hslToHex(280, 18, 18)),
      userMemoryText: chalk.hex(hslToHex(280, 42, 82)),

      // Risk level indicators
      riskRestricted: chalk.hex(hslToHex(TEXT_HUE, 6, 42)),
      riskReadOnly: chalk.hex(hslToHex(72, 16, 44)),
      riskReadWrite: chalk.hex(hslToHex(8, 20, 56)),
    };
  }

  const wrap = (label: string) => (mode === "tags" ? tagWrapper(label) : plainWrapper());

  return {
    // Primary colors
    accent: wrap("accent"),
    muted: wrap("muted"),
    dim: wrap("dim"),
    link: wrap("link"),
    thinking: wrap("thinking"),
    codeInline: wrap("codeInline"),
    codeBlock: wrap("codeBlock"),

    // Semantic colors
    warn: wrap("warn"),
    error: wrap("error"),
    memoryMode: wrap("memoryMode"),
    bashRunning: wrap("bashRunning"),
    bashRan: wrap("bashRan"),
    bashOutput: wrap("bashOutput"),
    toolFileRan: wrap("toolFileRan"),
    filePreview: wrap("filePreview"),
    taskRunning: wrap("taskRunning"),
    taskRan: wrap("taskRan"),
    taskPreview: wrap("taskPreview"),

    // Diff colors
    diffAdded: wrap("diffAdded"),
    diffRemoved: wrap("diffRemoved"),

    // Notices
    noticeSuccess: wrap("noticeSuccess"),
    noticeWarn: wrap("noticeWarn"),
    noticeError: wrap("noticeError"),
    noticeSuccessBg: wrap("noticeSuccessBg"),
    noticeWarnBg: wrap("noticeWarnBg"),
    noticeErrorBg: wrap("noticeErrorBg"),
    noticeMutedBg: wrap("noticeMutedBg"),

    // User message
    userBg: wrap("userBg"),
    userText: (text) => text,
    userMemoryBg: wrap("userMemoryBg"),
    userMemoryText: wrap("userMemoryText"),

    // Risk level indicators
    riskRestricted: wrap("riskRestricted"),
    riskReadOnly: wrap("riskReadOnly"),
    riskReadWrite: wrap("riskReadWrite"),
  };
}

function createMarkdownTheme(palette: Palette, text: TextStyles): MarkdownTheme {
  return {
    bold: (textValue) => text.bold(textValue),
    code: (textValue) => palette.codeInline(textValue),
    codeBlock: (textValue) => palette.codeBlock(textValue),
    codeBlockBorder: (textValue) => palette.dim(textValue),
    heading: (textValue) => text.bold(palette.accent(textValue)),
    hr: (textValue) => palette.dim(textValue),
    italic: (textValue) => text.italic(textValue),
    link: (textValue) => palette.link(textValue),
    linkUrl: (textValue) => palette.dim(textValue),
    listBullet: (textValue) => palette.accent(textValue),
    quote: (textValue) => text.italic(palette.muted(textValue)),
    quoteBorder: (textValue) => palette.dim(textValue),
    strikethrough: (textValue) => text.strikethrough(textValue),
    underline: (textValue) => text.underline(textValue),
  };
}

function createSelectListTheme(palette: Palette, text: TextStyles): SelectListTheme {
  return {
    selectedPrefix: (textValue) => text.bold(palette.accent(textValue)),
    selectedText: (textValue) => text.bold(palette.accent(textValue)),
    description: (textValue) => palette.muted(textValue),
    scrollInfo: (textValue) => palette.dim(textValue),
    noMatch: (textValue) => palette.muted(textValue),
  };
}

function createEditorBorderForReasoning(
  mode: ThemeMode,
): (effort?: ReasoningEffort) => (text: string) => string {
  if (mode !== "ansi") {
    const wrap = (label: string) => (mode === "tags" ? tagWrapper(label) : plainWrapper());
    return (effort?: ReasoningEffort) => wrap(`editorBorder-${effort ?? "none"}`);
  }

  const [MIN_H, MAX_H] = [20, 28];
  const [MIN_S, MAX_S] = [8, 76];
  const [MIN_L, MAX_L] = [24, 52];
  const [RANGE_H, RANGE_S, RANGE_L] = [MAX_H - MIN_H, MAX_S - MIN_S, MAX_L - MIN_L];
  const h = (x: number) => MIN_H + RANGE_H * x;
  const s = (x: number) => MIN_S + RANGE_S * x;
  const l = (x: number) => MIN_L + RANGE_L * x;
  return (effort?: ReasoningEffort) => {
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
  };
}

export function createUiTheme(mode: ThemeMode = "ansi"): Theme {
  const palette = createPalette(mode);
  const text = createTextStyles(mode);
  const markdownTheme = createMarkdownTheme(palette, text);
  const selectListTheme = createSelectListTheme(palette, text);
  const editorBorderForReasoning = createEditorBorderForReasoning(mode);

  const editorTheme: EditorTheme = {
    borderColor: (textValue) => editorBorderForReasoning("none")(textValue),
    selectList: selectListTheme,
  };

  return {
    mode,
    palette,
    markdownTheme,
    editorTheme,
    text,
    editorBorderForReasoning,
  };
}

export const theme: Theme = createUiTheme("ansi");
export const palette = theme.palette;
export const markdownTheme = theme.markdownTheme;
export const editorTheme = theme.editorTheme;
export const editorBorderForReasoning = theme.editorBorderForReasoning;
