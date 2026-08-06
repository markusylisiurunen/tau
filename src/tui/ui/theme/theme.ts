import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { Chalk } from "chalk";
import { builtinThemes } from "../../../core/config/builtin_themes.js";
import type { AutocompleteListTheme } from "../components/autocomplete_list.js";
import type { EditorTheme } from "../components/editor.js";
import { coercePaletteOverrides, createPalette, type PaletteOverrides } from "./palette.js";

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
  editorBorder: (text: string) => string;
  editorSubagentBorder: (text: string) => string;
  editorBorderBash: (text: string) => string;
  editorBorderRecording: (text: string) => string;
  editorPlaceholder: (text: string) => string;
  autocompleteSelectedSurface: (text: string) => string;
  autocompleteSelectedText: (text: string) => string;

  // Status
  statusWarn: (text: string) => string;
  statusError: (text: string) => string;

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
  userText: (text: string) => string;
  userReviewSurface: (text: string) => string;
  userReviewText: (text: string) => string;
  userReviewTextMuted: (text: string) => string;
  userReviewTextDim: (text: string) => string;
}

export interface Theme {
  mode: ThemeMode;
  palette: Palette;
  markdownTheme: MarkdownTheme;
  editorTheme: EditorTheme;
  text: TextStyles;
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
    codeBlockIndent: "",
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

function createSelectListTheme(palette: Palette, text: TextStyles): AutocompleteListTheme {
  return {
    selectedBackground: (textValue) => palette.autocompleteSelectedSurface(textValue),
    selectedForeground: (textValue) => text.bold(palette.autocompleteSelectedText(textValue)),
    description: (textValue) => palette.textMuted(textValue),
    scrollInfo: (textValue) => palette.textDim(textValue),
    noMatch: (textValue) => palette.textMuted(textValue),
  };
}

const defaultPaletteOverrides = coercePaletteOverrides(
  builtinThemes.find((theme) => theme.id === "gold")?.tokens,
);

export function createUiTheme(mode: ThemeMode = "ansi", overrides?: PaletteOverrides): Theme {
  const palette = createPalette(mode, overrides ?? defaultPaletteOverrides);
  const text = createTextStyles(mode);
  const markdownTheme = createMarkdownTheme(palette, text);
  const selectListTheme = createSelectListTheme(palette, text);

  const editorTheme: EditorTheme = {
    borderColor: (textValue) => palette.editorBorder(textValue),
    selectList: selectListTheme,
  };

  return {
    mode,
    palette,
    markdownTheme,
    editorTheme,
    text,
  };
}

export const theme: Theme = createUiTheme("ansi");
export const palette = theme.palette;
export const markdownTheme = theme.markdownTheme;
export const editorTheme = theme.editorTheme;
