import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Color from "colorjs.io";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, "../src/core/config/builtin_themes.ts");

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const wrapHue = (h) => ((h % 360) + 360) % 360;

const makeColor = (l, c, h) => {
  return new Color("oklch", [clamp(l, 0, 100) / 100, Math.max(0, c), wrapHue(h)]);
};

const toHex = (color) => {
  return color.toGamut({ space: "srgb", method: "oklch.c" }).to("srgb").toString({ format: "hex" });
};

const transform = (color, transforms) => {
  return transforms.reduce((result, fn) => fn(result), color);
};

const setH = (newHue) => (color) => {
  return color.clone().set("oklch.h", wrapHue(newHue));
};
const setL = (newLightness) => (color) => {
  return color.clone().set("oklch.l", clamp(newLightness, 0, 100) / 100);
};
const shiftL = (lightnessDelta) => (color) => {
  return color
    .clone()
    .set("oklch.l", clamp(color.get("oklch.l") * 100 + lightnessDelta, 0, 100) / 100);
};
const scaleC = (factor) => (color) => {
  return color.clone().set("oklch.c", Math.max(0, color.get("oklch.c") * factor));
};

const generatePalette = (brandHue, appearance) => {
  const HUE_BRAND = wrapHue(brandHue);
  const HUE_DIFF_PLUS = wrapHue(108);
  const HUE_DIFF_MINUS = wrapHue(12);
  const HUE_SUCCESS = wrapHue(108);
  const HUE_WARN = wrapHue(36);
  const HUE_ERROR = wrapHue(12);
  const HUE_CODE = wrapHue(HUE_BRAND + 24);
  const HUE_EDITOR_BORDER = HUE_BRAND;
  const HUE_EDITOR_SUBAGENT_BORDER = wrapHue(HUE_BRAND - 32);
  const HUE_EDITOR_RECORDING_BORDER = HUE_ERROR;
  const HUE_MEMORY = wrapHue(280);
  const HUE_REVIEW = wrapHue(132);
  const HUE_BASH = wrapHue(92);

  const isDark = appearance === "dark";

  const brandAccent = makeColor(isDark ? 72 : 48, isDark ? 0.1 : 0.2, HUE_BRAND);
  const textMuted = transform(brandAccent, [scaleC(0.1), shiftL(isDark ? -8 : 8)]);
  const textDim = transform(brandAccent, [scaleC(0.05), shiftL(isDark ? -22 : 22)]);
  const codeText = transform(brandAccent, [setH(HUE_CODE)]);

  const editorBorder = transform(brandAccent, [
    setH(HUE_EDITOR_BORDER),
    scaleC(0.56),
    shiftL(isDark ? -10 : 10),
  ]);
  const editorSubagentBorder = transform(brandAccent, [
    setH(HUE_EDITOR_SUBAGENT_BORDER),
    scaleC(0.96),
    shiftL(isDark ? 16 : 10),
  ]);
  const editorRecordingBorder = transform(brandAccent, [
    setH(HUE_EDITOR_RECORDING_BORDER),
    scaleC(0.72),
    setL(isDark ? 72 : 38),
  ]);

  const actionRunning = transform(brandAccent, [
    setH(HUE_WARN),
    scaleC(0.84),
    shiftL(isDark ? 8 : 0),
  ]);
  const actionSuccess = transform(actionRunning, [setH(HUE_SUCCESS)]);
  const actionError = transform(actionRunning, [setH(HUE_ERROR)]);
  const actionOutput = textDim;

  const diffAdd = transform(brandAccent, [
    setH(HUE_DIFF_PLUS),
    scaleC(isDark ? 0.92 : 1),
    shiftL(isDark ? -6 : 4),
  ]);
  const diffRemove = transform(diffAdd, [setH(HUE_DIFF_MINUS)]);

  const toastSuccess = transform(brandAccent, [
    setH(HUE_SUCCESS),
    scaleC(1.08),
    shiftL(isDark ? 6 : 0),
  ]);
  const toastWarn = transform(toastSuccess, [setH(HUE_WARN)]);
  const toastError = transform(toastSuccess, [setH(HUE_ERROR)]);

  const userSurface = transform(brandAccent, [scaleC(isDark ? 0.01 : 0), setL(isDark ? 21 : 97)]);
  const userMemorySurface = transform(brandAccent, [
    setH(HUE_MEMORY),
    scaleC(isDark ? 0.24 : 0.04),
    setL(isDark ? 24 : 94),
  ]);
  const userMemoryText = transform(brandAccent, [
    setH(HUE_MEMORY),
    scaleC(0.76),
    setL(isDark ? 84 : 28),
  ]);
  const userReviewSurface = transform(brandAccent, [
    setH(HUE_REVIEW),
    scaleC(isDark ? 0.16 : 0.03),
    setL(isDark ? 22 : 95),
  ]);
  const userReviewText = transform(brandAccent, [
    setH(HUE_REVIEW),
    scaleC(0.56),
    setL(isDark ? 83 : 29),
  ]);
  const userReviewTextMuted = transform(userReviewText, [scaleC(0.36), shiftL(isDark ? -12 : 12)]);
  const userReviewTextDim = transform(userReviewText, [scaleC(0.16), shiftL(isDark ? -24 : 24)]);

  const statusWarn = transform(brandAccent, [setH(HUE_WARN), scaleC(0.92), setL(isDark ? 68 : 44)]);
  const statusError = transform(statusWarn, [setH(HUE_ERROR)]);

  return {
    brandAccent: toHex(brandAccent),
    textMuted: toHex(textMuted),
    textDim: toHex(textDim),
    linkText: toHex(brandAccent),
    thinkingText: toHex(textDim),
    codeInlineText: toHex(codeText),
    codeBlockText: toHex(codeText),

    editorBorderNone: toHex(editorBorder),
    editorBorderMinimal: toHex(editorBorder),
    editorBorderLow: toHex(editorBorder),
    editorBorderMedium: toHex(editorBorder),
    editorBorderHigh: toHex(editorBorder),
    editorBorderXhigh: toHex(editorBorder),
    editorBorderMax: toHex(editorBorder),
    editorSubagentBorder: toHex(editorSubagentBorder),
    editorBorderRecording: toHex(editorRecordingBorder),

    statusWarn: toHex(statusWarn),
    statusError: toHex(statusError),

    modeMemory: toHex(transform(brandAccent, [setH(HUE_MEMORY), shiftL(isDark ? 12 : -10)])),
    modeBash: toHex(transform(brandAccent, [setH(HUE_BASH), shiftL(isDark ? 12 : -10)])),

    actionRunning: toHex(actionRunning),
    actionSuccess: toHex(actionSuccess),
    actionError: toHex(actionError),
    actionOutput: toHex(actionOutput),

    diffAdd: toHex(diffAdd),
    diffRemove: toHex(diffRemove),

    toastSuccess: toHex(toastSuccess),
    toastWarn: toHex(toastWarn),
    toastError: toHex(toastError),

    userSurface: toHex(userSurface),
    userMemorySurface: toHex(userMemorySurface),
    userMemoryText: toHex(userMemoryText),
    userReviewSurface: toHex(userReviewSurface),
    userReviewText: toHex(userReviewText),
    userReviewTextMuted: toHex(userReviewTextMuted),
    userReviewTextDim: toHex(userReviewTextDim),

    riskReadOnlyText: toHex(textMuted),
    riskReadWriteText: toHex(textMuted),
  };
};

const brands = [
  { hue: 0, name: "crimson" },
  { hue: 24, name: "ember" },
  { hue: 48, name: "gold" },
  { hue: 72, name: "lime" },
  { hue: 96, name: "grass" },
  { hue: 120, name: "emerald" },
  { hue: 144, name: "jade" },
  { hue: 168, name: "teal" },
  { hue: 192, name: "cyan" },
  { hue: 216, name: "azure" },
  { hue: 240, name: "cobalt" },
  { hue: 264, name: "violet" },
  { hue: 288, name: "purple" },
  { hue: 312, name: "magenta" },
  { hue: 336, name: "rose" },
];

const themes = brands.map((brand) => {
  const darkTokens = generatePalette(brand.hue, "dark");
  const lightTokens = generatePalette(brand.hue, "light");

  return {
    id: brand.name,
    tokens: darkTokens,
    variants: {
      light: lightTokens,
    },
    sourcePath: `builtin:themes/${brand.name}.json`,
    scope: "builtin",
  };
});

const goldTheme = themes.find((theme) => theme.id === "gold");
if (!goldTheme) {
  throw new Error("missing gold theme");
}

const paletteTokenNames = Object.keys(goldTheme.tokens);

const formatTokens = (tokens) => {
  return JSON.stringify(tokens, null, 2).replace(/\n/g, "\n    ");
};

const themeEntries = themes.map((theme) => {
  return [
    "  {",
    `    id: "${theme.id}",`,
    `    tokens: ${formatTokens(theme.tokens)},`,
    `    variants: ${formatTokens(theme.variants)},`,
    `    sourcePath: "${theme.sourcePath}",`,
    '    scope: "builtin"',
    "  },",
  ].join("\n");
});

const output = [
  'import type { ThemeDefinition } from "./content_loader.js";',
  "",
  `export const PALETTE_TOKEN_NAMES = ${JSON.stringify(paletteTokenNames, null, 2)} as const;`,
  "",
  "export const builtinThemes: ThemeDefinition[] = [",
  ...themeEntries,
  "];",
  "",
].join("\n");

writeFileSync(outputPath, output);
execFileSync("npx", ["biome", "format", "--write", outputPath], { stdio: "inherit" });
console.log(`generated themes: ${themes.length}`);
