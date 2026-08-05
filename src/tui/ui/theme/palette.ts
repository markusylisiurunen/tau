import chalk from "chalk";
import { builtinThemes } from "../../../core/config/builtin_themes.js";
import { hslToHex } from "../../../core/utils/color.js";
import type { Palette, ThemeMode } from "./theme.js";
import { PALETTE_TOKEN_NAMES, type PaletteTokenName } from "./tokens.js";

const defaultPaletteTokens = (() => {
  const gold = builtinThemes.find((theme) => theme.id === "gold");
  if (!gold) {
    throw new Error("missing builtin theme: gold");
  }

  const resolved = {} as Record<PaletteTokenName, string>;
  for (const name of PALETTE_TOKEN_NAMES) {
    const value = gold.tokens[name];
    if (!value) {
      throw new Error(`missing palette token: ${name}`);
    }
    resolved[name] = value;
  }

  return resolved;
})();

function tagWrapper(label: string): (text: string) => string {
  return (text) => `<${label}>${text}</${label}>`;
}

function plainWrapper(): (text: string) => string {
  return (text) => text;
}

type PaletteColorToken = Exclude<keyof Palette, "textDefault">;
export type PaletteOverrides = Partial<Record<PaletteTokenName, string>>;

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
  "editorBorderNone",
  "editorBorderMinimal",
  "editorBorderLow",
  "editorBorderMedium",
  "editorBorderHigh",
  "editorBorderXhigh",
  "editorBorderMax",
  "editorSubagentBorder",
  "editorBorderBash",
  "editorBorderRecording",
  "autocompleteSelectedText",
  "statusWarn",
  "statusError",
  "actionRunning",
  "actionSuccess",
  "actionError",
  "actionOutput",
  "diffAdd",
  "diffRemove",
  "toastSuccess",
  "toastWarn",
  "toastError",
  "userText",
  "userReviewText",
  "userReviewTextMuted",
  "userReviewTextDim",
] as const satisfies readonly PaletteColorToken[];

const PALETTE_BG_TOKENS = [
  "autocompleteSelectedSurface",
  "userSurface",
  "userReviewSurface",
] as const satisfies readonly PaletteColorToken[];

const ALL_PALETTE_TOKENS: readonly PaletteColorToken[] = [
  ...PALETTE_TEXT_TOKENS,
  ...PALETTE_BG_TOKENS,
];
const ALL_PALETTE_TOKEN_SET = new Set<string>(ALL_PALETTE_TOKENS);

type _assertAllPaletteTokensCovered =
  Exclude<
    PaletteColorToken,
    (typeof PALETTE_TEXT_TOKENS)[number] | (typeof PALETTE_BG_TOKENS)[number]
  > extends never
    ? true
    : never;
const _assertAllPaletteTokensCovered: _assertAllPaletteTokensCovered = true;

export function getPaletteToken(name: PaletteTokenName): string | undefined {
  return defaultPaletteTokens[name];
}

function normalizeHex(value: string): string | undefined {
  const cleaned = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(cleaned)) {
    return cleaned;
  }
  if (/^#[0-9a-fA-F]{3}$/.test(cleaned)) {
    const [r, g, b] = cleaned
      .slice(1)
      .split("")
      .map((channel) => channel + channel);
    return `#${r}${g}${b}`;
  }
  return undefined;
}

function rgbToHex(channel: number): string {
  return channel.toString(16).padStart(2, "0");
}

function parseRgb(value: string): string | undefined {
  const match = value.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
  if (!match) return undefined;
  const parts = match.slice(1, 4);
  if (parts.length !== 3) return undefined;
  const [r, g, b] = parts.map((part) => Number(part)) as [number, number, number];
  if ([r, g, b].some((channel) => Number.isNaN(channel) || channel < 0 || channel > 255)) {
    return undefined;
  }
  return `#${rgbToHex(r)}${rgbToHex(g)}${rgbToHex(b)}`;
}

function parseHsl(value: string): string | undefined {
  const match = value.match(
    /^hsl\(\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+(?:\.[0-9]+)?)%?\s*,\s*([0-9]+(?:\.[0-9]+)?)%?\s*\)$/i,
  );
  if (!match) return undefined;
  const parts = match.slice(1, 4);
  if (parts.length !== 3) return undefined;
  const [h, s, l] = parts.map((part) => Number(part)) as [number, number, number];
  if ([h, s, l].some((channel) => Number.isNaN(channel))) {
    return undefined;
  }
  if (h < 0 || h > 360 || s < 0 || s > 100 || l < 0 || l > 100) {
    return undefined;
  }
  return hslToHex(h, s, l);
}

export function coercePaletteOverrides(raw?: Record<string, string>): PaletteOverrides | undefined {
  if (!raw) return undefined;
  const overrides: PaletteOverrides = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ALL_PALETTE_TOKEN_SET.has(key)) continue;
    const hex = normalizeHex(value) ?? parseRgb(value) ?? parseHsl(value);
    if (!hex) continue;
    overrides[key as PaletteTokenName] = hex;
  }
  return overrides;
}

function resolveOverrideHex(
  overrides: PaletteOverrides | undefined,
  token: PaletteTokenName,
): string | undefined {
  if (!overrides) return undefined;
  const raw = overrides[token];
  if (!raw) return undefined;
  return normalizeHex(raw) ?? parseRgb(raw) ?? parseHsl(raw);
}

export function createPalette(mode: ThemeMode, overrides?: PaletteOverrides): Palette {
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

  if (mode === "ansi" && overrides !== undefined) {
    const palette = {} as Palette;

    for (const token of PALETTE_TEXT_TOKENS) {
      const hex = resolveOverrideHex(overrides, token);
      palette[token] = hex ? chalk.hex(hex) : (text) => text;
    }
    for (const token of PALETTE_BG_TOKENS) {
      const hex = resolveOverrideHex(overrides, token);
      palette[token] = hex ? chalk.bgHex(hex) : (text) => text;
    }
    palette.textDefault = (text) => text;

    validate(palette);
    return palette;
  }

  if (mode === "ansi") {
    const makeText = (name: PaletteTokenName) => chalk.hex(defaultPaletteTokens[name]);
    const makeBg = (name: PaletteTokenName) => chalk.bgHex(defaultPaletteTokens[name]);
    const palette = {} as Palette;

    for (const token of PALETTE_TEXT_TOKENS) {
      palette[token] = makeText(token);
    }
    for (const token of PALETTE_BG_TOKENS) {
      palette[token] = makeBg(token);
    }
    palette.textDefault = (text) => text;

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
