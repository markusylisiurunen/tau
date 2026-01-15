import { Chalk } from "chalk";
import { hslToHex } from "../../../core/utils/color.js";
import { PALETTE_COLORS, type PaletteTokenName } from "./tokens.js";
import type { Palette, ThemeMode } from "./theme.js";

const chalk = new Chalk({ level: 3 });

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

export function getPaletteToken(name: PaletteTokenName): (typeof PALETTE_COLORS)[number] | undefined {
  return paletteByName.get(name);
}

export function createPalette(mode: ThemeMode): Palette {
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
