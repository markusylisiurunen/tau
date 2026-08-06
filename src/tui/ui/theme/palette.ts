import chalk from "chalk";
import Color from "colorjs.io";
import { builtinThemes } from "../../../core/config/builtin_themes.js";
import type { ThemeAppearance } from "../../../core/config/content_loader.js";
import { hslToHex } from "../../../core/utils/color.js";
import type { TerminalColors, TerminalRgbColor } from "../../terminal_appearance.js";
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
  "editorBorder",
  "editorSubagentBorder",
  "editorBorderBash",
  "editorBorderRecording",
  "editorPlaceholder",
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

const REFERENCE_TERMINAL_COLORS: Record<ThemeAppearance, TerminalColors> = {
  dark: {
    foreground: { r: 0xd4 / 255, g: 0xd4 / 255, b: 0xd4 / 255 },
    background: { r: 0x1e / 255, g: 0x1e / 255, b: 0x1e / 255 },
    appearance: "dark",
  },
  light: {
    foreground: { r: 0x24 / 255, g: 0x24 / 255, b: 0x24 / 255 },
    background: { r: 1, g: 1, b: 1 },
    appearance: "light",
  },
};

function hexToRgb(value: string): TerminalRgbColor {
  return {
    r: Number.parseInt(value.slice(1, 3), 16) / 255,
    g: Number.parseInt(value.slice(3, 5), 16) / 255,
    b: Number.parseInt(value.slice(5, 7), 16) / 255,
  };
}

type OklabColor = {
  l: number;
  a: number;
  b: number;
};

function rgbToOklab(color: TerminalRgbColor): OklabColor {
  const converted = new Color("srgb", [color.r, color.g, color.b]).to("oklab");
  return {
    l: converted.get("oklab.l"),
    a: converted.get("oklab.a"),
    b: converted.get("oklab.b"),
  };
}

function interpolateOklab(from: OklabColor, to: OklabColor, amount: number): OklabColor {
  return {
    l: from.l + (to.l - from.l) * amount,
    a: from.a + (to.a - from.a) * amount,
    b: from.b + (to.b - from.b) * amount,
  };
}

function oklabToHex(color: OklabColor): string {
  return new Color("oklab", [color.l, color.a, color.b])
    .toGamut({ space: "srgb", method: "oklch.c" })
    .to("srgb")
    .toString({ format: "hex" });
}

function deriveSurface(terminalColors: TerminalColors, accentHex: string): OklabColor {
  const background = rgbToOklab(terminalColors.background);
  const accent = rgbToOklab(hexToRgb(accentHex));
  const raisedBackground: OklabColor = {
    ...background,
    l: Math.max(
      0,
      Math.min(1, background.l + (terminalColors.appearance === "dark" ? 0.08 : -0.045)),
    ),
  };
  return interpolateOklab(raisedBackground, accent, 0.08);
}

type NeutralTextColors = {
  strong: string;
  muted: string;
  dim: string;
};

function moveLightnessAwayFromBackground(
  background: OklabColor,
  foreground: OklabColor,
  amount: number,
): number {
  const direction = Math.sign(foreground.l - background.l) || 1;
  return Math.max(0, Math.min(1, foreground.l + direction * amount));
}

function deriveNeutralTextColors(terminalColors: TerminalColors): NeutralTextColors {
  const background = rgbToOklab(terminalColors.background);
  const foreground = rgbToOklab(terminalColors.foreground);
  return {
    strong: oklabToHex({
      ...foreground,
      l: moveLightnessAwayFromBackground(background, foreground, 0.04),
    }),
    muted: oklabToHex(interpolateOklab(background, foreground, 0.78)),
    dim: oklabToHex(interpolateOklab(background, foreground, 0.58)),
  };
}

function deriveSemanticTextHex(lightness: number, chroma: number, hue: number): string {
  return new Color("oklch", [lightness, chroma, hue])
    .toGamut({ space: "srgb", method: "oklch.c" })
    .to("srgb")
    .toString({ format: "hex" });
}

function getColorHue(value: string): number {
  const hue = new Color(value).to("oklch").get("oklch.h");
  return Number.isNaN(hue) ? 0 : hue;
}

function resolveCommonChroma(
  lightness: number,
  targetChroma: number,
  hues: readonly number[],
): number {
  let minimumChroma = 0;
  let maximumChroma = targetChroma;

  for (let iteration = 0; iteration < 16; iteration += 1) {
    const chroma = (minimumChroma + maximumChroma) / 2;
    const allInGamut = hues.every((hue) =>
      new Color("oklch", [lightness, chroma, hue]).inGamut("srgb"),
    );
    if (allInGamut) {
      minimumChroma = chroma;
    } else {
      maximumChroma = chroma;
    }
  }

  return minimumChroma;
}

const ACTION_HUES = [70, 108, 12] as const;
const ACTION_TARGET_CHROMA = 0.15;

function deriveActionColors(terminalColors: TerminalColors): [string, string, string] {
  const foreground = new Color("srgb", [
    terminalColors.foreground.r,
    terminalColors.foreground.g,
    terminalColors.foreground.b,
  ]).to("oklch");
  const lightness = Math.max(0, foreground.get("oklch.l") - 0.1);
  const chroma = resolveCommonChroma(lightness, ACTION_TARGET_CHROMA, ACTION_HUES);

  return ACTION_HUES.map((hue) =>
    new Color("oklch", [lightness, chroma, hue]).to("srgb").toString({ format: "hex" }),
  ) as [string, string, string];
}

const NOTIFICATION_HUES = [108, 70, 12] as const;
const NOTIFICATION_TARGET_CHROMA = 0.55;

function deriveNotificationColors(terminalColors: TerminalColors): [string, string, string] {
  const foreground = new Color("srgb", [
    terminalColors.foreground.r,
    terminalColors.foreground.g,
    terminalColors.foreground.b,
  ]).to("oklch");
  const lightness = foreground.get("oklch.l") * 0.965;
  const chroma = resolveCommonChroma(lightness, NOTIFICATION_TARGET_CHROMA, NOTIFICATION_HUES);
  return NOTIFICATION_HUES.map((hue) => deriveSemanticTextHex(lightness, chroma, hue)) as [
    string,
    string,
    string,
  ];
}

const DIFF_HUES = [105, 12] as const;
const DIFF_TARGET_CHROMA = 0.55;

function deriveDiffColors(terminalColors: TerminalColors): [string, string] {
  const foreground = new Color("srgb", [
    terminalColors.foreground.r,
    terminalColors.foreground.g,
    terminalColors.foreground.b,
  ]).to("oklch");
  const lightness = foreground.get("oklch.l") * 0.965;
  const chroma = resolveCommonChroma(lightness, DIFF_TARGET_CHROMA, DIFF_HUES);
  return DIFF_HUES.map((hue) => deriveSemanticTextHex(lightness, chroma, hue)) as [string, string];
}

const SPECIAL_BORDER_HUES = [92, 12] as const;

function deriveBorderColors(
  brandHex: string,
  terminalColors: TerminalColors,
): {
  normal: string;
  bash: string;
  recording: string;
} {
  const brand = new Color(brandHex).to("oklch");
  const background = rgbToOklab(terminalColors.background);
  const brandLightness = brand.get("oklch.l");
  const brandChroma = brand.get("oklch.c");
  const brandHue = brand.get("oklch.h");
  const normalLightness = brandLightness + (background.l - brandLightness) * 0.33;
  const normal = deriveSemanticTextHex(normalLightness, brandChroma * 0.5, brandHue);
  const targetChroma = brandChroma + 0.06;
  let specialBackgroundMix = 0.05;
  let specialLightness = brandLightness + (background.l - brandLightness) * specialBackgroundMix;

  while (
    specialBackgroundMix < 1 &&
    SPECIAL_BORDER_HUES.some(
      (hue) => !new Color("oklch", [specialLightness, targetChroma, hue]).inGamut("srgb"),
    )
  ) {
    specialBackgroundMix = Math.min(1, specialBackgroundMix + 0.02);
    specialLightness = brandLightness + (background.l - brandLightness) * specialBackgroundMix;
  }

  const specialChroma = resolveCommonChroma(specialLightness, targetChroma, SPECIAL_BORDER_HUES);
  const [bash, recording] = SPECIAL_BORDER_HUES.map((hue) =>
    deriveSemanticTextHex(specialLightness, specialChroma, hue),
  ) as [string, string];

  return { normal, bash, recording };
}

function deriveReviewSurfaceHex(surface: OklabColor, reviewSeedHex: string): string {
  const reviewSeed = rgbToOklab(hexToRgb(reviewSeedHex));
  const hue = Math.atan2(reviewSeed.b, reviewSeed.a);
  const surfaceChroma = Math.hypot(surface.a, surface.b);
  const reviewSeedChroma = Math.hypot(reviewSeed.a, reviewSeed.b);
  const chroma = Math.max(surfaceChroma * 1.1, reviewSeedChroma * 0.75);

  return oklabToHex({
    l: Math.max(0, surface.l - 0.04),
    a: Math.cos(hue) * chroma,
    b: Math.sin(hue) * chroma,
  });
}

export function deriveBuiltinPaletteOverrides(
  seeds: PaletteOverrides | undefined,
  terminalColors: TerminalColors,
): PaletteOverrides | undefined {
  if (!seeds) return undefined;

  const reference = REFERENCE_TERMINAL_COLORS[terminalColors.appearance];
  const referenceBackground = rgbToOklab(reference.background);
  const referenceForeground = rgbToOklab(reference.foreground);
  const terminalBackground = rgbToOklab(terminalColors.background);
  const terminalForeground = rgbToOklab(terminalColors.foreground);
  const referenceRange = referenceForeground.l - referenceBackground.l;
  const derived: PaletteOverrides = {};

  for (const [name, value] of Object.entries(seeds)) {
    if (!value) continue;
    const seed = rgbToOklab(hexToRgb(value));
    const amount = (seed.l - referenceBackground.l) / referenceRange;
    const referenceNeutral = interpolateOklab(referenceBackground, referenceForeground, amount);
    const terminalNeutral = interpolateOklab(terminalBackground, terminalForeground, amount);

    derived[name as PaletteTokenName] = oklabToHex({
      l: terminalNeutral.l + seed.l - referenceNeutral.l,
      a: terminalNeutral.a + seed.a - referenceNeutral.a,
      b: terminalNeutral.b + seed.b - referenceNeutral.b,
    });
  }

  const neutralText = deriveNeutralTextColors(terminalColors);
  derived.textMuted = neutralText.muted;
  derived.textDim = neutralText.dim;
  derived.thinkingText = neutralText.dim;
  derived.actionOutput = neutralText.dim;
  derived.editorPlaceholder = neutralText.dim;
  derived.autocompleteSelectedText = neutralText.strong;
  derived.userText = neutralText.strong;

  const brandSeed = seeds.brandAccent;
  if (brandSeed) {
    const brandLightness = moveLightnessAwayFromBackground(
      terminalBackground,
      terminalForeground,
      0.02,
    );
    const brandText = deriveSemanticTextHex(brandLightness, 0.04, getColorHue(brandSeed));
    derived.brandAccent = brandText;
    derived.linkText = brandText;

    const codeLightness = new Color(brandText).to("oklch").get("oklch.l");
    const codeText = deriveSemanticTextHex(codeLightness, 0.055, 77);
    derived.codeInlineText = codeText;
    derived.codeBlockText = codeText;

    const borders = deriveBorderColors(brandText, terminalColors);
    derived.editorBorder = borders.normal;
    derived.editorSubagentBorder = borders.normal;
    derived.editorBorderBash = borders.bash;
    derived.editorBorderRecording = borders.recording;
  }

  const reviewTextSeed = seeds.userReviewText;
  if (reviewTextSeed) {
    const direction = Math.sign(terminalForeground.l - terminalBackground.l) || 1;
    const reviewHue = getColorHue(reviewTextSeed);
    derived.userReviewText = deriveSemanticTextHex(
      Math.max(0, Math.min(1, terminalForeground.l - direction * 0.02)),
      0.04,
      reviewHue,
    );
    derived.userReviewTextMuted = deriveSemanticTextHex(
      interpolateOklab(terminalBackground, terminalForeground, 0.75).l,
      0.025,
      reviewHue,
    );
    derived.userReviewTextDim = deriveSemanticTextHex(
      interpolateOklab(terminalBackground, terminalForeground, 0.55).l,
      0.012,
      reviewHue,
    );
  }

  const [warning, success, error] = deriveActionColors(terminalColors);
  derived.actionRunning = warning;
  derived.actionSuccess = success;
  derived.actionError = error;
  derived.statusWarn = warning;

  const [toastSuccess, toastWarn, toastError] = deriveNotificationColors(terminalColors);
  derived.toastSuccess = toastSuccess;
  derived.toastWarn = toastWarn;
  derived.toastError = toastError;
  derived.statusError = toastError;

  const [diffAdd, diffRemove] = deriveDiffColors(terminalColors);
  derived.diffAdd = diffAdd;
  derived.diffRemove = diffRemove;

  const accent = derived.brandAccent;
  const reviewSurfaceSeed = seeds.userReviewSurface;
  if (accent && reviewSurfaceSeed) {
    const surface = deriveSurface(terminalColors, accent);
    const surfaceHex = oklabToHex(surface);
    derived.autocompleteSelectedSurface = surfaceHex;
    derived.userSurface = surfaceHex;
    derived.userReviewSurface = deriveReviewSurfaceHex(surface, reviewSurfaceSeed);
  }

  return derived;
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
