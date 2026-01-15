import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@mariozechner/pi-tui";
import { Chalk } from "chalk";
import type { ReasoningEffort } from "../../../core/types.js";
import { hslToHex } from "../../../core/utils/color.js";
import { assertNever } from "../../../core/utils/never.js";
import { PALETTE_COLORS, type PaletteTokenName } from "./palette_tokens.js";

const chalk = new Chalk({ level: 3 });

export type ThemeMode = "ansi" | "plain" | "tags";

export interface TextStyles {
  bold: (text: string) => string;
  italic: (text: string) => string;
  underline: (text: string) => string;
  strikethrough: (text: string) => string;
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
  toastSuccessBg: (text: string) => string;
  toastWarnBg: (text: string) => string;
  toastErrorBg: (text: string) => string;
  toastMutedBg: (text: string) => string;

  // User
  userSurface: (text: string) => string;
  userMemorySurface: (text: string) => string;
  userMemoryText: (text: string) => string;

  // Risk level indicators
  riskRestrictedText: (text: string) => string;
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

const paletteByName = new Map<PaletteTokenName, (typeof PALETTE_COLORS)[number]>(
  PALETTE_COLORS.map((color) => [color.name, color] as const),
);

const PALETTE_GROUPS: Array<{ label: string; names: PaletteTokenName[] }> = [
  {
    label: "core",
    names: [
      "brandAccent",
      "textMuted",
      "textDim",
      "linkText",
      "thinkingText",
      "codeInlineText",
      "codeBlockText",
    ],
  },
  {
    label: "status",
    names: ["statusWarn", "statusError", "modeMemory", "modeBash"],
  },
  {
    label: "action",
    names: ["actionRunning", "actionSuccess", "actionError", "actionOutput"],
  },
  { label: "diff", names: ["diffAdd", "diffRemove"] },
  { label: "toasts", names: ["toastSuccess", "toastWarn", "toastError"] },
  {
    label: "toast backgrounds",
    names: ["toastSuccessBg", "toastWarnBg", "toastErrorBg", "toastMutedBg"],
  },
  { label: "user", names: ["userSurface", "userMemorySurface", "userMemoryText"] },
  {
    label: "risk",
    names: ["riskRestrictedText", "riskReadOnlyText", "riskReadWriteText"],
  },
];

export function buildPalettePreview(): string {
  const columnGap = "  ";
  const indent = "  ";
  const nameWidth = Math.max(...PALETTE_COLORS.map((color) => color.name.length));
  const hslWidth = Math.max(
    ...PALETTE_COLORS.map((color) => `hsl(${color.h}, ${color.s}%, ${color.l}%)`.length),
  );
  const lines: string[] = [];
  for (const group of PALETTE_GROUPS) {
    lines.push(`${group.label}:`);
    for (const name of group.names) {
      const color = paletteByName.get(name);
      if (!color) {
        throw new Error(`unknown palette token in preview group '${group.label}': ${name}`);
      }
      const hex = hslToHex(color.h, color.s, color.l);
      const block = chalk.bgHex(hex)("   ");
      const hsl = `hsl(${color.h}, ${color.s}%, ${color.l}%)`;
      const line = [block, name.padEnd(nameWidth), hsl.padEnd(hslWidth), hex].join(columnGap);
      lines.push(`${indent}${line}`);
    }
  }
  return lines.join("\n");
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

type PaletteColorToken = Exclude<keyof Palette, "textDefault">;

type _assertPaletteTokensMatch =
  Exclude<PaletteColorToken, PaletteTokenName> extends never
    ? Exclude<PaletteTokenName, PaletteColorToken> extends never
      ? true
      : never
    : never;
const _assertPaletteTokensMatch: _assertPaletteTokensMatch = true;

const PALETTE_TEXT_TOKENS = [
  "brandAccent",
  "textMuted",
  "textDim",
  "linkText",
  "thinkingText",
  "codeInlineText",
  "codeBlockText",
  "statusWarn",
  "statusError",
  "modeMemory",
  "modeBash",
  "actionRunning",
  "actionSuccess",
  "actionError",
  "actionOutput",
  "diffAdd",
  "diffRemove",
  "toastSuccess",
  "toastWarn",
  "toastError",
  "userMemoryText",
  "riskRestrictedText",
  "riskReadOnlyText",
  "riskReadWriteText",
] as const satisfies readonly PaletteColorToken[];

const PALETTE_BG_TOKENS = [
  "toastSuccessBg",
  "toastWarnBg",
  "toastErrorBg",
  "toastMutedBg",
  "userSurface",
  "userMemorySurface",
] as const satisfies readonly PaletteColorToken[];

const ALL_PALETTE_TOKENS: readonly PaletteColorToken[] = [
  ...PALETTE_TEXT_TOKENS,
  ...PALETTE_BG_TOKENS,
];

type _assertAllPaletteTokensCovered =
  Exclude<
    PaletteColorToken,
    (typeof PALETTE_TEXT_TOKENS)[number] | (typeof PALETTE_BG_TOKENS)[number]
  > extends never
    ? true
    : never;
const _assertAllPaletteTokensCovered: _assertAllPaletteTokensCovered = true;

function buildPaletteLookup(): Record<PaletteTokenName, string> {
  return PALETTE_COLORS.reduce<Record<PaletteTokenName, string>>(
    (acc, color) => {
      acc[color.name] = hslToHex(color.h, color.s, color.l);
      return acc;
    },
    {} as Record<PaletteTokenName, string>,
  );
}

function createPalette(mode: ThemeMode): Palette {
  const validate = (palette: Palette): void => {
    for (const token of ALL_PALETTE_TOKENS) {
      if (typeof palette[token] !== "function") {
        throw new Error(`missing palette implementation: ${String(token)}`);
      }
    }
    if (typeof palette.textDefault !== "function") {
      throw new Error("missing palette implementation: textDefault");
    }
  };

  if (mode === "ansi") {
    const lookup = buildPaletteLookup();
    const getHex = (name: PaletteTokenName): string => {
      const hex = lookup[name];
      if (!hex) {
        throw new Error(`missing palette token: ${name}`);
      }
      return hex;
    };
    const makeText = (name: PaletteTokenName) => chalk.hex(getHex(name));
    const makeBg = (name: PaletteTokenName) => chalk.bgHex(getHex(name));
    const palette = {} as Palette;

    for (const token of PALETTE_TEXT_TOKENS) {
      palette[token] = makeText(token);
    }
    for (const token of PALETTE_BG_TOKENS) {
      palette[token] = makeBg(token);
    }
    palette.textDefault = (text) => text;

    const lightText = hslToHex(26, 10, 86);
    palette.toastSuccessBg = chalk.bgHex(getHex("toastSuccessBg")).hex(lightText);
    palette.toastWarnBg = chalk.bgHex(getHex("toastWarnBg")).hex(lightText);
    palette.toastErrorBg = chalk.bgHex(getHex("toastErrorBg")).hex(lightText);
    palette.toastMutedBg = chalk.bgHex(getHex("toastMutedBg")).hex(lightText);

    validate(palette);
    return palette;
  }

  const wrap = (label: string) => (mode === "tags" ? tagWrapper(label) : plainWrapper());
  const palette = {} as Palette;

  for (const token of PALETTE_TEXT_TOKENS) {
    palette[token] = wrap(token);
  }
  for (const token of PALETTE_BG_TOKENS) {
    palette[token] = wrap(token);
  }
  palette.textDefault = (text) => text;

  validate(palette);
  return palette;
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
    listBullet: (textValue) => palette.brandAccent(textValue),
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
  mode: ThemeMode,
): (effort?: ReasoningEffort) => (text: string) => string {
  if (mode !== "ansi") {
    const wrap = (label: string) => (mode === "tags" ? tagWrapper(label) : plainWrapper());
    return (effort?: ReasoningEffort) => wrap(`editorBorder-${effort ?? "none"}`);
  }

  const accent = paletteByName.get("brandAccent");
  const dim = paletteByName.get("textDim");
  if (!accent || !dim) {
    return () => (text) => text;
  }
  const [MIN_H, MAX_H] = [dim.h, accent.h];
  const [MIN_S, MAX_S] = [dim.s, accent.s];
  const [MIN_L, MAX_L] = [dim.l, accent.l];
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
