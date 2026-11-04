import { describe, expect, it } from "vitest";
import { renderSubagentPrefixPrompt } from "../dist/core/static/index.js";

describe("static prompts", () => {
  it("includes ordered session ancestry with conditional history access", () => {
    for (const sessionIds of [
      ["main-session", "child-session"],
      ["main-session", "parent-session", "child-session"],
    ]) {
      for (const historyEnabled of [false, true]) {
        const prompt = renderSubagentPrefixPrompt({ sessionIds, historyEnabled });
        expect(prompt.includes("tau.history.read")).toBe(historyEnabled);
        expect(prompt.includes('source: "local"')).toBe(historyEnabled);
        let previous = -1;
        for (const id of sessionIds) {
          const position = prompt.indexOf(id);
          expect(position).toBeGreaterThan(previous);
          previous = position;
        }
        expect(prompt).not.toMatch(/\{\{[a-z_-]+\}\}/);
        expect(prompt.startsWith("<subagent-role>\n")).toBe(true);
        expect(prompt.endsWith("\n</subagent-role>")).toBe(true);
      }
    }
  });

  it("preserves literal replacement syntax characters", () => {
    const prompt = renderSubagentPrefixPrompt({
      historyEnabled: false,
      sessionIds: ["$& $$ $1", "child-session"],
    });

    expect(prompt).toContain("$& $$ $1");
  });

  it("allows placeholder-like text in replacement values", () => {
    const prompt = renderSubagentPrefixPrompt({
      historyEnabled: false,
      sessionIds: ["keep {{this}} literal", "child-session"],
    });

    expect(prompt).toContain("keep {{this}} literal");
  });
});
