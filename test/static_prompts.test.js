import { describe, expect, it } from "vitest";
import { renderSubagentPrefixPrompt } from "../dist/core/static/index.js";

describe("static prompts", () => {
  it("interpolates parent context into the subagent prefix", () => {
    const prompt = renderSubagentPrefixPrompt({
      historyEnabled: false,
      parentSessionId: "main system prompt",
    });

    expect(prompt).toContain("main system prompt");
    expect(prompt).not.toContain("{{parent_context}}");
  });

  it("includes the parent history API only when both parent identity and access are available", () => {
    for (const parentSessionId of [undefined, "parent-session"]) {
      for (const historyEnabled of [false, true]) {
        const prompt = renderSubagentPrefixPrompt({ parentSessionId, historyEnabled });
        expect(prompt.includes("tau.history.read")).toBe(
          Boolean(parentSessionId && historyEnabled),
        );
        expect(prompt.includes('source: "local"')).toBe(Boolean(parentSessionId && historyEnabled));
        expect(prompt.includes("parent-session")).toBe(Boolean(parentSessionId));
        expect(prompt).not.toContain("{{parent_context}}");
        expect(prompt.startsWith("<subagent-role>\n")).toBe(true);
        expect(prompt.endsWith("\n</subagent-role>")).toBe(true);
      }
    }
  });

  it("preserves literal replacement syntax characters", () => {
    const prompt = renderSubagentPrefixPrompt({
      historyEnabled: false,
      parentSessionId: "$& $$ $1",
    });

    expect(prompt).toContain("$& $$ $1");
  });

  it("allows placeholder-like text in replacement values", () => {
    const prompt = renderSubagentPrefixPrompt({
      historyEnabled: false,
      parentSessionId: "keep {{this}} literal",
    });

    expect(prompt).toContain("keep {{this}} literal");
  });
});
