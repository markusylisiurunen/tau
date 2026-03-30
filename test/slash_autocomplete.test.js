import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../dist/core/commands/index.js";
import {
  getFileAutocompleteToken,
  SlashAutocompleteProvider,
} from "../dist/tui/ui/slash_autocomplete.js";

function createProvider(options = {}) {
  return new SlashAutocompleteProvider(
    createCommandRegistry(),
    () => [],
    () => [],
    () => [],
    () => [],
    () => options.files ?? [],
    () => options.skills ?? [],
    () => options.agents ?? [],
    () => ["read-only", "read-write"],
  );
}

function getMentionValues(provider, text) {
  const suggestions = provider.getSuggestions([text], 0, text.length);
  return suggestions ? suggestions.items.map((item) => item.value) : null;
}

function getSlashValues(provider, text) {
  const suggestions = provider.getSuggestions([text], 0, text.length);
  return suggestions ? suggestions.items.map((item) => item.value) : null;
}

describe("slash mention autocomplete", () => {
  it("uses @ as the default file mention syntax", () => {
    const provider = createProvider({ files: ["src/core.ts", "src/tui/app.ts"] });

    expect(getMentionValues(provider, "@")).toEqual(["src/core.ts", "src/tui/app.ts"]);
    expect(getMentionValues(provider, "@src/tui")).toEqual(["src/tui/app.ts"]);
  });

  it("uses @@ to suggest mention kinds and @@kind: to suggest entries", () => {
    const provider = createProvider({
      files: ["src/core.ts"],
      skills: ["foo-skill", "bar-skill"],
      agents: ["default", "reviewer"],
    });

    expect(getMentionValues(provider, "@@")).toEqual(["skill:", "agent:"]);
    expect(getMentionValues(provider, "@@sk")).toEqual(["skill:"]);
    expect(getMentionValues(provider, "@@skill:")).toEqual(["foo-skill", "bar-skill"]);
    expect(getMentionValues(provider, "@@agent:d")).toEqual(["default"]);
  });

  it("inserts mentions using @path and @@kind:name", () => {
    const provider = createProvider({
      files: ["src/core.ts"],
      skills: ["foo-skill"],
      agents: ["default"],
    });

    const file = provider.applyCompletion(
      ["@"],
      0,
      1,
      { value: "src/core.ts", label: "src/core.ts" },
      "@",
    );
    expect(file.lines[0]).toBe("@src/core.ts ");

    const kind = provider.applyCompletion(["@@"], 0, 2, { value: "skill:", label: "skill" }, "@@");
    expect(kind.lines[0]).toBe("@@skill:");

    const entry = provider.applyCompletion(
      ["@@skill:"],
      0,
      8,
      { value: "foo-skill", label: "foo-skill" },
      "@@skill:",
    );
    expect(entry.lines[0]).toBe("@@skill:foo-skill ");
  });

  it("does not treat removed @file:/@skill:/@agent: forms as typed mentions", () => {
    const provider = createProvider({
      files: ["src/core.ts"],
      skills: ["foo-skill"],
      agents: ["default"],
    });

    expect(getMentionValues(provider, "@@file:")).toBeNull();
    expect(getMentionValues(provider, "@skill:foo-skill")).toBeNull();
    expect(getMentionValues(provider, "@agent:default")).toBeNull();
    expect(getMentionValues(provider, "@file:src/core.ts")).toBeNull();
  });
});

describe("slash command autocomplete", () => {
  it("suggests the first-class /diff command", () => {
    const provider = createProvider();

    expect(getSlashValues(provider, "/di")).toContain("diff");
  });
});

describe("getFileAutocompleteToken", () => {
  it("returns tokens only for single-@ file mentions", () => {
    expect(getFileAutocompleteToken("@src/core.ts")).toBe("@src/core.ts");
    expect(getFileAutocompleteToken("@@skill:foo-skill")).toBeNull();
    expect(getFileAutocompleteToken("@@agent:default")).toBeNull();
  });
});
