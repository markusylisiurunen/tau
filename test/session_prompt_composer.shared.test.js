import { describe, expect, it } from "vitest";
import { resolveModel } from "../dist/core/models/catalog.js";
import { composeSessionPrompts } from "../dist/core/runtime/session_prompt_composer.js";
import {
  buildProjectContextBlock,
  listProjectInstructionFiles,
  TAU_HARNESS_PROMPT,
} from "../dist/core/utils/context_builder.js";

const customPersona = {
  id: "custom",
  label: "custom",
  model: resolveModel("anthropic", "claude-sonnet-5-5"),
  systemPrompt: "Work as a release engineer.",
  settings: {},
  tools: ["bash", "agents"],
  subagentLaunchModels: [],
  source: "project",
};

describe("composeSessionPrompts", () => {
  it("adds Tau's harness section to a custom persona and keeps project files intact", () => {
    const projectContextBlock = buildProjectContextBlock({
      agentsFiles: ["/repo/AGENTS.md", "/repo/my `odd` dir/AGENTS.md"],
      childAgentsFiles: ["/repo/src/AGENTS.md"],
      readFile: (path) =>
        path === "/repo/AGENTS.md"
          ? "# Repo\n\n```sh\nnpm test\n```\n\n## Subagents\n\nNever delegate."
          : "Nested rules.",
    });

    const { baseSystemPrompt, subagentSystemPrompt } = composeSessionPrompts({
      persona: customPersona,
      sessionId: "session-1",
      cwd: "/repo",
      sessionStartedAt: "2026-11-18T09:30:00.000Z",
      platform: "linux",
      projectContextBlock,
    });

    for (const prompt of [baseSystemPrompt, subagentSystemPrompt]) {
      expect(prompt.startsWith(`${customPersona.systemPrompt}\n\n${TAU_HARNESS_PROMPT}`)).toBe(
        true,
      );
      expect(listProjectInstructionFiles(prompt)).toEqual([
        "/repo/AGENTS.md",
        "/repo/my `odd` dir/AGENTS.md",
      ]);
      // The file's own code fence and heading stay inside the block that quotes it.
      const fenced = prompt.match(/^(`{4,})markdown\n([\s\S]*?)\n\1$/m);
      expect(fenced?.[2]).toContain("```sh\nnpm test\n```\n\n## Subagents\n\nNever delegate.");
    }
    expect(baseSystemPrompt.trimEnd().endsWith("explicitly asks for a specific model.")).toBe(true);
  });
});
