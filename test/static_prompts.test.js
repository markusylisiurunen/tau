import { describe, expect, it } from "vitest";
import { renderSubagentWrapperPrompt } from "../dist/core/static/index.js";

describe("static prompts", () => {
  it("interpolates inherited main prompt into the subagent wrapper", () => {
    const prompt = renderSubagentWrapperPrompt({
      inheritedInstructions: "main system prompt",
    });

    expect(prompt).toContain("You are a subagent supporting the main agent.");
    expect(prompt).toContain("main system prompt");
    expect(prompt).not.toContain("{{inherited_instructions}}");
  });

  it("preserves literal replacement syntax characters", () => {
    const prompt = renderSubagentWrapperPrompt({
      inheritedInstructions: "$& $$ $1",
    });

    expect(prompt).toContain("$& $$ $1");
  });

  it("allows placeholder-like text in replacement values", () => {
    const prompt = renderSubagentWrapperPrompt({
      inheritedInstructions: "keep {{this}} literal",
    });

    expect(prompt).toContain("keep {{this}} literal");
  });
});
