import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { personas } from "../dist/core/personas.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { createSpawnAgentToolDefinition } from "../dist/core/tools/spawn_agent.js";
import { TOOL_NAME_SPAWN_AGENT } from "../dist/core/tools/tool_names.js";

function getText(toolResult) {
  const textBlock = toolResult.content.find((block) => block.type === "text");
  return textBlock?.text ?? "";
}

function createModels() {
  const anthropic = personas.find((persona) => persona.model.provider === "anthropic")?.model;
  const openai = personas.find((persona) => persona.model.provider === "openai")?.model;
  expect(anthropic).toBeTruthy();
  expect(openai).toBeTruthy();
  return { anthropic, openai };
}

function createContext(overrides = {}) {
  const { anthropic, openai } = createModels();
  const spawned = [];

  const context = {
    persona: {
      id: "test-persona",
      label: "test persona",
      model: anthropic,
      systemPrompt: "main",
      settings: { reasoning: "low" },
      source: "project",
      subagents: {
        default: {
          launchModels: ["openai/gpt-5.2:high"],
        },
        researcher: {
          systemPrompt: "research",
          model: anthropic,
          settings: { reasoning: "medium" },
          launchModels: ["openai/gpt-5.2:high"],
        },
      },
    },
    riskLevel: "read-only",
    subagentPrompts: {
      default: "default prompt",
      researcher: "research prompt",
    },
    cwd: "/repo/current",
    hostCwd: "/repo/current",
    home: "/repo",
    includeAgentContext: false,
    sandboxEnabled: false,
    subagentControlPlane: {
      spawn: ({ runtimeConfig }) => {
        spawned.push(runtimeConfig);
        return { ok: true, id: "agent-1" };
      },
    },
    ...overrides,
  };

  return { context, anthropic, openai, spawned };
}

describe("spawn_agent tool", () => {
  it("accepts an allowed launch model override", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { context, openai, spawned } = createContext();

    const dispatched = await tool.dispatch(
      {
        id: "call-1",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
          model: "openai/gpt-5.2:high",
        },
      },
      "read-only",
      undefined,
      context,
    );

    expect(dispatched.kind).toBe("phased");
    const result = await dispatched.run;
    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(false);
    expect(result.uiEvent.type).toBe("spawn_agent_finished");
    expect(result.uiEvent.uiText.statusLine).toContain("openai/gpt-5.2:high");
    expect(spawned).toHaveLength(1);
    expect(spawned[0].model.provider).toBe(openai.provider);
    expect(spawned[0].model.id).toBe(openai.id);
    expect(spawned[0].settings.reasoning).toBe("high");
  });

  it("shows the launch model override in status when it matches the persona model", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { openai } = createModels();
    const { context } = createContext({
      persona: {
        id: "test-persona",
        label: "test persona",
        model: openai,
        systemPrompt: "main",
        settings: { reasoning: "low" },
        source: "project",
        subagents: {
          researcher: {
            systemPrompt: "research",
            model: openai,
            settings: { reasoning: "medium" },
            launchModels: ["openai/gpt-5.2:high"],
          },
        },
      },
      subagentPrompts: {
        researcher: "research prompt",
      },
    });

    const dispatched = await tool.dispatch(
      {
        id: "call-1b",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
          model: "openai/gpt-5.2:high",
        },
      },
      "read-only",
      undefined,
      context,
    );

    expect(dispatched.kind).toBe("phased");
    const result = await dispatched.run;
    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(false);
    expect(result.uiEvent.type).toBe("spawn_agent_finished");
    expect(result.uiEvent.uiText.statusLine).toContain("openai/gpt-5.2:high");
  });

  it("blocks launch model overrides when no allowlist exists", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { context } = createContext({
      persona: {
        id: "test-persona",
        label: "test persona",
        model: createModels().anthropic,
        systemPrompt: "main",
        settings: { reasoning: "low" },
        source: "project",
        subagents: {
          researcher: {
            systemPrompt: "research",
          },
        },
      },
      subagentPrompts: {
        researcher: "research prompt",
      },
    });

    const result = await tool.dispatch(
      {
        id: "call-2",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
          model: "openai/gpt-5.2:high",
        },
      },
      "read-only",
      undefined,
      context,
    );

    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(true);
    expect(getText(result.toolResult)).toContain("does not allow launch model overrides");
  });

  it("blocks launch model overrides outside the allowlist", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { context, spawned } = createContext();

    const result = await tool.dispatch(
      {
        id: "call-3",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
          model: "openai/gpt-5.2:low",
        },
      },
      "read-only",
      undefined,
      context,
    );

    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(true);
    expect(getText(result.toolResult)).toContain("is not allowed for subagent");
    expect(getText(result.toolResult)).toContain("openai/gpt-5.2:high");
    expect(spawned).toHaveLength(0);
  });

  it("keeps default behavior when no launch model override is provided", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { context, anthropic, spawned } = createContext();

    const dispatched = await tool.dispatch(
      {
        id: "call-4",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
        },
      },
      "read-only",
      undefined,
      context,
    );

    expect(dispatched.kind).toBe("phased");
    const result = await dispatched.run;
    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(false);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].model.provider).toBe(anthropic.provider);
    expect(spawned[0].model.id).toBe(anthropic.id);
    expect(spawned[0].settings.reasoning).toBe("medium");
  });

  it("supports launch model overrides on the default subagent", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { context, openai, spawned } = createContext();

    const dispatched = await tool.dispatch(
      {
        id: "call-5",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "default",
          title: "default task",
          prompt: "collect findings",
          model: "openai/gpt-5.2:high",
        },
      },
      "read-only",
      undefined,
      context,
    );

    expect(dispatched.kind).toBe("phased");
    await dispatched.run;
    expect(spawned).toHaveLength(1);
    expect(spawned[0].model.provider).toBe(openai.provider);
    expect(spawned[0].model.id).toBe(openai.id);
    expect(spawned[0].settings.reasoning).toBe("high");
  });

  it("rejects an explicitly provided but empty model parameter", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { context, spawned } = createContext();

    const result = await tool.dispatch(
      {
        id: "call-6",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
          model: "",
        },
      },
      "read-only",
      undefined,
      context,
    );

    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(true);
    expect(getText(result.toolResult)).toContain("model parameter must be a non-empty string");
    expect(spawned).toHaveLength(0);
  });

  it("rejects an explicitly provided but empty workingDirectory parameter", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { context, spawned } = createContext();

    const result = await tool.dispatch(
      {
        id: "call-7",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
          workingDirectory: "",
        },
      },
      "read-only",
      undefined,
      context,
    );

    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(true);
    expect(getText(result.toolResult)).toContain(
      "workingDirectory parameter must be a non-empty string",
    );
    expect(spawned).toHaveLength(0);
  });

  it("rejects absolute workingDirectory outside sandbox mount", async () => {
    const backend = createLocalToolExecutionBackend();
    const tool = createSpawnAgentToolDefinition(backend);
    const { context, spawned } = createContext({
      cwd: "/workspace/src",
      hostCwd: "/home/user/repo/src",
      sandboxEnabled: true,
      config: {
        sandbox: {
          mountPath: "/workspace",
        },
      },
    });

    const result = await tool.dispatch(
      {
        id: "call-8",
        name: TOOL_NAME_SPAWN_AGENT,
        arguments: {
          name: "researcher",
          title: "research task",
          prompt: "collect findings",
          workingDirectory: "/tmp",
        },
      },
      "read-only",
      undefined,
      context,
    );

    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(true);
    expect(getText(result.toolResult)).toContain("is outside sandbox mount path");
    expect(spawned).toHaveLength(0);
  });

  it("rebuilds subagent prompt context for workingDirectory", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "tau-spawn-agent-"));
    const projectRoot = join(tmpRoot, "project");
    const skillDir = join(projectRoot, ".tau", "skills", "scoped-skill");
    const invalidSkillDir = join(projectRoot, ".tau", "skills", "bad--skill");
    const sourceDir = join(projectRoot, "src");

    mkdirSync(skillDir, { recursive: true });
    mkdirSync(invalidSkillDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "name: scoped-skill", "description: scoped helper", "---", "", "body"].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(invalidSkillDir, "SKILL.md"),
      ["---", "name: bad--skill", "description: invalid helper", "---", "", "body"].join("\n"),
      "utf-8",
    );
    writeFileSync(join(projectRoot, "AGENTS.md"), "project context marker\n", "utf-8");

    try {
      const backend = createLocalToolExecutionBackend();
      const tool = createSpawnAgentToolDefinition(backend);
      const base = createContext();
      const { context, spawned } = createContext({
        cwd: sourceDir,
        hostCwd: sourceDir,
        home: tmpRoot,
        includeAgentContext: true,
        persona: {
          ...base.context.persona,
          skills: ["scoped-skill", "bad--skill"],
        },
      });

      const dispatched = await tool.dispatch(
        {
          id: "call-9",
          name: TOOL_NAME_SPAWN_AGENT,
          arguments: {
            name: "researcher",
            title: "research task",
            prompt: "collect findings",
            workingDirectory: "..",
          },
        },
        "read-only",
        undefined,
        context,
      );

      expect(dispatched.kind).toBe("phased");
      const result = await dispatched.run;
      expect(result.kind).toBe("single");
      expect(result.toolResult.isError).toBe(false);
      expect(spawned).toHaveLength(1);
      expect(spawned[0].workingDirectory).toBe(projectRoot);
      expect(spawned[0].systemPrompt).toContain(`<cwd>${projectRoot}</cwd>`);
      expect(spawned[0].systemPrompt).toContain("project context marker");
      expect(spawned[0].systemPrompt).toContain("<available-skills>");
      expect(spawned[0].systemPrompt).toContain("<name>scoped-skill</name>");
      expect(spawned[0].systemPrompt).not.toContain("<name>bad--skill</name>");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("keeps the resolved sandbox workingDirectory in subagent prompt context", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "tau-spawn-agent-sandbox-"));
    const sourceDir = join(tmpRoot, "plain-dir", "src");
    mkdirSync(sourceDir, { recursive: true });

    try {
      const backend = createLocalToolExecutionBackend();
      const tool = createSpawnAgentToolDefinition(backend);
      const { context, spawned } = createContext({
        cwd: "/workspace/src",
        hostCwd: sourceDir,
        home: tmpRoot,
        sandboxEnabled: true,
        config: {
          sandbox: {
            mountPath: "/workspace",
          },
        },
      });

      const dispatched = await tool.dispatch(
        {
          id: "call-10",
          name: TOOL_NAME_SPAWN_AGENT,
          arguments: {
            name: "researcher",
            title: "research task",
            prompt: "collect findings",
            workingDirectory: ".",
          },
        },
        "read-only",
        undefined,
        context,
      );

      expect(dispatched.kind).toBe("phased");
      const result = await dispatched.run;
      expect(result.kind).toBe("single");
      expect(result.toolResult.isError).toBe(false);
      expect(spawned).toHaveLength(1);
      expect(spawned[0].workingDirectory).toBe("/workspace/src");
      expect(spawned[0].systemPrompt).toContain("<cwd>/workspace/src</cwd>");
      expect(spawned[0].systemPrompt).not.toContain("<cwd>/workspace</cwd>");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
