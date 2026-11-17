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
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRuntimePromptBootstrap } from "../dist/core/runtime/runtime_bootstrap.js";
import {
  AUTO_COMPACTION_ARCHIVE_DOCUMENTATION,
  createAutoCompactionArchiver,
} from "../dist/core/session/auto_compaction_archive.js";
import {
  buildAutoCompactionContinuationMessage,
  prepareAutoCompaction,
  prepareSessionCompaction,
  selectAutoCompactionCut,
} from "../dist/core/session/compaction.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { TOOL_NAME_BASH } from "../dist/core/tools/tool_names.js";
import {
  buildCompactionUserMessage,
  formatHistoryForCompaction,
} from "../dist/core/utils/compact.js";
import {
  formatTauUserText,
  getAutoCompactionMetadataFromMessage,
  getCompactionMetadataFromMessage,
  hasAutoCompactionContinuationMetadata,
  hasToolRecoveryMetadata,
  prependTauUserMetadata,
  stripTauUserDisplayText,
  stripTauUserMetadata,
  stripTauUserMetadataFromMessage,
  TAU_USER_METADATA_PREFIX,
} from "../dist/core/utils/user_metadata.js";

describe("runtime prompt bootstrap", () => {
  it("keeps ancestor AGENTS files when resolving prompt context through a command", async () => {
    const resolved = await resolveRuntimePromptBootstrap({
      discoveredSkills: [],
      cwd: "/workspace/repo",
      home: "/workspace",
      includeAgentContext: true,
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

  it("disables automatic AGENTS injection and scanning while exposing every discovered skill", async () => {
    const home = mkdtempSync(join(tmpdir(), "tau-context-disabled-"));
    try {
      const cwd = join(home, "repo");
      mkdirSync(join(cwd, "child"), { recursive: true });
      writeFileSync(join(cwd, "AGENTS.md"), "root instructions");
      writeFileSync(join(cwd, "child", "AGENTS.md"), "child instructions");
      const resolved = await resolveRuntimePromptBootstrap({
        cwd,
        home,
        includeAgentContext: false,
        discoveredSkills: ["alpha", "beta"].map((name) => ({
          name,
          description: `${name} skill`,
          path: join(cwd, name, "SKILL.md"),
        })),
        backend: createLocalToolExecutionBackend(),
      });
      expect(resolved.agentsFiles).toEqual([]);
      expect(resolved.promptContext.projectContextBlock).toBeUndefined();
      expect(resolved.promptContext.skillsBlock).toContain("alpha");
      expect(resolved.promptContext.skillsBlock).toContain("beta");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
        discoveredSkills: [],
        cwd: home,
        home,
        includeAgentContext: true,
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
        discoveredSkills: [],
        cwd: repo,
        home,
        includeAgentContext: true,
        backend: createLocalToolExecutionBackend(),
      });

      expect(resolved.agentsFiles).toEqual([]);
      expect(resolved.promptContext.projectContextBlock).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("summary formatting", () => {
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
      expect(documentation).toBe(AUTO_COMPACTION_ARCHIVE_DOCUMENTATION);
      const continuation = buildAutoCompactionContinuationMessage({
        cutType: "split-turn",
        now: request.createdAt,
        archive: first,
      });
      expect(stripTauUserMetadata(continuation.content[0].text)).toContain(documentation);

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
  it("round-trips tau user metadata", () => {
    const visibleText = buildCompactionUserMessage({ summary: "## Goal\nShip feature" });
    const text = prependTauUserMetadata(visibleText, [
      {
        type: "compaction",
        version: 1,
        summary: "## Goal\nShip feature",
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
    });
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

    expect(cut).toEqual({ startIndex: 1, cutType: "split-turn" });
  });

  it("splits at complete assistant/tool exchange boundaries", () => {
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

  it("keeps multiple tool results together and does not skip a group to fill spare budget", () => {
    const entries = historyEntries([
      userMessage(`older request ${"x".repeat(9000)}`),
      assistantMessage("small earlier exchange"),
      toolResultMessage("small earlier result"),
      assistantMessage("parallel tool calls"),
      toolResultMessage(`first ${"x".repeat(2000)}`),
      toolResultMessage(`second ${"x".repeat(12000)}`),
      toolResultMessage(`third ${"x".repeat(2000)}`),
      userMessage("now check staging"),
      assistantMessage(`latest work ${"x".repeat(4000)}`),
    ]);
    const preparation = prepareAutoCompaction(entries, { keepRecentTokens: 3000 });
    expect(preparation.retainedEntries).toEqual(entries.slice(7));
  });

  it("does not carry hidden auto-continuation messages into repeated auto-compactions", () => {
    const previousSummaryText = prependTauUserMetadata(
      buildCompactionUserMessage({ summary: "old summary" }),
      [
        {
          type: "auto-compaction",
          version: 1,
          summary: "old summary",

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
    });

    expect(preparation.cutType).toBe("split-turn");
    expect(JSON.stringify(preparation.messagesToSummarize)).toContain("current request");
    expect(JSON.stringify(preparation.messagesToSummarize)).not.toContain(
      "The conversation context before this point has been compacted",
    );
    expect(preparation.retainedEntries).toEqual([]);
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
    });

    expect(preparation.cutType).toBe("split-turn");
    expect(preparation.messagesToSummarize[0]).toEqual(entries[0].message);
    expect(JSON.stringify(preparation.messagesToSummarize)).toContain(
      "retained previous tool call",
    );
    expect(JSON.stringify(preparation.messagesToSummarize)).toContain("next diagnostic tool call");
    expect(JSON.stringify(preparation.messagesToSummarize)).not.toContain(
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
    });

    expect(JSON.stringify(preparation.messagesToSummarize)).toContain("retained old request");
    expect(JSON.stringify(preparation.messagesToSummarize)).toContain("new request");
    expect(JSON.stringify(preparation.messagesToSummarize)).not.toContain(
      "The conversation context before this point has been compacted",
    );
    expect(preparation.retainedEntries.map((entry) => entry.id)).toEqual(["entry-4"]);
    expect(getAutoCompactionMetadataFromMessage(entries[0].message)).toEqual({
      type: "auto-compaction",
      version: 1,
      summary: "old summary",

      cutType: "turn-boundary",
      retainedMessageCount: 2,
    });
    expect(hasAutoCompactionContinuationMetadata(continuation)).toBe(true);
  });
});

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

describe("native system instruction compaction", () => {
  const instruction = (content, type = "instruction") => ({
    role: "system",
    content,
    timestamp: 1,
    metadata: { type, version: 1 },
  });

  it("summarizes ordinary instructions but excludes obsolete continuation guidance", () => {
    const entries = historyEntries([
      userMessage(`older request ${"x".repeat(9_000)}`),
      instruction("older native instruction"),
      instruction("obsolete prefix", "auto-compaction-continuation"),
      assistantMessage("older answer"),
      userMessage("new request"),
      instruction("retained native instruction"),
      instruction("obsolete tail", "auto-compaction-continuation"),
      assistantMessage("new answer"),
    ]);
    const before = structuredClone(entries);
    const manual = prepareSessionCompaction(entries);
    expect(JSON.stringify(manual.messagesToSummarize)).toContain("older native instruction");
    expect(JSON.stringify(manual.messagesToSummarize)).toContain("retained native instruction");
    expect(JSON.stringify(manual.messagesToSummarize)).not.toContain("obsolete");
    const auto = prepareAutoCompaction(entries, {
      keepRecentTokens: 1_000,
    });
    expect(JSON.stringify(auto.messagesToSummarize)).toContain("older native instruction");
    expect(JSON.stringify(auto.messagesToSummarize)).not.toContain("obsolete");
    expect(auto.retainedEntries.map((entry) => entry.id)).toEqual([
      "entry-1",
      "entry-3",
      "entry-4",
      "entry-5",
      "entry-7",
    ]);
    expect(auto.retainedEntries[3].message.metadata).toEqual({ type: "instruction", version: 1 });
    const withLargeObsoleteMessage = structuredClone(entries);
    withLargeObsoleteMessage[6].message.content = "obsolete".repeat(20_000);
    const sameCut = prepareAutoCompaction(withLargeObsoleteMessage, {
      keepRecentTokens: 1_000,
    });
    expect(sameCut.cutType).toBe(auto.cutType);
    expect(sameCut.retainedEntries).toEqual(auto.retainedEntries);
    expect(entries).toEqual(before);
  });
});
