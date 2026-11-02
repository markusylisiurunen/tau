import { describe, expect, it } from "vitest";
import { resolvePersonaSelection } from "../dist/core/persona_selection.js";

const personas = [
  {
    id: "reasoning",
    model: { reasoning: true },
    settings: { reasoning: "medium" },
    allowedReasoningLevels: ["low", "medium", "high"],
  },
  { id: "plain", model: { reasoning: false }, settings: {} },
];

describe("persona selection", () => {
  it("resolves workspace defaults once and isolates explicit persona applications", () => {
    expect(resolvePersonaSelection(personas, "reasoning:high", null).settings.reasoning).toBe(
      "high",
    );
    expect(
      resolvePersonaSelection(personas, "reasoning:high", "reasoning").settings.reasoning,
    ).toBe("medium");
    expect(
      resolvePersonaSelection(personas, "reasoning:high", "reasoning", { reasoning: "low" })
        .settings.reasoning,
    ).toBe("low");
    expect(personas[0].settings.reasoning).toBe("medium");
    expect(resolvePersonaSelection(personas, undefined, null).id).toBe("reasoning");
    expect(
      resolvePersonaSelection(personas, undefined, "plain").settings.reasoning,
    ).toBeUndefined();
  });

  it("rejects invalid selections before modifying definitions", () => {
    const before = structuredClone(personas);
    for (const [id, overrides] of [
      ["missing", {}],
      ["plain", { reasoning: "high" }],
      ["reasoning", { reasoning: "xhigh" }],
      ["reasoning", { autoCompactThresholdTokens: 49999 }],
      [null, { reasoning: "low" }],
    ]) {
      expect(() => resolvePersonaSelection(personas, "reasoning", id, overrides)).toThrow();
    }
    expect(() => resolvePersonaSelection(personas, "missing", null)).toThrow();
    expect(personas).toEqual(before);
    expect(
      resolvePersonaSelection(personas, undefined, "plain", { reasoning: "none" }).settings
        .reasoning,
    ).toBe("none");
  });
});
