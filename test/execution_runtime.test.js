import { describe, expect, it, vi } from "vitest";
import { personas } from "../dist/core/personas.js";
import { createExecutionEnvironmentSubagentRuntimeResolver } from "../dist/host/execution_runtime.js";

function createPersona(overrides = {}) {
  return {
    id: "target-persona",
    label: "target persona",
    model: personas[0].model,
    systemPrompt: "target main instructions",
    settings: { reasoning: "high" },
    skills: "*",
    source: "project",
    subagents: {
      reviewer: {
        systemPrompt: "target reviewer instructions",
        tools: ["bash"],
      },
    },
    ...overrides,
  };
}

describe("execution environment subagent runtime resolver", () => {
  it("resolves target config, prompt context, and model catalog", async () => {
    const targetPersona = createPersona();
    const sessionPersona = createPersona({ systemPrompt: "session instructions" });
    const modelResolver = vi.fn();
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
      toolRegistry: {},
      promptBootstrap: {
        promptContext: {
          cwd: "/workspace/repo",
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
      },
    }));
    const executionEnvironment = {
      resolveRuntimeConfig: vi.fn(async () => ({
        bootstrap: { modelResolver: { resolveModel: modelResolver } },
        config,
        personas: [targetPersona],
        prompts: [],
        skills,
        themes: [],
        warnings: [],
      })),
      resolveRuntimeContext,
    };
    const resolveRuntime = createExecutionEnvironmentSubagentRuntimeResolver({
      executionEnvironment,
      includeAgentContext: true,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });

    const runtime = await resolveRuntime({
      cwd: "/workspace/repo",
      persona: sessionPersona,
    });

    expect(executionEnvironment.resolveRuntimeConfig).toHaveBeenCalledWith("/workspace/repo");
    expect(resolveRuntimeContext).toHaveBeenCalledWith({
      cwd: "/workspace/repo",
      persona: targetPersona,
      discoveredSkills: skills,
      includeAgentContext: true,
      agentContextFiles: config.agentContextFiles,
    });
    expect(runtime).toMatchObject({
      persona: targetPersona,
      config,
      modelResolver,
    });
    expect(runtime.subagentPrompts.reviewer).toContain("target reviewer instructions");
    expect(runtime.subagentPrompts.reviewer).toContain("target AGENTS context");
    expect(runtime.subagentPrompts.reviewer).toContain("target skill context");
    expect(runtime.subagentPrompts.reviewer).toContain("<cwd>/workspace/repo</cwd>");
    expect(runtime.subagentPrompts.reviewer).toContain("<platform>linux</platform>");
  });

  it("rejects a persona unavailable in the target working directory", async () => {
    const resolveRuntimeContext = vi.fn();
    const executionEnvironment = {
      resolveRuntimeConfig: vi.fn(async () => ({
        bootstrap: { modelResolver: { resolveModel: vi.fn() } },
        config: {},
        personas: [createPersona({ id: "other-persona" })],
        prompts: [],
        skills: [],
        themes: [],
        warnings: [],
      })),
      resolveRuntimeContext,
    };
    const resolveRuntime = createExecutionEnvironmentSubagentRuntimeResolver({
      executionEnvironment,
      includeAgentContext: true,
      now: () => 0,
    });

    await expect(
      resolveRuntime({ cwd: "/workspace/repo", persona: createPersona() }),
    ).rejects.toThrow(
      "persona 'target-persona' is not available for working directory '/workspace/repo'",
    );
    expect(resolveRuntimeContext).not.toHaveBeenCalled();
  });
});
