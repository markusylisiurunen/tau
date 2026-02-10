import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../dist/core/commands/index.js";
import { personas } from "../dist/core/personas.js";
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
      copy: async () => calls.push({ type: "copy" }),
      copyCode: async () => calls.push({ type: "copyCode" }),
      checkpoint: async () => calls.push({ type: "checkpoint" }),
      newSession: () => calls.push({ type: "new" }),
      rewind: () => calls.push({ type: "rewind" }),
      cd: () => calls.push({ type: "cd" }),
      compactOnlySummary: async () => calls.push({ type: "compactOnlySummary" }),
      compactSummaryAndLastTurn: async () => calls.push({ type: "compactSummaryAndLastTurn" }),
      pruneEarliestFirst: () => calls.push({ type: "pruneEarliestFirst" }),
      pruneLargestFirst: () => calls.push({ type: "pruneLargestFirst" }),
      pruneLeastImportant: () => calls.push({ type: "pruneLeastImportant" }),
      reload: async () => calls.push({ type: "reload" }),
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

    const unknown = registry.parse("/not-a-command");
    await registry.dispatch(unknown, ctx);

    expect(calls).toContainEqual({ type: "risk", level: "read-only" });
    expect(calls).toContainEqual({ type: "rewind" });
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

describe("context builder", () => {
  it("renders environment and project context blocks", () => {
    const tag = buildEnvironmentTag({
      datetime: "2025-01-01T00:00:00.000Z",
      cwd: "/repo",
      riskLevel: "read-only",
      platform: "darwin",
      nodeVersion: "v20.0.0",
    });

    expect(tag).toContain("<platform>darwin</platform>");
    expect(tag).toContain("<node>v20.0.0</node>");

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
