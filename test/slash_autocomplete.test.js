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
    async (query, limit) =>
      (options.files ?? []).filter((path) => path.includes(query)).slice(0, limit),
    () => options.skills ?? [],
    () => options.agents ?? [],
  );
}

async function getMentionValues(provider, text) {
  const suggestions = await provider.getSuggestions([text], 0, text.length, {
    signal: new AbortController().signal,
  });
  return suggestions ? suggestions.items.map((item) => item.value) : null;
}

async function getSlashValues(provider, text) {
  const suggestions = await provider.getSuggestions([text], 0, text.length, {
    signal: new AbortController().signal,
  });
  return suggestions ? suggestions.items.map((item) => item.value) : null;
}

describe("slash mention autocomplete", () => {
  it("uses @ as the default file mention syntax", async () => {
    const provider = createProvider({
      files: ["src/core.ts", "src/tui/session_chat_app.ts"],
    });

    expect(await getMentionValues(provider, "@")).toEqual([
      "src/core.ts",
      "src/tui/session_chat_app.ts",
    ]);
    expect(await getMentionValues(provider, "@src/tui")).toEqual(["src/tui/session_chat_app.ts"]);
  });

  it("uses @@ to suggest mention kinds and @@kind: to suggest entries", async () => {
    const provider = createProvider({
      files: ["src/core.ts"],
      skills: ["foo-skill", "bar-skill"],
      agents: ["default", "reviewer"],
    });

    expect(await getMentionValues(provider, "@@")).toEqual(["skill:", "agent:"]);
    expect(await getMentionValues(provider, "@@sk")).toEqual(["skill:"]);
    expect(await getMentionValues(provider, "@@skill:")).toEqual(["foo-skill", "bar-skill"]);
    expect(await getMentionValues(provider, "@@agent:d")).toEqual(["default"]);
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

  it("does not treat removed @file:/@skill:/@agent: forms as typed mentions", async () => {
    const provider = createProvider({
      files: ["src/core.ts"],
      skills: ["foo-skill"],
      agents: ["default"],
    });

    expect(await getMentionValues(provider, "@@file:")).toBeNull();
    expect(await getMentionValues(provider, "@skill:foo-skill")).toBeNull();
    expect(await getMentionValues(provider, "@agent:default")).toBeNull();
    expect(await getMentionValues(provider, "@file:src/core.ts")).toBeNull();
  });
});

describe("slash command autocomplete", () => {
  it("suggests the first-class /diff command", async () => {
    const provider = createProvider();

    expect(await getSlashValues(provider, "/di")).toContain("diff");
  });
});

describe("getFileAutocompleteToken", () => {
  it("returns tokens only for single-@ file mentions", () => {
    expect(getFileAutocompleteToken("@src/core.ts")).toBe("@src/core.ts");
    expect(getFileAutocompleteToken("@@skill:foo-skill")).toBeNull();
    expect(getFileAutocompleteToken("@@agent:default")).toBeNull();
  });
});
