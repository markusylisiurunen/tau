import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@mariozechner/pi-tui";
import { Chalk } from "chalk";
import type { ReasoningEffort } from "../../../core/types.js";
import { assertNever } from "../../../core/utils/never.js";
import { createPalette, type PaletteOverrides } from "./palette.js";

const chalk = new Chalk({ level: 3 });

export type ThemeMode = "ansi" | "plain" | "tags";

export interface TextStyles {
  bold: (text: string) => string;
  italic: (text: string) => string;
  underline: (text: string) => string;
  strikethrough: (text: string) => string;
  cursor: (text: string) => string;
}

export interface Palette {
  // Core
  brandAccent: (text: string) => string;
  textMuted: (text: string) => string;
  textDim: (text: string) => string;
  linkText: (text: string) => string;
  thinkingText: (text: string) => string;
  codeInlineText: (text: string) => string;
  codeBlockText: (text: string) => string;
  textDefault: (text: string) => string;

  // Editor
  editorBorderNone: (text: string) => string;
  editorBorderMinimal: (text: string) => string;
  editorBorderLow: (text: string) => string;
  editorBorderMedium: (text: string) => string;
  editorBorderHigh: (text: string) => string;
  editorBorderXhigh: (text: string) => string;

  // Status
  statusWarn: (text: string) => string;
  statusError: (text: string) => string;
  modeMemory: (text: string) => string;
  modeBash: (text: string) => string;

  // Action
  actionRunning: (text: string) => string;
  actionSuccess: (text: string) => string;
  actionError: (text: string) => string;
  actionOutput: (text: string) => string;

  // Diff
  diffAdd: (text: string) => string;
  diffRemove: (text: string) => string;

  // Toasts
  toastSuccess: (text: string) => string;
  toastWarn: (text: string) => string;
  toastError: (text: string) => string;

  // User
  userSurface: (text: string) => string;
  userMemorySurface: (text: string) => string;
  userMemoryText: (text: string) => string;

  // Risk level indicators
  riskReadOnlyText: (text: string) => string;
  riskReadWriteText: (text: string) => string;
}

export interface Theme {
  mode: ThemeMode;
  palette: Palette;
  markdownTheme: MarkdownTheme;
  editorTheme: EditorTheme;
  text: TextStyles;
  editorBorderForReasoning: (effort?: ReasoningEffort) => (text: string) => string;
}

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
      cursor: (text) => chalk.inverse(text),
    };
  }

  const wrap = (label: string) => (mode === "tags" ? tagWrapper(label) : plainWrapper());
  return {
    bold: wrap("bold"),
    italic: wrap("italic"),
    underline: wrap("underline"),
    strikethrough: wrap("strikethrough"),
    cursor: wrap("cursor"),
  };
}

function createMarkdownTheme(palette: Palette, text: TextStyles): MarkdownTheme {
  return {
    bold: (textValue) => text.bold(textValue),
    code: (textValue) => palette.codeInlineText(textValue),
    codeBlock: (textValue) => palette.codeBlockText(textValue),
    codeBlockBorder: (textValue) => palette.textDim(textValue),
    heading: (textValue) => text.bold(palette.brandAccent(textValue)),
    hr: (textValue) => palette.textDim(textValue),
    italic: (textValue) => text.italic(textValue),
    link: (textValue) => palette.linkText(textValue),
    linkUrl: (textValue) => palette.textDim(textValue),
    listBullet: (textValue) => palette.textMuted(textValue),
    quote: (textValue) => text.italic(palette.textMuted(textValue)),
    quoteBorder: (textValue) => palette.textDim(textValue),
    strikethrough: (textValue) => text.strikethrough(textValue),
    underline: (textValue) => text.underline(textValue),
  };
}

function createSelectListTheme(palette: Palette, text: TextStyles): SelectListTheme {
  return {
    selectedPrefix: (textValue) => text.bold(palette.brandAccent(textValue)),
    selectedText: (textValue) => text.bold(palette.brandAccent(textValue)),
    description: (textValue) => palette.textMuted(textValue),
    scrollInfo: (textValue) => palette.textDim(textValue),
    noMatch: (textValue) => palette.textMuted(textValue),
  };
}

function createEditorBorderForReasoning(
  palette: Palette,
): (effort?: ReasoningEffort) => (text: string) => string {
  return (effort?: ReasoningEffort) => {
    switch (effort) {
      case undefined:
      case "none":
        return palette.editorBorderNone;
      case "minimal":
        return palette.editorBorderMinimal;
      case "low":
        return palette.editorBorderLow;
      case "medium":
        return palette.editorBorderMedium;
      case "high":
        return palette.editorBorderHigh;
      case "xhigh":
        return palette.editorBorderXhigh;
      default:
        assertNever(effort);
    }
  };
}

export function createUiTheme(mode: ThemeMode = "ansi", overrides?: PaletteOverrides): Theme {
  const palette = createPalette(mode, overrides);
  const text = createTextStyles(mode);
  const markdownTheme = createMarkdownTheme(palette, text);
  const selectListTheme = createSelectListTheme(palette, text);
  const editorBorderForReasoning = createEditorBorderForReasoning(palette);

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
