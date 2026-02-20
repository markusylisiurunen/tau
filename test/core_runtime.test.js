import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../dist/core/commands/index.js";
import { resolveRuntimePromptBootstrap } from "../dist/core/index.js";
import { personas } from "../dist/core/personas.js";
import { composeSessionPrompts } from "../dist/core/runtime/session_prompt_composer.js";
import { CoreSession } from "../dist/core/session/core_session.js";
import { ToolCatalog } from "../dist/core/tools/catalog.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import {
  TOOL_NAME_BASH,
  TOOL_NAME_EDIT,
  TOOL_NAME_GREP,
  TOOL_NAME_LIST,
  TOOL_NAME_READ,
} from "../dist/core/tools/tool_names.js";
import {
  buildCompactionUserMessage,
  extractCompactionSummaryFromText,
  formatHistoryForCompaction,
  partitionHistoryForCompaction,
} from "../dist/core/utils/compact.js";
import {
  buildEnvironmentTag,
  buildProjectContextBlock,
} from "../dist/core/utils/context_builder.js";

describe("command registry", () => {
  it("parses and dispatches commands", async () => {
    const registry = createCommandRegistry();
    const calls = [];

    const ctx = {
      help: () => calls.push({ type: "help" }),
      copyText: async () => calls.push({ type: "copyText" }),
      copyCode: async () => calls.push({ type: "copyCode" }),
      checkpoint: async () => calls.push({ type: "checkpoint" }),
      newSession: () => calls.push({ type: "new" }),
      rewind: () => calls.push({ type: "rewind" }),
      cd: () => calls.push({ type: "cd" }),
      compactSummaryOnly: async () => calls.push({ type: "compactSummaryOnly" }),
      compactSummaryAndLast: async () => calls.push({ type: "compactSummaryAndLast" }),
      pruneEarliest: () => calls.push({ type: "pruneEarliest" }),
      pruneLargest: () => calls.push({ type: "pruneLargest" }),
      pruneSmart: () => calls.push({ type: "pruneSmart" }),
      reload: async () => calls.push({ type: "reload" }),
      speak: () => calls.push({ type: "speak" }),
      risk: (level) => calls.push({ type: "risk", level }),
      persona: (id) => calls.push({ type: "persona", id }),
      prompt: (id) => calls.push({ type: "prompt", id }),
      theme: (id) => calls.push({ type: "theme", id }),
      bash: async (id) => calls.push({ type: "bash", id }),
      unknown: (raw) => calls.push({ type: "unknown", raw }),
    };

    const cmd = registry.parse("/risk:read-only");
    expect(cmd).toEqual({ type: "risk", level: "read-only" });
    await registry.dispatch(cmd, ctx);

    const rewind = registry.parse("/rewind");
    expect(rewind).toEqual({ type: "rewind" });
    await registry.dispatch(rewind, ctx);

    const copyText = registry.parse("/copy:text");
    expect(copyText).toEqual({ type: "copyText" });
    await registry.dispatch(copyText, ctx);

    const compactSummaryOnly = registry.parse("/compact:summary-only");
    expect(compactSummaryOnly).toEqual({ type: "compactSummaryOnly" });
    await registry.dispatch(compactSummaryOnly, ctx);

    const pruneSmart = registry.parse("/prune:smart");
    expect(pruneSmart).toEqual({ type: "pruneSmart" });
    await registry.dispatch(pruneSmart, ctx);

    const speak = registry.parse("/speak");
    expect(speak).toEqual({ type: "speak" });
    await registry.dispatch(speak, ctx);

    const unknown = registry.parse("/not-a-command");
    await registry.dispatch(unknown, ctx);

    expect(calls).toContainEqual({ type: "risk", level: "read-only" });
    expect(calls).toContainEqual({ type: "rewind" });
    expect(calls).toContainEqual({ type: "copyText" });
    expect(calls).toContainEqual({ type: "compactSummaryOnly" });
    expect(calls).toContainEqual({ type: "pruneSmart" });
    expect(calls).toContainEqual({ type: "speak" });
    expect(calls).toContainEqual({ type: "unknown", raw: "/not-a-command" });
  });
});

describe("tool enablement by risk level", () => {
  it("exposes a stable tool list", () => {
    const backend = createLocalToolExecutionBackend();
    const registry = ToolCatalog.createRegistry(backend);

    const allTools = registry.schemas.map((tool) => tool.name).sort();
    const enabled = registry
      .getEnabledToolSchemas()
      .map((tool) => tool.name)
      .sort();

    expect(allTools).not.toContain(TOOL_NAME_READ);
    expect(allTools).not.toContain(TOOL_NAME_GREP);
    expect(allTools).not.toContain(TOOL_NAME_LIST);
    expect(enabled).toEqual(allTools);
  });
});

describe("core session rewind APIs", () => {
  it("lists user rewind candidates and rewinds by history index", () => {
    const backend = createLocalToolExecutionBackend();
    const toolRegistry = ToolCatalog.createRegistry(backend);
    const session = new CoreSession({
      persona: personas[0],
      systemPrompt: "system",
      subagentPrompts: {},
      riskLevel: "read-only",
      toolRegistry,
    });

    session.addUserText(
      "<system>notice one</system>\n\n<system>notice two</system>\n\nfirst line\nsecond line",
    );
    session.addMessage({
      role: "assistant",
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      stopReason: "stop",
      timestamp: 1,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      content: [{ type: "text", text: "ok" }],
    });
    session.addUserText("third line");

    const candidates = session.listRewindCandidates();
    expect(candidates.map((candidate) => candidate.text)).toEqual([
      "first line\nsecond line",
      "third line",
    ]);

    const secondCandidate = candidates[1];
    expect(secondCandidate).toBeDefined();
    const rewound = session.rewindToHistoryEntryId(secondCandidate.historyEntryId);
    expect(rewound).toEqual({
      historyEntryId: secondCandidate.historyEntryId,
      text: "third line",
      removedEntryIds: [secondCandidate.historyEntryId],
    });

    const remaining = session.history;
    expect(remaining).toHaveLength(2);
    expect(remaining[0]?.role).toBe("user");
    expect(remaining[1]?.role).toBe("assistant");

    expect(session.rewindToHistoryEntryId("missing-id")).toBeUndefined();
  });
});

describe("core session model notices", () => {
  function getUserText(session, index) {
    const message = session.history[index];
    if (message?.role !== "user") {
      return "";
    }

    const textBlock = message.content.find((block) => block.type === "text");
    return textBlock?.text ?? "";
  }

  it("prepends configured model notice to user messages", () => {
    const backend = createLocalToolExecutionBackend();
    const toolRegistry = ToolCatalog.createRegistry(backend);
    const persona = personas.find((entry) => entry.model.provider === "openai");
    expect(persona).toBeDefined();

    const session = new CoreSession({
      persona,
      systemPrompt: "system",
      subagentPrompts: {},
      riskLevel: "read-only",
      toolRegistry,
      config: {
        modelSystemNotices: {
          [`${persona.model.provider}/${persona.model.id}`]: "always use tau tools",
        },
      },
    });

    session.addUserText("hello");

    expect(getUserText(session, 0)).toBe("<system>always use tau tools</system>\n\nhello");
    expect(session.listRewindCandidates().map((candidate) => candidate.text)).toEqual(["hello"]);
  });

  it("switches notice based on current persona model", () => {
    const backend = createLocalToolExecutionBackend();
    const toolRegistry = ToolCatalog.createRegistry(backend);
    const openaiPersona = personas.find((entry) => entry.model.provider === "openai");
    const anthropicPersona = personas.find((entry) => entry.model.provider === "anthropic");
    expect(openaiPersona).toBeDefined();
    expect(anthropicPersona).toBeDefined();

    const session = new CoreSession({
      persona: openaiPersona,
      systemPrompt: "system",
      subagentPrompts: {},
      riskLevel: "read-only",
      toolRegistry,
      config: {
        modelSystemNotices: {
          [`${openaiPersona.model.provider}/${openaiPersona.model.id}`]: "openai notice",
          [`${anthropicPersona.model.provider}/${anthropicPersona.model.id}`]: "anthropic notice",
        },
      },
    });

    session.addUserText("message one");
    session.setPersona(anthropicPersona, "system two", {});
    session.addUserText("message two");

    expect(getUserText(session, 0)).toBe("<system>openai notice</system>\n\nmessage one");
    expect(getUserText(session, 1)).toBe("<system>anthropic notice</system>\n\nmessage two");
  });
});

describe("context builder", () => {
  it("renders environment and project context blocks", () => {
    const tag = buildEnvironmentTag({
      datetime: "2025-01-01T00:00:00.000Z",
      cwd: "/repo",
      repoRoot: "/repo",
      riskLevel: "read-only",
      platform: "darwin",
      nodeVersion: "v20.0.0",
    });

    expect(tag).toContain("<platform>darwin</platform>");
    expect(tag).toContain("<node>v20.0.0</node>");
    expect(tag).toContain("<repo-root>/repo</repo-root>");

    const readFile = (path) => (path === "/repo/AGENTS.md" ? "# Agents\n" : "");
    const block = buildProjectContextBlock({
      cwd: "/repo",
      home: "/home",
      agentsFiles: ["/repo/AGENTS.md"],
      readFile,
    });

    expect(block).toContain('<file path="/repo/AGENTS.md">');
    expect(block).toContain("# Agents");
  });
});

describe("runtime prompt bootstrap", () => {
  it("builds canonical prompt context from skills and AGENTS data", () => {
    const home = mkdtempSync(join(tmpdir(), "tau-runtime-bootstrap-home-"));
    const repo = join(home, "repo");

    try {
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "AGENTS.md"), "# repo agents\n", "utf-8");
      mkdirSync(join(repo, ".tau"), { recursive: true });
      writeFileSync(
        join(repo, ".tau", "config.json"),
        JSON.stringify({ agentContextFiles: [123] }),
        "utf-8",
      );

      const persona = {
        id: "test-persona",
        label: "test persona",
        model: personas[0].model,
        systemPrompt: "test prompt",
        settings: {},
        source: "project",
        skills: ["alpha", "missing"],
      };

      const resolved = resolveRuntimePromptBootstrap({
        persona,
        discoveredSkills: [
          {
            name: "alpha",
            description: "alpha skill",
            path: join(repo, "skills", "alpha", "SKILL.md"),
          },
        ],
        cwd: repo,
        home,
        includeAgentContext: true,
        sandboxEnabled: false,
        readFile: (path) => {
          return path === join(repo, "AGENTS.md") ? "# repo agents\n" : "";
        },
      });

      expect(resolved.promptContext.cwd).toBe(repo);
      expect(resolved.promptContext.hostCwd).toBe(repo);
      expect(resolved.promptContext.includeAgentContext).toBe(true);
      expect(resolved.promptContext.projectContextBlock).toContain('<file path="');
      expect(resolved.promptContext.projectContextBlock).toContain("AGENTS.md");
      expect(resolved.promptContext.skillsBlock).toContain("<name>alpha</name>");
      expect(resolved.promptContext.skillsBlock).not.toContain("missing");
      expect(resolved.unknownSkills).toEqual(["missing"]);
      expect(resolved.agentsFiles).toEqual([join(repo, "AGENTS.md")]);
      expect(resolved.warnings.length).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("scopes AGENTS and skills to the sandbox mount and rewrites prompt paths", () => {
    const home = mkdtempSync(join(tmpdir(), "tau-runtime-bootstrap-sandbox-home-"));
    const repo = join(home, "repo");
    const repoAgents = join(repo, "AGENTS.md");
    const homeAgents = join(home, "AGENTS.md");
    const inScopeSkillPath = join(repo, ".tau", "skills", "in-scope", "SKILL.md");
    const outOfScopeSkillPath = join(home, ".config", "tau", "skills", "out-of-scope", "SKILL.md");

    try {
      mkdirSync(join(repo, ".tau", "skills", "in-scope"), { recursive: true });
      mkdirSync(join(home, ".config", "tau", "skills", "out-of-scope"), {
        recursive: true,
      });
      writeFileSync(repoAgents, "# repo agents\nrepo only\n", "utf-8");
      writeFileSync(homeAgents, "# home agents\nhome only\n", "utf-8");
      writeFileSync(
        inScopeSkillPath,
        "---\nname: in-scope\ndescription: project skill\n---\n",
        "utf-8",
      );
      writeFileSync(
        outOfScopeSkillPath,
        "---\nname: out-of-scope\ndescription: home skill\n---\n",
        "utf-8",
      );

      const persona = {
        id: "test-persona",
        label: "test persona",
        model: personas[0].model,
        systemPrompt: "test prompt",
        settings: {},
        source: "project",
        skills: ["in-scope", "out-of-scope"],
      };

      const resolved = resolveRuntimePromptBootstrap({
        persona,
        discoveredSkills: [
          {
            name: "in-scope",
            description: "project skill",
            path: inScopeSkillPath,
          },
          {
            name: "out-of-scope",
            description: "home skill",
            path: outOfScopeSkillPath,
          },
        ],
        cwd: repo,
        home,
        includeAgentContext: true,
        sandboxEnabled: true,
        sandboxConfig: {
          mountPath: "/workspace",
        },
        readFile: (path) => {
          if (path === repoAgents) return "# repo agents\nrepo only\n";
          if (path === homeAgents) return "# home agents\nhome only\n";
          return "";
        },
      });

      expect(resolved.promptContext.cwd).toBe("/workspace");
      expect(resolved.promptContext.projectContextBlock).toContain(
        '<file path="/workspace/AGENTS.md">',
      );
      expect(resolved.promptContext.projectContextBlock).toContain("repo only");
      expect(resolved.promptContext.projectContextBlock).not.toContain("home only");
      expect(resolved.promptContext.skillsBlock).toContain(
        "<location>/workspace/.tau/skills/in-scope/SKILL.md</location>",
      );
      expect(resolved.promptContext.skillsBlock).not.toContain("out-of-scope");
      expect(resolved.unknownSkills).toEqual(["out-of-scope"]);
      expect(resolved.agentsFiles).toEqual([repoAgents]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("session prompt composer", () => {
  it("composes main and subagent prompts with sandbox info and risk overrides", () => {
    const persona = {
      id: "test-persona",
      label: "test persona",
      description: "test",
      model: personas[0].model,
      systemPrompt: "main system prompt",
      settings: {},
      source: "project",
      subagents: {
        default: {},
        researcher: {
          systemPrompt: "research subagent prompt",
          description: "deep research helper",
          riskLevel: "read-write",
          launchModels: ["openai/gpt-5.2:high"],
        },
      },
    };

    const result = composeSessionPrompts({
      persona,
      skillsBlock: "### Skills\n\n- skill-a",
      projectContextBlock: '### Project context\n\n<file path="/repo/AGENTS.md">ctx</file>',
      sandboxEnabled: true,
      sandboxEnvironmentInfo: "ubuntu container",
      riskLevel: "read-only",
      cwd: "/repo",
      datetime: "2026-01-01T00:00:00.000Z",
      platform: "darwin",
      nodeVersion: "v24.0.0",
    });

    expect(result.environmentTag).toContain('<risk-level level="read-only">');
    expect(result.baseSystemPrompt).toContain("main system prompt");
    expect(result.baseSystemPrompt).toContain("### Skills");
    expect(result.baseSystemPrompt).toContain("### Project context");
    expect(result.baseSystemPrompt).toContain("### Available sub-agents");
    expect(result.baseSystemPrompt).toContain("`researcher`");
    expect(result.baseSystemPrompt).toContain("launch models");
    expect(result.baseSystemPrompt).toContain("openai/gpt-5.2:high");
    expect(result.baseSystemPrompt).toContain("<sandbox-info>");

    expect(result.subagentPrompts.default).toContain('<risk-level level="read-only">');
    expect(result.subagentPrompts.researcher).toContain("research subagent prompt");
    expect(result.subagentPrompts.researcher).toContain('<risk-level level="read-write">');
    expect(result.subagentPrompts.researcher).toContain("<sandbox-info>");
  });

  it("includes repo root in the environment tag when inside a git repo", () => {
    const gitRootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    expect(gitRootResult.status).toBe(0);
    const gitRoot = (gitRootResult.stdout ?? "").trim();
    expect(gitRoot).not.toBe("");

    const persona = {
      id: "plain-persona",
      label: "plain persona",
      model: personas[0].model,
      systemPrompt: "plain prompt",
      settings: {},
      source: "project",
    };

    const sandboxCwd = "/workspace/test/subdir";
    const hostCwd = resolve(gitRoot, "src", "core");

    const result = composeSessionPrompts({
      persona,
      sandboxEnabled: false,
      riskLevel: "read-only",
      cwd: sandboxCwd,
      hostCwd,
      datetime: "2026-01-01T00:00:00.000Z",
      platform: "darwin",
      nodeVersion: "v24.0.0",
    });

    const expectedRepoRoot = resolve(sandboxCwd, relative(hostCwd, gitRoot));
    expect(result.environmentTag).toContain(`<repo-root>${expectedRepoRoot}</repo-root>`);
  });

  it("omits sandbox blocks and subagent prompts when not applicable", () => {
    const persona = {
      id: "plain-persona",
      label: "plain persona",
      model: personas[0].model,
      systemPrompt: "plain prompt",
      settings: {},
      source: "project",
    };

    const result = composeSessionPrompts({
      persona,
      sandboxEnabled: false,
      sandboxEnvironmentInfo: "ignored",
      riskLevel: "read-only",
      cwd: "/repo",
      datetime: "2026-01-01T00:00:00.000Z",
      platform: "darwin",
      nodeVersion: "v24.0.0",
    });

    expect(result.baseSystemPrompt).toContain("plain prompt");
    expect(result.baseSystemPrompt).not.toContain("<sandbox-info>");
    expect(result.subagentPrompts).toEqual({});
  });
});

describe("summary formatting", () => {
  it("omits thinking, uses marker-newline format, and compacts edit calls", () => {
    const history = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 0,
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "hi" },
          {
            type: "toolCall",
            id: "1",
            name: TOOL_NAME_READ,
            arguments: { path: "README.md" },
          },
          {
            type: "toolCall",
            id: "2",
            name: TOOL_NAME_EDIT,
            arguments: {
              path: "src/parser.ts",
              oldText: "const stable = 0;\nconst before = 1;\nreturn stable;",
              newText: "const stable = 0;\nconst after = 2;\nreturn stable;",
            },
          },
        ],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "1",
        toolName: TOOL_NAME_READ,
        content: [{ type: "text", text: "output" }],
        isError: false,
        timestamp: 2,
      },
    ];

    const summary = formatHistoryForCompaction(history);

    expect(summary).toContain("[User]:\nhello");
    expect(summary).toContain("[Assistant]:\nhi");
    expect(summary).toContain(`[Assistant tool calls]:\n${TOOL_NAME_READ}(path="README.md")`);
    expect(summary).toContain(`${TOOL_NAME_EDIT}(path="src/parser.ts")`);
    expect(summary).toContain("const stable = 0;");
    expect(summary).toContain("- const before = 1;");
    expect(summary).toContain("+ const after = 2;");
    expect(summary).toContain("return stable;");
    expect(summary).toContain(`[Tool result]: ${TOOL_NAME_READ} (ok)\noutput`);
    expect(summary).not.toContain("hmm");
    expect(summary).not.toContain('oldText="const before = 1;"');
    expect(summary).not.toContain('newText="const after = 2;"');
  });

  it("omits unchanged edit regions only when they are long", () => {
    const unchangedPrefix = Array.from({ length: 12 }, (_, index) => `pre ${index}`);
    const unchangedSuffix = Array.from({ length: 12 }, (_, index) => `post ${index}`);
    const history = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "edit-long",
            name: TOOL_NAME_EDIT,
            arguments: {
              path: "src/example.ts",
              oldText: [...unchangedPrefix, "before", ...unchangedSuffix].join("\n"),
              newText: [...unchangedPrefix, "after", ...unchangedSuffix].join("\n"),
            },
          },
        ],
        timestamp: 0,
      },
    ];

    const summary = formatHistoryForCompaction(history);

    expect(summary).toContain("… 4 unchanged line(s) omitted …");
    expect(summary).toContain("  pre 4");
    expect(summary).not.toContain("  pre 0");
    expect(summary).toContain("  post 7");
    expect(summary).not.toContain("  post 11");
  });

  it("limits unchanged lines between edit hunks to at most 8", () => {
    const middle = Array.from({ length: 14 }, (_, index) => `middle ${index}`);
    const oldText = ["before 1", ...middle, "before 2"].join("\n");
    const newText = ["after 1", ...middle, "after 2"].join("\n");

    const history = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "edit-hunks",
            name: TOOL_NAME_EDIT,
            arguments: {
              path: "src/hunks.ts",
              oldText,
              newText,
            },
          },
        ],
        timestamp: 0,
      },
    ];

    const summary = formatHistoryForCompaction(history);

    expect(summary).toContain("  middle 0");
    expect(summary).toContain("  middle 3");
    expect(summary).toContain("… 6 unchanged line(s) omitted …");
    expect(summary).toContain("  middle 10");
    expect(summary).toContain("  middle 13");
    expect(summary).not.toContain("  middle 4");
    expect(summary).not.toContain("  middle 9");
  });

  it("middle-truncates bash tool results to 4096 tokens", () => {
    const longOutput = "a".repeat(30000);
    const history = [
      {
        role: "toolResult",
        toolCallId: "bash-1",
        toolName: TOOL_NAME_BASH,
        content: [{ type: "text", text: longOutput }],
        isError: false,
        timestamp: 0,
      },
    ];

    const summary = formatHistoryForCompaction(history);

    expect(summary).toContain(`[Tool result]: ${TOOL_NAME_BASH} (ok)`);
    expect(summary).toContain("tokens truncated");
    expect(summary.length).toBeLessThan(longOutput.length);
  });
});

describe("compaction context message", () => {
  it("builds and extracts compaction summary text", () => {
    const message = buildCompactionUserMessage({
      summary: "## Goal\nShip feature",
      lastAssistantMessage: "Done. Tests passed.",
    });

    expect(message).toContain("<summary>");
    expect(message).toContain("<last-assistant-message-verbatim>");
    expect(extractCompactionSummaryFromText(message)).toBe("## Goal\nShip feature");
  });

  it("does not extract summary from non-canonical marker text", () => {
    const quotedCompactionText = [
      "Please echo this format:",
      "The conversation history before this point was compacted into the following summary:",
      "<summary>",
      "quoted content",
      "</summary>",
    ].join("\n");

    expect(extractCompactionSummaryFromText(quotedCompactionText)).toBeUndefined();
  });

  it("does not extract summary when extra trailing text is present", () => {
    const messageWithTrailingText = `${buildCompactionUserMessage({
      summary: "old summary",
    })}\n\ntrailing text`;

    expect(extractCompactionSummaryFromText(messageWithTrailingText)).toBeUndefined();
  });

  it("excludes previous compaction user message from the next summary input", () => {
    const compactionMessage = buildCompactionUserMessage({ summary: "old summary" });
    const history = [
      {
        role: "user",
        content: [{ type: "text", text: compactionMessage }],
        timestamp: 0,
      },
      {
        role: "user",
        content: [{ type: "text", text: "new request" }],
        timestamp: 1,
      },
    ];

    const result = partitionHistoryForCompaction(history);

    expect(result.previousSummary).toBe("old summary");
    expect(result.messagesToSummarize).toHaveLength(1);
    expect(result.messagesToSummarize[0].role).toBe("user");
  });
});
