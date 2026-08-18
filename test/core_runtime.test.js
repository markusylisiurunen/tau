import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { personas } from "../dist/core/personas.js";
import { resolveRuntimePromptBootstrap } from "../dist/core/runtime/runtime_bootstrap.js";
import { composeSessionPrompts } from "../dist/core/runtime/session_prompt_composer.js";
import { createAutoCompactionArchiver } from "../dist/core/session/auto_compaction_archive.js";
import {
  buildAutoCompactionContinuationMessage,
  buildAutoCompactionPrompt,
  buildSessionCompactionPrompt,
  parseCompactionSummaryResponse,
  prepareAutoCompaction,
  prepareSessionCompaction,
  selectAutoCompactionCut,
} from "../dist/core/session/compaction.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { TOOL_NAME_BASH, TOOL_NAME_EDIT } from "../dist/core/tools/tool_names.js";
import {
  buildCompactionUserMessage,
  formatHistoryForCompaction,
} from "../dist/core/utils/compact.js";
import {
  buildEnvironmentTag,
  buildProjectContextBlock,
} from "../dist/core/utils/context_builder.js";
import {
  formatTauUserText,
  getAutoCompactionMetadataFromMessage,
  getCompactionMetadataFromMessage,
  hasAutoCompactionContinuationMetadata,
  hasGoalTurnMetadata,
  hasToolRecoveryMetadata,
  prependTauUserMetadata,
  splitTauUserMetadata,
  stripTauUserDisplayText,
  stripTauUserMetadata,
  stripTauUserMetadataFromMessage,
  TAU_USER_METADATA_PREFIX,
} from "../dist/core/utils/user_metadata.js";

describe("context builder", () => {
  it("renders environment and project context blocks", () => {
    const tag = buildEnvironmentTag({
      sessionId: "session-1",
      sessionStartedAt: "2025-01-01T00:00:00.000Z",
      cwd: "/repo",
      repoRoot: "/repo",
      repository: "github.com/example/repo",
      platform: "darwin",
    });

    expect(tag).toBe(`<environment>
- Session ID: \`session-1\`
- Session started at: 2025-01-01T00:00:00.000Z
- Platform: macOS
- Current working directory: \`/repo\`
- Repository: \`github.com/example/repo\`
- Repository root: \`/repo\`
</environment>`);

    const readFile = (path) => (path === "/repo/AGENTS.md" ? "# Agents\n" : "");
    const block = buildProjectContextBlock({
      agentsFiles: ["/repo/AGENTS.md"],
      childAgentsFiles: [],
      readFile,
    });

    expect(block).toContain('<file path="/repo/AGENTS.md">');
    expect(block).toContain("# Agents");
  });

  it("renders nested AGENTS.md paths without duplicating injected files", () => {
    const block = buildProjectContextBlock({
      agentsFiles: ["/repo/AGENTS.md", "/repo/packages/full/AGENTS.md"],
      childAgentsFiles: ["/repo/packages/full/AGENTS.md", "/repo/packages/path-only/AGENTS.md"],
      readFile: (path) => {
        if (path === "/repo/AGENTS.md") return "# Root\n";
        if (path === "/repo/packages/full/AGENTS.md") return "# Full\n";
        return "";
      },
    });

    expect(block).toContain('<file path="/repo/AGENTS.md">');
    expect(block).toContain('<file path="/repo/packages/full/AGENTS.md">');
    expect(block).toContain("Nested AGENTS.md files under the current working directory");
    expect(block).toContain('<file path="/repo/packages/path-only/AGENTS.md" />');
    expect(block).not.toContain('<file path="/repo/packages/full/AGENTS.md" />');
  });
});

describe("runtime prompt bootstrap", () => {
  it("keeps ancestor AGENTS files when resolving prompt context through a command", async () => {
    const persona = {
      id: "test-persona",
      label: "test persona",
      model: personas[0].model,
      systemPrompt: "test prompt",
      settings: {},
      source: "project",
      skills: "*",
    };

    const resolved = await resolveRuntimePromptBootstrap({
      persona,
      discoveredSkills: [],
      cwd: "/workspace/repo",
      home: "/workspace",
      includeAgentContext: true,
      agentContextFiles: [],
      backend: {
        async runNodeScript(_script, args) {
          expect(args[0]).toBe("/workspace/repo");
          return {
            output: JSON.stringify({
              platform: "linux",
              repoRoot: "/workspace/repo",
              repositoryRemote: "git@GitHub.com:example/repo.git",
              agentsFiles: [
                { path: "/workspace/repo/AGENTS.md", content: "repo instructions" },
                { path: "/workspace/AGENTS.md", content: "workspace instructions" },
              ],
              childAgentsFiles: ["/workspace/repo/src/AGENTS.md"],
            }),
            exitCode: 0,
          };
        },
      },
    });

    expect(resolved.agentsFiles).toEqual(["/workspace/repo/AGENTS.md", "/workspace/AGENTS.md"]);
    expect(resolved.promptContext.repository).toBe("github.com/example/repo");
    expect(resolved.promptContext.projectContextBlock).toContain("repo instructions");
    expect(resolved.promptContext.projectContextBlock).toContain("workspace instructions");
    expect(resolved.promptContext.projectContextBlock).toContain("/workspace/repo/src/AGENTS.md");
  });

  it("discovers nested AGENTS files without scanning ignored tool directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "tau-runtime-agents-walk-"));
    const home = join(root, "home");
    const nested = join(home, "projects", "app");
    const nestedManaged = join(nested, ".npm", "package");
    const ignored = join(home, ".npm", "package");
    mkdirSync(nestedManaged, { recursive: true });
    mkdirSync(ignored, { recursive: true });
    writeFileSync(join(home, "AGENTS.md"), "home instructions", "utf-8");
    writeFileSync(join(nested, "AGENTS.md"), "nested instructions", "utf-8");
    writeFileSync(join(nestedManaged, "AGENTS.md"), "nested managed instructions", "utf-8");
    writeFileSync(join(ignored, "AGENTS.md"), "ignored instructions", "utf-8");

    try {
      const resolved = await resolveRuntimePromptBootstrap({
        persona: personas[0],
        discoveredSkills: [],
        cwd: home,
        home,
        includeAgentContext: true,
        agentContextFiles: [],
        backend: createLocalToolExecutionBackend(),
      });

      expect(resolved.agentsFiles).toEqual([join(home, "AGENTS.md")]);
      expect(resolved.promptContext.projectContextBlock).toContain(join(nested, "AGENTS.md"));
      expect(resolved.promptContext.projectContextBlock).toContain(
        join(nestedManaged, "AGENTS.md"),
      );
      expect(resolved.promptContext.projectContextBlock).not.toContain(join(ignored, "AGENTS.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses breadth-first child AGENTS discovery when the directory budget is reached", async () => {
    const root = mkdtempSync(join(tmpdir(), "tau-runtime-agents-breadth-"));
    const home = join(root, "home");
    const first = join(home, "aaa", "one", "two", "three");
    const later = join(home, "zzz");
    mkdirSync(first, { recursive: true });
    mkdirSync(later, { recursive: true });
    writeFileSync(join(later, "AGENTS.md"), "later instructions", "utf-8");
    const localBackend = createLocalToolExecutionBackend();
    const limitedBackend = {
      ...localBackend,
      runNodeScript(script, args, options) {
        const limitedArgs = [...args];
        limitedArgs[6] = "4";
        return localBackend.runNodeScript(script, limitedArgs, options);
      },
    };

    try {
      const resolved = await resolveRuntimePromptBootstrap({
        persona: personas[0],
        discoveredSkills: [],
        cwd: home,
        home,
        includeAgentContext: true,
        agentContextFiles: [],
        backend: limitedBackend,
      });

      expect(resolved.promptContext.projectContextBlock).toContain(join(later, "AGENTS.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds child AGENTS discovery depth", async () => {
    const root = mkdtempSync(join(tmpdir(), "tau-runtime-agents-depth-"));
    const home = join(root, "home");
    let current = home;
    let atLimit;
    let beyondLimit;
    for (let depth = 1; depth <= 17; depth += 1) {
      current = join(current, `level-${depth}`);
      mkdirSync(current, { recursive: true });
      if (depth === 16) {
        atLimit = join(current, "AGENTS.md");
        writeFileSync(atLimit, "at limit", "utf-8");
      }
      if (depth === 17) {
        beyondLimit = join(current, "AGENTS.md");
        writeFileSync(beyondLimit, "beyond limit", "utf-8");
      }
    }

    try {
      const resolved = await resolveRuntimePromptBootstrap({
        persona: personas[0],
        discoveredSkills: [],
        cwd: home,
        home,
        includeAgentContext: true,
        agentContextFiles: [],
        backend: createLocalToolExecutionBackend(),
      });

      expect(resolved.promptContext.projectContextBlock).toContain(atLimit);
      expect(resolved.promptContext.projectContextBlock).not.toContain(beyondLimit);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("filters explicit context files to the execution cwd scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "tau-runtime-agents-scope-"));
    const home = join(root, "home");
    const backend = join(home, "repo", "backend");
    const scripts = join(backend, "scripts");
    const sibling = join(home, "repo", "client");
    const prefixSibling = join(home, "repo", "backendish");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    mkdirSync(prefixSibling, { recursive: true });
    const included = join(scripts, "AGENTS.md");
    const siblingFile = join(sibling, "AGENTS.md");
    const prefixSiblingFile = join(prefixSibling, "AGENTS.md");
    const additionalContext = join(scripts, "AI_GUIDE.md");
    writeFileSync(included, "included instructions", "utf-8");
    writeFileSync(siblingFile, "sibling instructions", "utf-8");
    writeFileSync(prefixSiblingFile, "prefix sibling instructions", "utf-8");
    writeFileSync(additionalContext, "additional context", "utf-8");

    try {
      const resolved = await resolveRuntimePromptBootstrap({
        persona: personas[0],
        discoveredSkills: [],
        cwd: backend,
        home,
        includeAgentContext: true,
        agentContextFiles: [included, siblingFile, prefixSiblingFile, additionalContext],
        backend: createLocalToolExecutionBackend(),
      });

      expect(resolved.agentsFiles).toEqual([included, additionalContext]);
      expect(resolved.promptContext.projectContextBlock).toContain("included instructions");
      expect(resolved.promptContext.projectContextBlock).toContain("additional context");
      expect(resolved.promptContext.projectContextBlock).not.toContain("sibling instructions");
      expect(resolved.promptContext.projectContextBlock).not.toContain(
        "prefix sibling instructions",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects hosted AGENTS symlinks that escape the execution home", async () => {
    const root = mkdtempSync(join(tmpdir(), "tau-hosted-agents-symlink-"));
    const home = join(root, "home");
    const repo = join(home, "repo");
    const outside = join(root, "outside");
    mkdirSync(repo, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "AGENTS.md"), "outside instructions", "utf-8");
    symlinkSync(join(outside, "AGENTS.md"), join(repo, "AGENTS.md"));

    try {
      const resolved = await resolveRuntimePromptBootstrap({
        persona: personas[0],
        discoveredSkills: [],
        cwd: repo,
        home,
        includeAgentContext: true,
        agentContextFiles: [],
        backend: createLocalToolExecutionBackend(),
      });

      expect(resolved.agentsFiles).toEqual([]);
      expect(resolved.promptContext.projectContextBlock).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("session prompt composer", () => {
  it("composes main and subagent prompts", () => {
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
          launchModels: ["openai/gpt-5.4:high"],
        },
      },
    };

    const result = composeSessionPrompts({
      persona,
      sessionId: "session-1",
      skillsBlock: "### Skills\n\n- skill-a",
      projectContextBlock: '### Project context\n\n<file path="/repo/AGENTS.md">ctx</file>',
      cwd: "/repo",
      sessionStartedAt: "2026-01-01T00:00:00.000Z",
      platform: "darwin",
    });

    expect(result.baseSystemPrompt).toContain("main system prompt");
    expect(result.baseSystemPrompt).toContain("### Skills");
    expect(result.baseSystemPrompt).toContain("### Project context");
    expect(result.baseSystemPrompt).toContain("### Available sub-agents");
    expect(result.baseSystemPrompt).toContain("`researcher`");
    expect(result.baseSystemPrompt).toContain("Default runtime:");
    expect(result.baseSystemPrompt).toContain(`${persona.model.provider}/${persona.model.id}:none`);
    expect(result.baseSystemPrompt).not.toContain("context tokens");
    expect(result.baseSystemPrompt).toContain("Launch model overrides");
    expect(result.baseSystemPrompt).toContain("openai/gpt-5.4:high");
    expect(result.baseSystemPrompt).toContain(
      "By default, launch the subagent without a model override unless the user explicitly asks to use a specific model.",
    );

    expect(result.subagentPrompts.default).toContain("<inherited-instructions>");
    expect(result.subagentPrompts.default).toContain("main system prompt");
    expect(result.subagentPrompts.default).toContain("- Session ID: `session-1`");
    expect(result.subagentPrompts.default).not.toContain("{{inherited_instructions}}");
    expect(result.subagentPrompts.default).toContain(
      "You are a subagent supporting the main agent.",
    );
    expect(result.subagentPrompts.researcher).toContain("research subagent prompt");
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

    const cwd = resolve(gitRoot, "src", "core");

    const result = composeSessionPrompts({
      persona,
      cwd,
      repoRoot: gitRoot,
      sessionStartedAt: "2026-01-01T00:00:00.000Z",
      platform: "darwin",
    });

    expect(result.environmentTag).toContain(`- Repository root: \`${gitRoot}\``);
  });

  it("omits subagent prompts when not applicable", () => {
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
      cwd: "/repo",
      sessionStartedAt: "2026-01-01T00:00:00.000Z",
      platform: "darwin",
    });

    expect(result.baseSystemPrompt).toContain("plain prompt");
    expect(result.subagentPrompts).toEqual({});
  });
});

describe("summary formatting", () => {
  it("omits thinking, uses marker-newline format, and compacts edit calls", () => {
    const inspectToolName = "inspect";
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
            name: inspectToolName,
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
        toolName: inspectToolName,
        content: [{ type: "text", text: "output" }],
        isError: false,
        timestamp: 2,
      },
    ];

    const summary = formatHistoryForCompaction(history);

    expect(summary).toContain("[User]:\nhello");
    expect(summary).toContain("[Assistant]:\nhi");
    expect(summary).toContain(`[Assistant tool calls]:\n${inspectToolName}(path="README.md")`);
    expect(summary).toContain(`${TOOL_NAME_EDIT}(path="src/parser.ts")`);
    expect(summary).toContain("const stable = 0;");
    expect(summary).toContain("- const before = 1;");
    expect(summary).toContain("+ const after = 2;");
    expect(summary).toContain("return stable;");
    expect(summary).toContain(`[Tool result]: ${inspectToolName} (ok)\noutput`);
    expect(summary).not.toContain("hmm");
    expect(summary).not.toContain('oldText="const before = 1;"');
    expect(summary).not.toContain('newText="const after = 2;"');
  });

  it("includes the session system prompt when provided", () => {
    const history = [userMessage("continue")];

    const summary = formatHistoryForCompaction(history, {
      systemPrompt: "follow AGENTS.md and current instructions",
    });

    expect(summary).toContain("[System prompt]:\nfollow AGENTS.md and current instructions");
    expect(summary).toContain("[User]:\ncontinue");
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

  it("middle-truncates every compaction tool result to 2048 tokens without changing history", () => {
    const longOutput = `start ${"a".repeat(30000)} end`;
    const history = [
      {
        role: "toolResult",
        toolCallId: "bash-1",
        toolName: TOOL_NAME_BASH,
        content: [{ type: "text", text: longOutput }],
        isError: false,
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "custom-1",
        toolName: "custom_tool",
        content: [{ type: "text", text: longOutput }],
        isError: false,
        timestamp: 1,
      },
    ];
    const originalHistory = structuredClone(history);

    const summary = formatHistoryForCompaction(history);

    expect(summary).toContain(`[Tool result]: ${TOOL_NAME_BASH} (ok)`);
    expect(summary).toContain("[Tool result]: custom_tool (ok)");
    expect(summary.match(/tokens truncated/g)).toHaveLength(2);
    expect(summary).toContain("start");
    expect(summary).toContain("end");
    expect(summary.length).toBeLessThan(longOutput.length);
    expect(history).toEqual(originalHistory);
  });

  it("middle-truncates tool results embedded in recovery messages", () => {
    const longOutput = `start & < ${"a".repeat(30000)} > end`;
    const recoveryInstructions = [
      "The previous assistant generation failed after tool execution had begun.",
      "<tool-execution-records>",
      '  <tool-execution-record tool-call-id="call-1" tool-name="custom_tool">',
      "    <arguments-json>{}</arguments-json>",
      "    <is-error>false</is-error>",
      `    <result-text>start &amp; &lt; ${"a".repeat(30000)} &gt; end</result-text>`,
      "  </tool-execution-record>",
      "</tool-execution-records>",
    ].join("\n");
    const history = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: formatTauUserText({
              text: "",
              metadata: [{ type: "tool-recovery", version: 1 }],
              hiddenSystemMessages: [recoveryInstructions],
            }),
          },
        ],
        timestamp: 0,
      },
    ];
    const originalHistory = structuredClone(history);

    const summary = formatHistoryForCompaction(history);

    expect(hasToolRecoveryMetadata(history[0])).toBe(true);
    expect(summary).toContain("<tool-execution-records>");
    expect(summary).toContain('<tool-execution-record tool-call-id="call-1"');
    expect(summary).toContain("<result-text>start &amp; &lt;");
    expect(summary).toContain("&gt; end</result-text>");
    expect(summary).toContain("tokens truncated");
    expect(summary.length).toBeLessThan(longOutput.length);
    expect(history).toEqual(originalHistory);
  });

  it("preserves recovery-shaped ordinary user text", () => {
    const longOutput = `start ${"a".repeat(30000)} end`;
    const userText = [
      "Review this example:",
      "<tool-execution-records>",
      `<result-text>${longOutput}</result-text>`,
      "</tool-execution-records>",
    ].join("\n");
    const message = userMessage(userText);

    const summary = formatHistoryForCompaction([message]);

    expect(hasToolRecoveryMetadata(message)).toBe(false);
    expect(summary).toContain(longOutput);
    expect(summary).not.toContain("tokens truncated");
  });
});

describe("automatic compaction archive", () => {
  it("writes private ordered snapshots and preserves full JSON tool results", async () => {
    const backend = createLocalToolExecutionBackend();
    const archive = createAutoCompactionArchiver(backend);
    const agentId = `agent-${randomUUID()}`;
    const roots = [];
    const longOutput = `start ${"x".repeat(20_000)} end`;
    const historyEntries = [
      {
        id: "user-1",
        message: userMessage("inspect the repository"),
      },
      {
        id: "assistant-1",
        message: {
          ...assistantMessage(""),
          content: [
            {
              type: "thinking",
              thinking: "private reasoning must not be archived",
            },
            {
              type: "toolCall",
              id: "bash-1",
              name: TOOL_NAME_BASH,
              arguments: { command: "rg -n TODO src" },
            },
          ],
        },
      },
      {
        id: "tool-1",
        message: {
          role: "toolResult",
          toolCallId: "bash-1",
          toolName: TOOL_NAME_BASH,
          content: [{ type: "text", text: longOutput }],
          isError: false,
          timestamp: 2,
        },
      },
      {
        id: "retained-user",
        message: userMessage("this retained tail must also be archived"),
      },
    ];
    const request = {
      agentId,
      createdAt: 1_750_000_000_000,
      historyEntries,
      signal: new AbortController().signal,
    };

    try {
      const first = await archive(request);
      roots.push(dirname(first.textPath));
      const record = JSON.parse(readFileSync(first.jsonPath, "utf8"));
      const text = readFileSync(first.textPath, "utf8");
      const documentation = readFileSync(first.documentationPath, "utf8");

      expect(first.textPath).toMatch(/000001\.txt$/);
      expect(first.jsonPath).toMatch(/000001\.json$/);
      expect(first.documentationPath).toBe(join(dirname(first.textPath), "README.md"));
      expect(record).toMatchObject({
        version: 1,
        agentId,
        sequence: 1,
        createdAt: request.createdAt,
      });
      expect(record.messages.map((message) => message.historyEntryId)).toEqual([
        "user-1",
        "assistant-1",
        "tool-1",
        "retained-user",
      ]);
      expect(record.messages[1].content[0]).toEqual({
        type: "toolCall",
        id: "bash-1",
        name: TOOL_NAME_BASH,
        arguments: { command: "rg -n TODO src" },
      });
      expect(record.messages[2].content[0].text).toBe(longOutput);
      expect(JSON.stringify(record)).not.toContain("private reasoning must not be archived");
      expect(text).toContain("start ");
      expect(text).toContain(" end");
      expect(text).toContain("tokens truncated");
      expect(text).not.toContain(longOutput);
      expect(text).not.toContain("private reasoning must not be archived");
      expect(text).toContain("Automatic compaction context snapshot");
      expect(documentation).toContain("# Automatic compaction archive");
      expect(documentation).not.toContain("Tau");
      expect(documentation).toContain("## JSON shape");
      expect(documentation).toContain("type Archive = {");
      expect(documentation).toContain('role: "toolResult"');
      expect(documentation).toContain("adaptable, not a required workflow");
      expect(documentation).toContain("Pass an exact archive entry id");
      expect(documentation).toContain("Omit the id to print a concise overview first");
      expect(documentation).toContain("item.historyEntryId === id");
      expect(documentation).not.toContain("JSON.stringify(message");
      expect(documentation).toContain("excerpt(text(message.content, true), 2_000)");
      expect(documentation).toContain("chars truncated…");
      expect(documentation).toContain("max - [...marker].length");
      expect(documentation).toContain(').filter(Boolean).join("\\n").trim()');
      expect(documentation).toContain('includeToolCalls ? "[tool " + part.name + "]" : ""');
      expect(documentation).toContain("appears once by tool name and result id");
      expect(documentation).toContain('if (message.role !== "toolResult" && !body) continue');
      expect(documentation).toContain('" id=…" + message.historyEntryId.slice(-8)');

      const exampleScript = documentation.match(/<<'NODE'\n([\s\S]+?)\nNODE/)?.[1];
      expect(exampleScript).toBeTypeOf("string");
      const overview = spawnSync(process.execPath, ["-", first.jsonPath], {
        input: exampleScript,
        encoding: "utf8",
      });
      expect(overview.status).toBe(0);
      expect(overview.stdout).toBe(
        [
          "[user id=…user-1]",
          "inspect the repository",
          "[tool bash id=…tool-1]",
          "[user id=…ned-user]",
          "this retained tail must also be archived",
          "",
        ].join("\n"),
      );
      expect(overview.stdout).not.toContain("rg -n TODO src");
      expect(overview.stdout).not.toContain(longOutput);

      const exact = spawnSync(process.execPath, ["-", first.jsonPath, "tool-1"], {
        input: exampleScript,
        encoding: "utf8",
      });
      expect(exact.status).toBe(0);
      expect(exact.stdout).toContain("[tool bash id=…tool-1]\nstart ");
      expect(exact.stdout).toContain(" chars truncated…");
      expect(exact.stdout).toContain(" end\n");
      expect(exact.stdout).not.toContain(longOutput);
      expect(statSync(dirname(first.textPath)).mode & 0o777).toBe(0o700);
      expect(statSync(first.documentationPath).mode & 0o777).toBe(0o600);
      expect(statSync(first.textPath).mode & 0o777).toBe(0o600);
      expect(statSync(first.jsonPath).mode & 0o777).toBe(0o600);

      const second = await archive(request);
      expect(second.textPath).toBe(first.textPath.replace("000001.txt", "000002.txt"));
      expect(second.documentationPath).toBe(first.documentationPath);

      const fork = await archive({ ...request, agentId: `agent-${randomUUID()}` });
      roots.push(dirname(fork.textPath));
      expect(dirname(fork.textPath)).not.toBe(dirname(first.textPath));
      expect(fork.textPath).toMatch(/000001\.txt$/);
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
      await backend.dispose();
    }
  });
});

describe("compaction context message", () => {
  it("builds visible compaction summary text", () => {
    const message = buildCompactionUserMessage({
      summary: "## Goal\nShip feature",
      lastAssistantMessage: "Done. Tests passed.",
    });

    expect(message).toContain("<summary>");
    expect(message).toContain("<last-assistant-message-verbatim>");
  });

  it("round-trips tau user metadata", () => {
    const visibleText = buildCompactionUserMessage({ summary: "## Goal\nShip feature" });
    const text = prependTauUserMetadata(visibleText, [
      {
        type: "compaction",
        version: 1,
        summary: "## Goal\nShip feature",
        preservedUserMessages: [{ id: "history-one", text: "ship the feature" }],
      },
    ]);
    const message = {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 0,
    };

    expect(text.startsWith(TAU_USER_METADATA_PREFIX)).toBe(true);
    expect(stripTauUserMetadata(text)).toBe(visibleText);
    expect(stripTauUserDisplayText(text)).toBe(visibleText);
    expect(stripTauUserMetadataFromMessage(message).content[0].text).toBe(visibleText);
    expect(getCompactionMetadataFromMessage(message)).toEqual({
      type: "compaction",
      version: 1,
      summary: "## Goal\nShip feature",
      preservedUserMessages: [{ id: "history-one", text: "ship the feature" }],
    });
  });

  it("recognizes goal-controlled turn metadata", () => {
    const message = {
      role: "user",
      content: [
        {
          type: "text",
          text: prependTauUserMetadata("goal", [{ type: "goal-turn", version: 1 }]),
        },
      ],
      timestamp: 0,
    };

    expect(hasGoalTurnMetadata(message)).toBe(true);
  });

  it("strips strict leading hidden system blocks only from display text", () => {
    const text = formatTauUserText({
      text: "\nvisible",
      hiddenSystemMessages: ["notice one", "notice two"],
    });

    expect(stripTauUserMetadata(text)).toBe(
      "<system>notice one</system>\n<system>notice two</system>\n\nvisible",
    );
    expect(stripTauUserDisplayText(text)).toBe("\nvisible");
    expect(stripTauUserDisplayText("<system>notice</system>visible")).toBe(
      "<system>notice</system>visible",
    );
    expect(stripTauUserDisplayText("prefix <system>notice</system>\nvisible")).toBe(
      "prefix <system>notice</system>\nvisible",
    );
  });

  it("fails fast for invalid tau user metadata", () => {
    expect(() =>
      stripTauUserMetadata(`${TAU_USER_METADATA_PREFIX}not-base64\u001evisible`),
    ).toThrow("invalid tau user metadata");

    const encoded = Buffer.from(
      JSON.stringify([{ type: "compaction", version: 2, summary: "summary" }]),
      "utf8",
    ).toString("base64url");
    expect(() =>
      stripTauUserMetadata(`${TAU_USER_METADATA_PREFIX}${encoded}\u001evisible`),
    ).toThrow("invalid tau user metadata: unsupported compaction metadata version");
  });

  it("strips unknown tau user metadata fields", () => {
    const encoded = Buffer.from(
      JSON.stringify([
        {
          type: "compaction",
          version: 1,
          summary: "summary",
          preservedUserMessages: [{ id: "user-1", text: "keep me", extra: true }],
          extra: true,
        },
      ]),
      "utf8",
    ).toString("base64url");

    expect(splitTauUserMetadata(`${TAU_USER_METADATA_PREFIX}${encoded}\u001evisible`)).toEqual({
      metadata: [
        {
          type: "compaction",
          version: 1,
          summary: "summary",
          preservedUserMessages: [{ id: "user-1", text: "keep me" }],
        },
      ],
      visibleText: "visible",
    });
  });

  it("skips hidden auto-continuation messages when preparing manual compaction", () => {
    const continuation = buildAutoCompactionContinuationMessage({
      cutType: "turn-boundary",
      now: 1,
      archive: undefined,
    });
    const history = [continuation, userMessage("new request")];

    const result = prepareSessionCompaction(historyEntries(history), {
      systemPrompt: "project instructions",
    });

    expect(result.messagesToSummarize).toHaveLength(1);
    expect(result.userMessageCandidates).toEqual([
      { id: "entry-1", text: "new request", source: "conversation" },
    ]);
    expect(result.formattedHistory).toContain("[System prompt]:\nproject instructions");
    expect(result.formattedHistory).toContain("new request");
    expect(result.formattedHistory).not.toContain(
      "The conversation context before this point has been compacted",
    );
  });

  it("asks the summarizer to select preserved user message ids", () => {
    const entries = historyEntries([
      userMessage("keep this standing constraint"),
      assistantMessage("done"),
      toolResultMessage("verification output"),
      userMessage("ignore this resolved aside"),
    ]);
    const preparation = prepareSessionCompaction(entries, {
      systemPrompt: "project instructions",
    });

    const prompt = buildSessionCompactionPrompt({ preparation });
    expect(prompt).toContain("<user-message-candidates>");
    expect(prompt).toContain('"id": "entry-0"');
    expect(prompt).toContain('"id": "entry-3"');
    expect(prompt).toContain('[User id="entry-0"]:');
    expect(prompt).toContain('[Assistant id="entry-1"]:');
    expect(prompt).toContain('[Tool result id="entry-2"]:');
    expect(prompt).toContain('[User id="entry-3"]:');
    expect(prompt).toContain("<preserved-user-message-ids>");

    const parsed = parseCompactionSummaryResponse({
      response: compactionSummary("## Goal\nContinue", ["entry-0"]),
      userMessageCandidates: preparation.userMessageCandidates,
    });

    expect(parsed).toEqual({
      summary: "## Goal\nContinue",
      preservedUserMessages: [{ id: "entry-0", text: "keep this standing constraint" }],
    });
  });

  it("middle-truncates selected preserved user messages by size", () => {
    const first = `first start ${"a".repeat(60000)} first end`;
    const second = `second start ${"b".repeat(120000)} second end`;

    const parsed = parseCompactionSummaryResponse({
      response: compactionSummary("## Goal\nContinue", ["first", "second"]),
      userMessageCandidates: [
        { id: "first", text: first },
        { id: "second", text: second },
      ],
    });

    expect(parsed.preservedUserMessages).toHaveLength(2);
    expect(parsed.preservedUserMessages[0].text).toContain("first start");
    expect(parsed.preservedUserMessages[0].text).toContain("tokens truncated");
    expect(parsed.preservedUserMessages[0].text).toContain("first end");
    expect(parsed.preservedUserMessages[1].text).toContain("second start");
    expect(parsed.preservedUserMessages[1].text).toContain("tokens truncated");
    expect(parsed.preservedUserMessages[1].text).toContain("second end");
    expect(parsed.preservedUserMessages[1].text.length).toBeGreaterThan(
      parsed.preservedUserMessages[0].text.length,
    );
  });

  it("keeps auto-compaction continuation guidance hidden", () => {
    const continuation = buildAutoCompactionContinuationMessage({
      cutType: "turn-boundary",
      now: 1,
      archive: undefined,
    });

    const text = stripTauUserMetadata(continuation.content[0].text);

    expect(text).toContain("The conversation context before this point has been compacted");
    expect(text).toContain("tool-recovery payloads may be middle-truncated");
    expect(text).not.toContain("retained verbatim");
    expect(hasAutoCompactionContinuationMetadata(continuation)).toBe(true);
  });

  it("uses compaction metadata as previous summary for the next compaction", () => {
    const compactionText = prependTauUserMetadata(
      buildCompactionUserMessage({ summary: "old summary" }),
      [
        {
          type: "compaction",
          version: 1,
          summary: "old summary",
          preservedUserMessages: [{ id: "entry-old", text: "old request" }],
        },
      ],
    );
    const history = [
      {
        role: "user",
        content: [{ type: "text", text: compactionText }],
        timestamp: 0,
      },
      {
        role: "user",
        content: [{ type: "text", text: "new request" }],
        timestamp: 1,
      },
    ];

    const result = prepareSessionCompaction(historyEntries(history), {
      systemPrompt: "project instructions",
    });

    expect(result.previousSummary).toBe("old summary");
    expect(result.messagesToSummarize).toHaveLength(1);
    expect(result.userMessageCandidates).toEqual([
      { id: "entry-old", text: "old request", source: "previous-preserved" },
      { id: "entry-1", text: "new request", source: "conversation" },
    ]);
    expect(result.formattedHistory).toContain("new request");
    expect(result.formattedHistory).not.toContain("old summary");
  });

  it("treats visible compaction text without metadata as ordinary user text", () => {
    const oldVisibleCompactionText = buildCompactionUserMessage({ summary: "old summary" });
    const history = [
      {
        role: "user",
        content: [{ type: "text", text: oldVisibleCompactionText }],
        timestamp: 0,
      },
      {
        role: "user",
        content: [{ type: "text", text: "new request" }],
        timestamp: 1,
      },
    ];

    const result = prepareSessionCompaction(historyEntries(history), {
      systemPrompt: "project instructions",
    });

    expect(result.previousSummary).toBeUndefined();
    expect(result.messagesToSummarize).toHaveLength(2);
    expect(result.userMessageCandidates).toEqual([
      { id: "entry-0", text: oldVisibleCompactionText, source: "conversation" },
      { id: "entry-1", text: "new request", source: "conversation" },
    ]);
    expect(result.formattedHistory).toContain("old summary");
    expect(result.formattedHistory).toContain("new request");
  });

  it("does not offer tool recovery as preservable user intent", () => {
    const recoveryMessage = userMessage(
      formatTauUserText({
        text: "",
        metadata: [{ type: "tool-recovery", version: 1 }],
        hiddenSystemMessages: ["Continue the original request using the recovered tool result."],
      }),
    );
    const entries = historyEntries([userMessage("original request"), recoveryMessage]);

    const result = prepareSessionCompaction(entries, {
      systemPrompt: "project instructions",
    });

    expect(result.userMessageCandidates).toEqual([
      { id: "entry-0", text: "original request", source: "conversation" },
    ]);
    expect(result.formattedHistory).toContain("recovered tool result");
  });

  it("selects auto-compaction user boundaries when the latest turn fits", () => {
    const entries = historyEntries([
      userMessage(`old ${"x".repeat(9000)}`),
      assistantMessage("old answer"),
      userMessage("current request"),
      assistantMessage("current answer"),
    ]);

    const cut = selectAutoCompactionCut(entries, { startIndex: 0, keepRecentTokens: 1000 });

    expect(cut).toEqual({ startIndex: 2, cutType: "turn-boundary" });
  });

  it("does not let encoded image size distort the retained turn boundary", () => {
    const entries = historyEntries([
      userMessage(`old ${"x".repeat(9_000)}`),
      assistantMessage("old answer"),
      userMessage("current request"),
      assistantMessage("image tool call"),
      {
        role: "toolResult",
        toolCallId: "image-call",
        toolName: "view_image",
        content: [{ type: "image", data: "a".repeat(2 * 1024 * 1024), mimeType: "image/png" }],
        isError: false,
        timestamp: 0,
      },
    ]);

    const cut = selectAutoCompactionCut(entries, { startIndex: 0, keepRecentTokens: 6_000 });

    expect(cut).toEqual({ startIndex: 2, cutType: "turn-boundary" });
  });

  it("splits only inside the oversized latest turn at assistant boundaries", () => {
    const entries = historyEntries([
      userMessage("latest request"),
      assistantMessage("tool call one"),
      toolResultMessage(`large output ${"x".repeat(15000)}`),
      assistantMessage("tool call two"),
      toolResultMessage("small output"),
    ]);

    const cut = selectAutoCompactionCut(entries, { startIndex: 0, keepRecentTokens: 1000 });

    expect(cut).toEqual({ startIndex: 3, cutType: "split-turn" });
    expect(entries[cut.startIndex].message.role).toBe("assistant");
  });

  it("keeps tool recovery inside the original user turn", () => {
    const recoveryMessage = userMessage(
      formatTauUserText({
        text: "",
        metadata: [{ type: "tool-recovery", version: 1 }],
        hiddenSystemMessages: [`Recovered tool result ${"x".repeat(15_000)}`],
      }),
    );
    const entries = historyEntries([
      userMessage("latest request"),
      assistantMessage("failed after tool execution"),
      recoveryMessage,
    ]);

    const cut = selectAutoCompactionCut(entries, { startIndex: 0, keepRecentTokens: 1_000 });

    expect(cut).toEqual({ startIndex: 1, cutType: "split-turn" });
  });

  it("splits at an assistant boundary before an oversized latest tool result", () => {
    const entries = historyEntries([
      userMessage("latest request"),
      assistantMessage("tool call"),
      toolResultMessage(`large output ${"x".repeat(15000)}`),
    ]);

    const cut = selectAutoCompactionCut(entries, { startIndex: 0, keepRecentTokens: 1000 });

    expect(cut).toEqual({ startIndex: 1, cutType: "split-turn" });
  });

  it("bounds retained tool result text and preserves the original entry", () => {
    const fullOutput = `large output ${"x".repeat(60_000)}`;
    const entries = historyEntries([
      userMessage("latest request"),
      assistantMessage("tool call"),
      toolResultMessage(fullOutput),
    ]);

    const preparation = prepareAutoCompaction(entries, {
      keepRecentTokens: 1_000,
      systemPrompt: "project instructions",
    });

    const retainedToolResult = preparation.retainedEntries[1].message;
    expect(retainedToolResult.role).toBe("toolResult");
    expect(retainedToolResult.content[0].text).toContain("tokens truncated");
    expect(retainedToolResult.content[0].text.length).toBeLessThan(fullOutput.length);
    expect(entries[2].message.content[0].text).toBe(fullOutput);
  });

  it("bounds retained tool-recovery results and preserves the original entry", () => {
    const recoveryInstructions = [
      "The previous assistant generation failed after tool execution had begun.",
      "<tool-execution-records>",
      '  <tool-execution-record tool-call-id="call-1" tool-name="custom_tool">',
      "    <arguments-json>{}</arguments-json>",
      "    <is-error>false</is-error>",
      `    <result-text>start ${"x".repeat(60_000)} end</result-text>`,
      "  </tool-execution-record>",
      "</tool-execution-records>",
    ].join("\n");
    const recoveryMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: formatTauUserText({
            text: "",
            metadata: [{ type: "tool-recovery", version: 1 }],
            hiddenSystemMessages: [recoveryInstructions],
          }),
        },
      ],
      timestamp: 0,
    };
    const entries = historyEntries([
      userMessage("older request"),
      assistantMessage("older answer"),
      recoveryMessage,
    ]);
    const originalRecoveryMessage = structuredClone(recoveryMessage);

    const preparation = prepareAutoCompaction(entries, {
      keepRecentTokens: 1_000,
      systemPrompt: "project instructions",
    });

    const retainedRecoveryEntry = preparation.retainedEntries.find((entry) =>
      hasToolRecoveryMetadata(entry.message),
    );
    expect(retainedRecoveryEntry).toBeDefined();
    const retainedRecovery = retainedRecoveryEntry.message;
    expect(retainedRecovery.role).toBe("user");
    expect(retainedRecovery.content[0].text).toContain("tokens truncated");
    expect(retainedRecovery.content[0].text.length).toBeLessThan(
      recoveryMessage.content[0].text.length,
    );
    expect(entries[2].message).toEqual(originalRecoveryMessage);
  });

  it("adds a dedicated split-turn handoff to the compaction prompt", () => {
    const entries = historyEntries([
      userMessage("latest request"),
      assistantMessage("tool call"),
      toolResultMessage(`large output ${"x".repeat(15_000)}`),
    ]);
    const preparation = prepareAutoCompaction(entries, {
      keepRecentTokens: 1_000,
      systemPrompt: "project instructions",
    });

    const prompt = buildAutoCompactionPrompt(preparation);

    expect(prompt).toContain('Add a "## Current Turn Handoff" section');
    expect(prompt).toContain("what the first retained message is continuing");
    expect(prompt).toContain("When best-effort archiving succeeds");
    expect(prompt).toContain("Conversation records above that show an archive entry id");
    expect(prompt).toContain("When the pre-compaction archive is available");
    expect(prompt).toContain("auto-compaction archive entry id");
    expect(prompt).toContain("use the supplied files, not the separate history tool");
    expect(prompt).toContain(
      "tool-recovery payloads in the retained context may be middle-truncated",
    );
    expect(prompt).not.toContain("retained context will include recent messages verbatim");
    expect(prompt).toContain("Good pattern:");
    expect(prompt).toContain("Bad pattern:");
  });

  it.each(["error", "aborted"])("withholds archive ids from %s assistant records", (stopReason) => {
    const failedAssistant = {
      ...assistantMessage("provider failed"),
      stopReason,
      errorMessage: "connection reset",
    };
    const entries = historyEntries([
      userMessage(`older request ${"x".repeat(9_000)}`),
      failedAssistant,
      userMessage("current request"),
      assistantMessage("current answer"),
    ]);
    const preparation = prepareAutoCompaction(entries, {
      keepRecentTokens: 1_000,
      systemPrompt: "project instructions",
    });

    expect(preparation.formattedHistory).toContain('[User id="entry-0"]:');
    expect(preparation.formattedHistory).toContain("[Assistant]:\nprovider failed");
    expect(preparation.formattedHistory).not.toContain('[Assistant id="entry-1"]:');
  });

  it("keeps an oversized latest user-only turn whole when older history can be compacted", () => {
    const entries = historyEntries([
      userMessage("older request"),
      assistantMessage("older answer"),
      userMessage(`latest request ${"x".repeat(15000)}`),
    ]);

    const cut = selectAutoCompactionCut(entries, { startIndex: 0, keepRecentTokens: 1000 });

    expect(cut).toEqual({ startIndex: 2, cutType: "turn-boundary" });
  });

  it("does not split an oversized latest turn without older history or an assistant boundary", () => {
    const entries = historyEntries([userMessage(`latest request ${"x".repeat(15000)}`)]);

    expect(
      selectAutoCompactionCut(entries, { startIndex: 0, keepRecentTokens: 1000 }),
    ).toBeUndefined();
  });

  it("does not carry hidden auto-continuation messages into repeated auto-compactions", () => {
    const previousSummaryText = prependTauUserMetadata(
      buildCompactionUserMessage({ summary: "old summary" }),
      [
        {
          type: "auto-compaction",
          version: 1,
          summary: "old summary",
          preservedUserMessages: [],
          cutType: "turn-boundary",
          retainedMessageCount: 2,
        },
      ],
    );
    const continuation = buildAutoCompactionContinuationMessage({
      cutType: "turn-boundary",
      now: 2,
      archive: undefined,
    });
    const entries = historyEntries([
      userMessage(previousSummaryText),
      userMessage("current request"),
      continuation,
      assistantMessage("tool call"),
      toolResultMessage(`large output ${"x".repeat(15000)}`),
    ]);

    const preparation = prepareAutoCompaction(entries, {
      keepRecentTokens: 1000,
      systemPrompt: "project instructions",
    });

    expect(preparation.cutType).toBe("split-turn");
    expect(preparation.userMessageCandidates).toEqual([
      { id: "entry-1", text: "current request", source: "conversation" },
    ]);
    expect(preparation.formattedHistory).toContain("current request");
    expect(preparation.formattedHistory).not.toContain(
      "The conversation context before this point has been compacted",
    );
    expect(preparation.retainedEntries.map((entry) => entry.id)).toEqual(["entry-3", "entry-4"]);
    expect(preparation.retainedEntries.some((entry) => entry.message === continuation)).toBe(false);
  });

  it("splits repeated auto-compactions inside an ongoing assistant turn", () => {
    const previousSummaryText = prependTauUserMetadata(
      buildCompactionUserMessage({ summary: "old summary" }),
      [
        {
          type: "auto-compaction",
          version: 1,
          summary: "old summary",
          preservedUserMessages: [],
          cutType: "split-turn",
          retainedMessageCount: 2,
        },
      ],
    );
    const continuation = buildAutoCompactionContinuationMessage({
      cutType: "split-turn",
      now: 2,
      archive: undefined,
    });
    const entries = historyEntries([
      userMessage(previousSummaryText),
      assistantMessage("retained previous tool call"),
      toolResultMessage("small retained output"),
      continuation,
      assistantMessage("next diagnostic tool call"),
      toolResultMessage(`large diagnostic output ${"x".repeat(15000)}`),
      assistantMessage("final small explanation"),
    ]);

    const preparation = prepareAutoCompaction(entries, {
      keepRecentTokens: 1000,
      systemPrompt: "project instructions",
    });

    expect(preparation.cutType).toBe("split-turn");
    expect(preparation.formattedHistory).toContain("retained previous tool call");
    expect(preparation.formattedHistory).toContain("next diagnostic tool call");
    expect(preparation.formattedHistory).not.toContain(
      "The conversation context before this point has been compacted",
    );
    expect(preparation.retainedEntries.map((entry) => entry.id)).toEqual(["entry-6"]);
  });

  it("prepares auto-compaction with auto metadata and hidden continuation messages", () => {
    const previousSummaryText = prependTauUserMetadata(
      buildCompactionUserMessage({ summary: "old summary" }),
      [
        {
          type: "auto-compaction",
          version: 1,
          summary: "old summary",
          preservedUserMessages: [],
          cutType: "turn-boundary",
          retainedMessageCount: 2,
        },
      ],
    );
    const continuation = buildAutoCompactionContinuationMessage({
      cutType: "turn-boundary",
      now: 2,
      archive: undefined,
    });
    const entries = historyEntries([
      userMessage(previousSummaryText),
      userMessage("retained old request"),
      continuation,
      userMessage(`new request ${"x".repeat(9000)}`),
      userMessage("current request"),
    ]);

    const preparation = prepareAutoCompaction(entries, {
      keepRecentTokens: 1000,
      systemPrompt: "project instructions",
    });

    expect(preparation.previousSummary).toBe("old summary");
    expect(preparation.userMessageCandidates).toEqual([
      { id: "entry-1", text: "retained old request", source: "conversation" },
      { id: "entry-3", text: `new request ${"x".repeat(9000)}`, source: "conversation" },
    ]);
    expect(preparation.formattedHistory).toContain("retained old request");
    expect(preparation.formattedHistory).toContain("new request");
    expect(preparation.formattedHistory).not.toContain(
      "The conversation context before this point has been compacted",
    );
    expect(preparation.retainedEntries.map((entry) => entry.id)).toEqual(["entry-4"]);
    expect(getAutoCompactionMetadataFromMessage(entries[0].message)).toEqual({
      type: "auto-compaction",
      version: 1,
      summary: "old summary",
      preservedUserMessages: [],
      cutType: "turn-boundary",
      retainedMessageCount: 2,
    });
    expect(hasAutoCompactionContinuationMetadata(continuation)).toBe(true);
  });
});

function compactionSummary(summary, preservedUserMessageIds = []) {
  return `${summary}\n\n<preserved-user-message-ids>\n${JSON.stringify(preservedUserMessageIds)}\n</preserved-user-message-ids>`;
}

function historyEntries(messages) {
  return messages.map((message, index) => ({ id: `entry-${index}`, message }));
}

function userMessage(text) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  };
}

function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 0,
    provider: "test",
    model: "test",
    api: "test",
    stopReason: "stop",
  };
}

function assistantMessageWithUsage(text, totalTokens, model) {
  return withAssistantUsage(assistantMessage(text), totalTokens, model);
}

function withAssistantUsage(message, totalTokens, model) {
  return {
    ...message,
    provider: model.provider,
    model: model.id,
    usage: {
      input: totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function toolResultMessage(text) {
  return {
    role: "toolResult",
    toolCallId: `tool-${text.length}`,
    toolName: TOOL_NAME_BASH,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  };
}
