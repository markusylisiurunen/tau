import { describe, expect, it } from "vitest";
import {
  resolveThemeTokensById,
  resolveThemeTokensForAppearance,
} from "../dist/core/config/theme_variants.js";

describe("theme variants", () => {
  it("resolves appearance-specific tokens when available", () => {
    const darkTokens = { brandAccent: "#111111" };
    const lightTokens = { brandAccent: "#eeeeee" };
    const theme = {
      id: "gold",
      tokens: darkTokens,
      variants: {
        dark: darkTokens,
        light: lightTokens,
      },
    };

    expect(resolveThemeTokensForAppearance(theme, "dark")).toEqual(darkTokens);
    expect(resolveThemeTokensForAppearance(theme, "light")).toEqual(lightTokens);
  });

  it("finds theme ids by exact match", () => {
    const darkTokens = { brandAccent: "#111111" };
    const lightTokens = { brandAccent: "#eeeeee" };
    const themes = [
      {
        id: "gold",
        tokens: darkTokens,
        variants: {
          dark: darkTokens,
          light: lightTokens,
        },
      },
    ];

    expect(resolveThemeTokensById("gold", themes, "dark")).toEqual(darkTokens);
    expect(resolveThemeTokensById("GOLD", themes, "light")).toBeUndefined();
    expect(resolveThemeTokensById("missing", themes, "dark")).toBeUndefined();
  });
});
