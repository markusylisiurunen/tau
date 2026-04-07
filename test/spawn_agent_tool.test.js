import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigLevels } from "../dist/core/config/index.js";
import { loadModelResolver } from "../dist/core/models/catalog.js";
import { personas } from "../dist/core/personas.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { createSpawnAgentToolDefinition } from "../dist/core/tools/spawn_agent.js";
import { TOOL_NAME_SPAWN_AGENT } from "../dist/core/tools/tool_names.js";

function getText(toolResult) {
  const textBlock = toolResult.content.find((block) => block.type === "text");
  return textBlock?.text ?? "";
}

function createModels() {
  const anthropic = personas.find((persona) => persona.id === "opus-4.6-chat")?.model;
  const openai = personas.find((persona) => persona.id === "gpt-5.4-chat")?.model;
  expect(anthropic).toBeTruthy();
  expect(openai).toBeTruthy();
  return { anthropic, openai };
}

function createModelResolver(cwd, home) {
  const deps = {
    fs: {
      readFile: (path) => readFileSync(path, "utf-8"),
      exists: (path) => existsSync(path),
      listDir: (path) => readdirSync(path),
      stat: (path) => statSync(path),
    },
    env: {
      getEnv: () => ({}),
      cwd: () => cwd,
      home: () => home,
    },
  };
  const levels = resolveConfigLevels(deps, { cwd });

  return loadModelResolver({ deps, levels }).resolveModel;
}

function createContext(overrides = {}) {
  const { anthropic, openai } = createModels();
  const spawned = [];
  const baseCwd = overrides.cwd ?? "/repo/current";
  const baseHome = overrides.home ?? "/repo";

  const context = {
    scope: "main",
    modelResolver: createModelResolver(baseCwd, baseHome),
    persona: {
      id: "test-persona",
      label: "test persona",
      model: anthropic,
      systemPrompt: "main",
      settings: { reasoning: "low" },
      skills: "*",
      source: "project",
      subagents: {
        default: {
          launchModels: ["openai/gpt-5.4:high"],
        },
        researcher: {
          systemPrompt: "research",
          model: anthropic,
          settings: { reasoning: "medium" },
          launchModels: ["openai/gpt-5.4:high"],
        },
      },
    },
    riskLevel: "read-only",
    subagentPrompts: {
      default: "default prompt",
      researcher: "research prompt",
    },
    cwd: baseCwd,
    hostCwd: baseCwd,
    home: baseHome,
    config: {},
    toolRegistry: { schemas: [] },
    authPath: "/tmp/auth.json",
    tokenCounter: {
      method: "heuristic",
      countTextTokens: async () => 0,
      truncateTextToTokens: async (content, options) => ({
        content,
        truncated: false,
        truncatedBy: null,
        totalLines: content ? content.split("\n").length : 0,
        totalBytes: Buffer.byteLength(content, "utf-8"),
        outputLines: content ? content.split("\n").length : 0,
        outputBytes: Buffer.byteLength(content, "utf-8"),
        maxLines: content ? content.split("\n").length : 0,
        maxTokens: options.maxTokens,
        totalTokens: 0,
        outputTokens: 0,
        truncatedTokens: 0,
      }),
    },
    includeAgentContext: false,
    sandboxEnabled: false,
    turnUserHistoryEntryId: "history-1",
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
          model: "openai/gpt-5.4:high",
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
    expect(result.uiEvent.uiText.statusLine).toContain("openai/gpt-5.4:high");
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
            launchModels: ["openai/gpt-5.4:high"],
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
          model: "openai/gpt-5.4:high",
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
    expect(result.uiEvent.uiText.statusLine).toContain("openai/gpt-5.4:high");
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
          model: "openai/gpt-5.4:high",
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
          model: "openai/gpt-5.4:low",
        },
      },
      "read-only",
      undefined,
      context,
    );

    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(true);
    expect(getText(result.toolResult)).toContain("is not allowed for subagent");
    expect(getText(result.toolResult)).toContain("openai/gpt-5.4:high");
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
          model: "openai/gpt-5.4:high",
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
    expect(getText(result.toolResult)).toContain("Invalid arguments: model:");
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
    expect(getText(result.toolResult)).toContain("Invalid arguments: workingDirectory:");
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

  it("rejects relative workingDirectory that escapes sandbox mount", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "tau-spawn-agent-sandbox-escape-"));
    const hostSourceDir = join(tmpRoot, "mounted-root", "src");
    mkdirSync(hostSourceDir, { recursive: true });

    try {
      const backend = createLocalToolExecutionBackend();
      const tool = createSpawnAgentToolDefinition(backend);
      const { context, spawned } = createContext({
        cwd: "/workspace",
        hostCwd: hostSourceDir,
        sandboxEnabled: true,
        config: {
          sandbox: {
            mountPath: "/workspace",
          },
        },
      });

      const result = await tool.dispatch(
        {
          id: "call-8b",
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

      expect(result.kind).toBe("single");
      expect(result.toolResult.isError).toBe(true);
      expect(getText(result.toolResult)).toContain("is outside sandbox mount path");
      expect(spawned).toHaveLength(0);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("rebuilds subagent prompt context for workingDirectory", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "tau-spawn-agent-"));
    const projectRoot = join(tmpRoot, "project");
    const skillDir = join(projectRoot, ".tau", "skills", "scoped-skill");
    const sourceDir = join(projectRoot, "src");

    mkdirSync(skillDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "name: scoped-skill", "description: scoped helper", "---", "", "body"].join("\n"),
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
          skills: ["scoped-skill"],
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
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("reports skill-loading diagnostics when workingDirectory prompt rebuild finds invalid skills", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "tau-spawn-agent-invalid-skill-"));
    const projectRoot = join(tmpRoot, "project");
    const invalidSkillDir = join(projectRoot, ".tau", "skills", "bad--skill");
    const sourceDir = join(projectRoot, "src");

    mkdirSync(invalidSkillDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(invalidSkillDir, "SKILL.md"),
      ["---", "name: bad--skill", "description: invalid helper", "---", "", "body"].join("\n"),
      "utf-8",
    );

    try {
      const backend = createLocalToolExecutionBackend();
      const tool = createSpawnAgentToolDefinition(backend);
      const { context, spawned } = createContext({
        cwd: sourceDir,
        hostCwd: sourceDir,
        home: tmpRoot,
      });

      const result = await tool.dispatch(
        {
          id: "call-9b",
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

      expect(result.kind).toBe("single");
      expect(result.toolResult.isError).toBe(true);
      expect(getText(result.toolResult)).toContain("Failed to build the subagent prompt");
      expect(getText(result.toolResult)).toContain("Failed to load skills for prompt context");
      expect(getText(result.toolResult)).toContain("invalid frontmatter");
      expect(spawned).toHaveLength(0);
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

  it("limits sandbox prompt AGENTS and skills to mounted host root", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "tau-spawn-agent-sandbox-scope-"));
    const hostRoot = join(tmpRoot, "mounted-root");
    const hostSourceDir = join(hostRoot, "src");

    mkdirSync(hostSourceDir, { recursive: true });
    mkdirSync(join(hostRoot, ".tau", "skills", "in-scope"), { recursive: true });
    mkdirSync(join(tmpRoot, ".tau", "skills", "out-of-scope"), { recursive: true });
    writeFileSync(join(hostRoot, "AGENTS.md"), "mounted agents\n", "utf-8");
    writeFileSync(join(tmpRoot, "AGENTS.md"), "outside agents\n", "utf-8");
    writeFileSync(
      join(hostRoot, ".tau", "skills", "in-scope", "SKILL.md"),
      ["---", "name: in-scope", "description: mounted skill", "---", "", "body"].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(tmpRoot, ".tau", "skills", "out-of-scope", "SKILL.md"),
      ["---", "name: out-of-scope", "description: outside skill", "---", "", "body"].join("\n"),
      "utf-8",
    );

    try {
      const backend = createLocalToolExecutionBackend();
      const tool = createSpawnAgentToolDefinition(backend);
      const base = createContext();
      const { context, spawned } = createContext({
        cwd: "/workspace/src",
        hostCwd: hostSourceDir,
        home: tmpRoot,
        includeAgentContext: true,
        sandboxEnabled: true,
        config: {
          sandbox: {
            mountPath: "/workspace",
          },
        },
        persona: {
          ...base.context.persona,
          skills: ["in-scope", "out-of-scope"],
        },
      });

      const dispatched = await tool.dispatch(
        {
          id: "call-11",
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
      expect(spawned[0].systemPrompt).toContain('<file path="/workspace/AGENTS.md">');
      expect(spawned[0].systemPrompt).toContain("mounted agents");
      expect(spawned[0].systemPrompt).not.toContain("outside agents");
      expect(spawned[0].systemPrompt).toContain("<name>in-scope</name>");
      expect(spawned[0].systemPrompt).toContain(
        "<location>/workspace/.tau/skills/in-scope/SKILL.md</location>",
      );
      expect(spawned[0].systemPrompt).not.toContain("<name>out-of-scope</name>");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
