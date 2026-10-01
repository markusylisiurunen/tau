import { describe, expect, it, vi } from "vitest";
import { personas } from "../dist/core/personas.js";
import { createExecutionEnvironmentSubagentPromptResolver } from "../dist/host/execution_runtime.js";

function createPersona(overrides = {}) {
  return {
    id: "target-persona",
    label: "target persona",
    model: personas[0].model,
    systemPrompt: "source main instructions",
    settings: { reasoning: "high" },
    source: "project",
    tools: ["bash", "spawn_agent"],
    subagentLaunchModels: [],
    ...overrides,
  };
}

function createPromptBootstrap(cwd = "/workspace/repo") {
  return {
    promptContext: {
      cwd,
      home: "/workspace",
      repoRoot: "/workspace/repo",
      platform: "linux",
      includeAgentContext: true,
      skillsBlock: "### Skills\n\ntarget skill context",
      projectContextBlock: "### Project context\n\ntarget AGENTS context",
    },
    agentsFiles: ["/workspace/repo/docs/AGENTS.md"],
  };
}

describe("execution environment subagent prompt resolver", () => {
  it("combines the source persona with target-directory prompt context", async () => {
    const sourcePersona = createPersona();
    const skills = [
      {
        name: "target-skill",
        description: "target skill",
        path: "/workspace/repo/.tau/skills/target-skill/SKILL.md",
      },
    ];
    const resolveRuntimeContext = vi.fn(async () => ({
      promptBootstrap: createPromptBootstrap(),
    }));
    const executionEnvironment = {
      resolveRuntimeConfig: vi.fn(() => {
        throw new Error("must not load runtime config");
      }),
      snapshot: () => ({ home: "/workspace" }),
      getToolExecutionBackend: () => ({
        runNodeScript: vi.fn(async () => ({
          exitCode: 0,
          output: JSON.stringify({
            files: [
              {
                path: skills[0].path,
                content: "---\nname: target-skill\ndescription: target skill\n---\n",
              },
            ],
          }),
          truncated: false,
        })),
      }),
      resolveRuntimeContext,
    };
    const resolvePrompts = createExecutionEnvironmentSubagentPromptResolver({
      sessionId: "session-1",
      executionEnvironment,
      includeAgentContext: true,
      sessionStartedAt: Date.parse("2026-01-01T00:00:00.000Z"),
    });

    const prompts = await resolvePrompts({
      cwd: "/workspace/repo",
      persona: sourcePersona,
    });

    expect(executionEnvironment.resolveRuntimeConfig).not.toHaveBeenCalled();
    expect(resolveRuntimeContext).toHaveBeenCalledWith({
      cwd: "/workspace/repo",
      discoveredSkills: skills,
      includeAgentContext: true,
    });
    expect(prompts).toContain("source main instructions");
    expect(prompts).not.toContain("conflicting target main instructions");
    expect(prompts).toContain("target AGENTS context");
    expect(prompts).toContain("target skill context");
    expect(prompts).toContain("- Current working directory: `/workspace/repo`");
    expect(prompts).toContain("- Platform: Linux");
  });

  it("does not require the source persona to exist in the target catalog", async () => {
    const sourcePersona = createPersona();
    const resolveRuntimeContext = vi.fn(async () => ({
      promptBootstrap: createPromptBootstrap("/workspace/other"),
    }));
    const executionEnvironment = {
      snapshot: () => ({ home: "/workspace" }),
      getToolExecutionBackend: () => ({
        runNodeScript: async () => ({ exitCode: 0, output: '{"files":[]}', truncated: false }),
      }),
      resolveRuntimeContext,
    };
    const resolvePrompts = createExecutionEnvironmentSubagentPromptResolver({
      sessionId: "session-1",
      executionEnvironment,
      includeAgentContext: true,
      sessionStartedAt: 0,
    });

    await expect(
      resolvePrompts({ cwd: "/workspace/other", persona: sourcePersona }),
    ).resolves.toEqual(expect.stringContaining("source main instructions"));
    expect(resolveRuntimeContext).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/workspace/other" }),
    );
  });
});
