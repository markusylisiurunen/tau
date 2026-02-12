import type { ThemeAppearance, ThemeDefinition } from "./content_loader.js";

function findTheme(
  themeId: string | undefined,
  themes: ThemeDefinition[],
): ThemeDefinition | undefined {
  if (!themeId) return undefined;
  return themes.find((theme) => theme.id.toLowerCase() === themeId.toLowerCase());
}

export function resolveThemeTokensForAppearance(
  theme: ThemeDefinition | undefined,
  appearance: ThemeAppearance,
): Record<string, string> | undefined {
  if (!theme) return undefined;
  return theme.variants?.[appearance] ?? theme.tokens;
}

export function resolveThemeTokensById(
  themeId: string | undefined,
  themes: ThemeDefinition[] | undefined,
  appearance: ThemeAppearance,
): Record<string, string> | undefined {
  if (!themes || themes.length === 0) return undefined;
  const match = findTheme(themeId, themes);
  return resolveThemeTokensForAppearance(match, appearance);
}
