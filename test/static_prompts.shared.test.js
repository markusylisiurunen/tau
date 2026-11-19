import { describe, expect, it } from "vitest";
import { renderSubagentPrefixPrompt } from "../dist/core/static/index.js";

describe("static prompts", () => {
  it("includes ordered session ancestry", () => {
    for (const sessionIds of [
      ["main-session", "child-session"],
      ["main-session", "parent-session", "child-session"],
    ]) {
      const prompt = renderSubagentPrefixPrompt({ sessionIds });
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
  });
});
