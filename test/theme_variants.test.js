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
      sourcePath: "builtin:themes/gold.json",
      scope: "builtin",
    };

    expect(resolveThemeTokensForAppearance(theme, "dark")).toEqual(darkTokens);
    expect(resolveThemeTokensForAppearance(theme, "light")).toEqual(lightTokens);
  });

  it("falls back to base tokens when theme has no variants", () => {
    const tokens = { brandAccent: "#123456" };
    const theme = {
      id: "custom",
      tokens,
      sourcePath: "/tmp/custom.json",
      scope: "project",
    };

    expect(resolveThemeTokensForAppearance(theme, "dark")).toEqual(tokens);
    expect(resolveThemeTokensForAppearance(theme, "light")).toEqual(tokens);
  });

  it("finds theme ids case-insensitively", () => {
    const darkTokens = { brandAccent: "#111111" };
    const lightTokens = { brandAccent: "#eeeeee" };
    const themes = [
      {
        id: "Gold",
        tokens: darkTokens,
        variants: {
          dark: darkTokens,
          light: lightTokens,
        },
        sourcePath: "builtin:themes/gold.json",
        scope: "builtin",
      },
    ];

    expect(resolveThemeTokensById("gold", themes, "dark")).toEqual(darkTokens);
    expect(resolveThemeTokensById("GOLD", themes, "light")).toEqual(lightTokens);
    expect(resolveThemeTokensById("missing", themes, "dark")).toBeUndefined();
  });
});
