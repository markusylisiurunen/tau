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
    skills: "*",
    source: "project",
    tools: ["bash", "spawn_agent"],
    subagents: {
      reviewer: {
        systemPrompt: "source reviewer instructions",
        tools: ["bash"],
      },
    },
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
      nodeVersion: "v24.1.0",
      includeAgentContext: true,
      skillsBlock: "### Skills\n\ntarget skill context",
      projectContextBlock: "### Project context\n\ntarget AGENTS context",
    },
    agentsFiles: ["/workspace/repo/docs/AGENTS.md"],
    unknownSkills: [],
  };
}

describe("execution environment subagent prompt resolver", () => {
  it("combines the source persona with target-directory prompt context", async () => {
    const sourcePersona = createPersona();
    const targetPersona = createPersona({
      systemPrompt: "conflicting target main instructions",
      settings: { reasoning: "low" },
      subagents: {
        reviewer: {
          systemPrompt: "conflicting target reviewer instructions",
          tools: ["web"],
        },
      },
    });
    const skills = [
      {
        name: "target-skill",
        description: "target skill",
        path: "/workspace/repo/.tau/skills/target-skill/SKILL.md",
      },
    ];
    const config = {
      agentContextFiles: ["/workspace/repo/docs/AGENTS.md"],
      modelSystemNotices: {},
    };
    const resolveRuntimeContext = vi.fn(async () => ({
      promptBootstrap: createPromptBootstrap(),
    }));
    const executionEnvironment = {
      resolveRuntimeConfig: vi.fn(async () => ({
        bootstrap: { modelResolver: { resolveModel: vi.fn() } },
        config,
        personas: [targetPersona],
        prompts: [],
        skills,
        themes: [],
        warnings: [],
      })),
      resolveRuntimeContext,
    };
    const resolvePrompts = createExecutionEnvironmentSubagentPromptResolver({
      executionEnvironment,
      includeAgentContext: true,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });

    const prompts = await resolvePrompts({
      cwd: "/workspace/repo",
      persona: sourcePersona,
    });

    expect(executionEnvironment.resolveRuntimeConfig).toHaveBeenCalledWith("/workspace/repo");
    expect(resolveRuntimeContext).toHaveBeenCalledWith({
      cwd: "/workspace/repo",
      persona: sourcePersona,
      discoveredSkills: skills,
      includeAgentContext: true,
      agentContextFiles: config.agentContextFiles,
    });
    expect(prompts.reviewer).toContain("source reviewer instructions");
    expect(prompts.reviewer).not.toContain("conflicting target reviewer instructions");
    expect(prompts.reviewer).toContain("target AGENTS context");
    expect(prompts.reviewer).toContain("target skill context");
    expect(prompts.reviewer).toContain("<cwd>/workspace/repo</cwd>");
    expect(prompts.reviewer).toContain("<platform>linux</platform>");
  });

  it("does not require the source persona to exist in the target catalog", async () => {
    const sourcePersona = createPersona();
    const resolveRuntimeContext = vi.fn(async () => ({
      promptBootstrap: createPromptBootstrap("/workspace/other"),
    }));
    const executionEnvironment = {
      resolveRuntimeConfig: vi.fn(async () => ({
        bootstrap: { modelResolver: { resolveModel: vi.fn() } },
        config: {},
        personas: [],
        prompts: [],
        skills: [],
        themes: [],
        warnings: [],
      })),
      resolveRuntimeContext,
    };
    const resolvePrompts = createExecutionEnvironmentSubagentPromptResolver({
      executionEnvironment,
      includeAgentContext: true,
      now: () => 0,
    });

    await expect(
      resolvePrompts({ cwd: "/workspace/other", persona: sourcePersona }),
    ).resolves.toEqual({
      reviewer: expect.stringContaining("source reviewer instructions"),
    });
    expect(resolveRuntimeContext).toHaveBeenCalledWith(
      expect.objectContaining({ persona: sourcePersona }),
    );
  });
});
