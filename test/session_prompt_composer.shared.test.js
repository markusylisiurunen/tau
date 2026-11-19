import { describe, expect, it } from "vitest";
import { mainAgentCapabilities } from "../dist/core/agent/capabilities.js";
import { resolveModel } from "../dist/core/models/catalog.js";
import { formatModelPromptNotes } from "../dist/core/runtime/model_prompt_notes.js";
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
      capabilities: mainAgentCapabilities({ notifications: true, config: {} }),
      sessionId: "session-1",
      cwd: "/repo",
      sessionStartedAt: "2026-11-18T09:30:00.000Z",
      platform: "linux",
      projectContextBlock,
      mcpServers: [{ name: "tracker", description: "Issues\nand projects" }],
    });

    for (const prompt of [baseSystemPrompt, subagentSystemPrompt]) {
      expect(prompt.startsWith(`${customPersona.systemPrompt}\n\n${TAU_HARNESS_PROMPT}`)).toBe(
        true,
      );
      expect(listProjectInstructionFiles(prompt)).toEqual([
        "/repo/AGENTS.md",
        "/repo/my `odd` dir/AGENTS.md",
      ]);
      expect(prompt).toContain("- `tracker`: Issues and projects");
      // The file's own code fence and heading stay inside the block that quotes it.
      const fenced = prompt.match(/^(`{4,})markdown\n([\s\S]*?)\n\1$/m);
      expect(fenced?.[2]).toContain("```sh\nnpm test\n```\n\n## Subagents\n\nNever delegate.");
    }
  });

  it("adds GPT-6 notes to the main prompt only for GPT-6 models on OpenAI routes, and leaves subagents to add their own", () => {
    const compose = (model) =>
      composeSessionPrompts({
        persona: { ...customPersona, model },
        capabilities: mainAgentCapabilities({ notifications: true, config: {} }),
        cwd: "/repo",
        sessionStartedAt: "2026-11-18T09:30:00.000Z",
        platform: "linux",
        mcpServers: [],
      });
    const notes = formatModelPromptNotes({ provider: "openai-codex", id: "gpt-6.2-sol" });
    const { baseSystemPrompt, subagentSystemPrompt } = compose({
      ...customPersona.model,
      provider: "openai-codex",
      id: "gpt-6.2-sol",
    });

    expect(notes).toContain("gpt-6.2-sol");
    expect(baseSystemPrompt.endsWith(notes)).toBe(true);
    expect(subagentSystemPrompt).not.toContain(notes);
    for (const id of ["gpt-6-astra", "gpt-6-luna", "gpt-6.1-terra", "gpt-6.2-astra"])
      expect(formatModelPromptNotes({ provider: "openai", id })).toContain(id);
    for (const model of [
      { provider: "openai", id: "gpt-5.6-sol" },
      { provider: "openrouter", id: "gpt-6.2-sol" },
      { provider: "anthropic", id: "claude-sonnet-5-5" },
    ])
      expect(formatModelPromptNotes(model)).toBeUndefined();
  });
});
