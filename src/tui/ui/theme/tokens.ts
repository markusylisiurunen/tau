export interface ColorDef {
  name: string;
  h: number;
  s: number;
  l: number;
}

export const PALETTE_COLORS = [
  // Core
  { name: "brandAccent", h: 30, s: 56, l: 64 },
  { name: "textMuted", h: 26, s: 10, l: 58 },
  { name: "textDim", h: 26, s: 8, l: 42 },
  { name: "linkText", h: 172, s: 56, l: 48 },
  { name: "thinkingText", h: 26, s: 10, l: 58 },
  { name: "codeInlineText", h: 172, s: 56, l: 48 },
  { name: "codeBlockText", h: 172, s: 56, l: 48 },
  // Editor
  { name: "editorBorderNone", h: 26, s: 8, l: 42 },
  { name: "editorBorderMinimal", h: 27, s: 18, l: 46 },
  { name: "editorBorderLow", h: 28, s: 27, l: 51 },
  { name: "editorBorderMedium", h: 28, s: 37, l: 55 },
  { name: "editorBorderHigh", h: 29, s: 46, l: 60 },
  { name: "editorBorderXhigh", h: 30, s: 56, l: 64 },
  // Status
  { name: "statusWarn", h: 44, s: 52, l: 52 },
  { name: "statusError", h: 6, s: 52, l: 52 },
  { name: "modeMemory", h: 280, s: 60, l: 68 },
  { name: "modeBash", h: 210, s: 60, l: 68 },
  // Action
  { name: "actionRunning", h: 44, s: 54, l: 54 },
  { name: "actionSuccess", h: 98, s: 54, l: 54 },
  { name: "actionError", h: 6, s: 54, l: 54 },
  { name: "actionOutput", h: 26, s: 10, l: 58 },
  // Diff
  { name: "diffAdd", h: 98, s: 40, l: 44 },
  { name: "diffRemove", h: 6, s: 48, l: 50 },
  // Toasts
  { name: "toastSuccess", h: 98, s: 44, l: 46 },
  { name: "toastWarn", h: 44, s: 48, l: 52 },
  { name: "toastError", h: 6, s: 48, l: 52 },
  // Toast backgrounds
  { name: "toastSuccessBg", h: 98, s: 40, l: 20 },
  { name: "toastWarnBg", h: 44, s: 40, l: 20 },
  { name: "toastErrorBg", h: 6, s: 40, l: 20 },
  { name: "toastMutedBg", h: 26, s: 8, l: 20 },
  // User
  { name: "userSurface", h: 26, s: 6, l: 10 },
  { name: "userMemorySurface", h: 280, s: 16, l: 12 },
  { name: "userMemoryText", h: 280, s: 42, l: 84 },
  // Risk level indicators
  { name: "riskReadOnlyText", h: 98, s: 24, l: 48 },
  { name: "riskReadWriteText", h: 6, s: 24, l: 48 },
] as const satisfies readonly ColorDef[];

export type PaletteTokenName = (typeof PALETTE_COLORS)[number]["name"];
