import { describe, expect, it, vi } from "vitest";

const { appendUsageLogEntryMock, coreSessionOptions } = vi.hoisted(() => ({
  appendUsageLogEntryMock: vi.fn(),
  coreSessionOptions: [],
}));

vi.mock("../src/core/runtime/deps.ts", () => ({
  createDefaultCoreDeps: () => ({
    clock: { now: () => 1234 },
    env: {
      home: () => "/home/test",
      platform: () => "darwin",
      nodeVersion: () => "v24.0.0",
    },
    fs: {
      readFile: () => "",
    },
    spawn: vi.fn(),
  }),
}));

vi.mock("../src/core/runtime/runtime_bootstrap.ts", () => ({
  resolveRuntimePromptBootstrap: () => ({
    promptContext: {
      cwd: "/repo",
      home: "/home/test",
      includeAgentContext: true,
      projectContextBlock: "### Project context\n",
      skillsBlock: "### Skills\n",
    },
  }),
}));

vi.mock("../src/core/runtime/session_prompt_composer.ts", () => ({
  composeSessionPrompts: (args) => ({
    environmentTag: `<environment datetime="${args.datetime}"></environment>`,
    baseSystemPrompt: `review system prompt ${args.datetime}`,
    subagentPrompts: { reviewer: `subagent prompt ${args.datetime}` },
  }),
}));

vi.mock("../src/core/session/core_session.ts", () => ({
  CoreSession: class CoreSession {
    historyEntries = [];

    constructor(options) {
      coreSessionOptions.push(options);
    }

    addUserText() {}
    addMessage(message, options) {
      this.historyEntries.push({
        id: options?.historyEntryId ?? `history-${this.historyEntries.length}`,
        message,
      });
    }
    get sessionId() {
      return "review-session-1";
    }
  },
}));

vi.mock("../src/core/runtime/conversation_turn_runtime.ts", () => ({
  ConversationTurnRuntime: class ConversationTurnRuntime {
    session;

    constructor(session) {
      this.session = session;
    }

    async run(options) {
      options?.onEvent?.({
        type: "tool_ui",
        uiEvent: {
          type: "bash_started",
          toolCallId: "tool-1",
          command: "git diff --staged",
          headerTarget: "git diff --staged",
        },
      });
      const message = {
        role: "assistant",
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-opus-4-7",
        timestamp: 999,
        usage: {
          input: 10,
          output: 4,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 17,
          cost: { total: 0.42 },
        },
        content: [{ type: "text", text: "review answer" }],
      };
      this.session.historyEntries.push({ message });
      options?.onEvent?.({
        type: "assistant_final",
        historyEntryId: "assistant-1",
        message,
      });
      return { aborted: false };
    }

    interrupt() {
      return false;
    }
  },
}));

vi.mock("../src/core/static/index.ts", () => ({
  renderDiffReviewWrapperPrompt: () => "wrapped prompt",
}));

vi.mock("../src/core/tools/catalog.ts", () => ({
  ToolCatalog: {
    createSubagentRegistry: () => ({}),
  },
}));

vi.mock("../src/core/tools/execution_backend.ts", () => ({
  createLocalToolExecutionBackend: () => ({}),
}));

vi.mock("../src/core/tools/bash.ts", () => ({
  BASH_TOOL: { name: "bash" },
}));

vi.mock("../src/core/tools/view_image.ts", () => ({
  VIEW_IMAGE_TOOL: { name: "view_image" },
}));

vi.mock("../src/core/tools/tool_names.ts", () => ({
  TOOL_NAME_BASH: "bash",
  TOOL_NAME_VIEW_IMAGE: "view_image",
}));

vi.mock("../src/core/usage/logs.ts", () => ({
  appendUsageLogEntry: appendUsageLogEntryMock,
  getUsageTotals: (usage) => ({
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    total: usage?.totalTokens ?? 0,
  }),
  getUsageCostTotal: (usage) => usage?.cost?.total ?? 0,
}));

import { DiffReviewThread } from "../src/core/diff_review/review_thread.ts";
import { DiffReviewSnapshot, formatDiffReviewScope } from "../src/core/diff_review/snapshot.ts";

describe("diff_review thread", () => {
  it("records review agent usage", async () => {
    appendUsageLogEntryMock.mockReset();

    const snapshot = new DiffReviewSnapshot({
      repoRoot: "/repo",
      cwd: "/repo",
      diffArgs: [],
      patch: "diff --git a/src/a.ts b/src/a.ts",
      files: [{ path: "src/a.ts", status: "modified", newPath: "src/a.ts" }],
      patchByPath: new Map([["src/a.ts", "diff --git a/src/a.ts b/src/a.ts"]]),
      scopeLabel: formatDiffReviewScope([]),
    });

    const thread = new DiffReviewThread({
      threadId: "thread-1",
      snapshot,
      persona: {
        id: "coder",
        label: "coder",
        model: { provider: "anthropic", id: "claude-opus-4-7", contextWindow: 200000 },
        systemPrompt: "main system prompt",
        settings: { reasoning: "high" },
        skills: "*",
        source: "builtin",
      },
      config: {},
    });

    await expect(thread.submitMessage("what changed?")).resolves.toBe("review answer");
    expect(appendUsageLogEntryMock).toHaveBeenCalledWith({
      timestamp: 999,
      sessionId: "review-session-1",
      personaId: "coder",
      provider: "anthropic",
      model: "claude-opus-4-7",
      api: "anthropic-messages",
      reasoningEffort: "high",
      usage: {
        input: 10,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
        total: 17,
      },
      cost: { total: 0.42 },
      agent: { type: "review" },
    });
  });

  it("emits cumulative review agent updates", async () => {
    const updates = [];
    const snapshot = new DiffReviewSnapshot({
      repoRoot: "/repo",
      cwd: "/repo",
      diffArgs: [],
      patch: "diff --git a/src/a.ts b/src/a.ts",
      files: [{ path: "src/a.ts", status: "modified", newPath: "src/a.ts" }],
      patchByPath: new Map([["src/a.ts", "diff --git a/src/a.ts b/src/a.ts"]]),
      scopeLabel: formatDiffReviewScope([]),
    });

    const thread = new DiffReviewThread({
      threadId: "thread-1",
      snapshot,
      persona: {
        id: "coder",
        label: "coder",
        model: { provider: "anthropic", id: "claude-opus-4-7", contextWindow: 200000 },
        systemPrompt: "main system prompt",
        settings: { reasoning: "high" },
        skills: "*",
        source: "builtin",
      },
      config: {},
      onUpdate: (update) => {
        updates.push(update);
      },
    });

    await thread.submitMessage("what changed?");

    expect(updates).toEqual(
      expect.arrayContaining([
        {
          costTotal: 0,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            contextWindowUsageTokens: 0,
            contextWindow: 200000,
          },
          lastActivityText: "bash running: git diff --staged",
        },
        {
          costTotal: 0.42,
          usage: {
            input: 10,
            output: 4,
            cacheRead: 2,
            cacheWrite: 1,
            contextWindowUsageTokens: 17,
            contextWindow: 200000,
          },
          lastActivityText: "agent: review answer",
        },
      ]),
    );
  });

  it("inherits usage baselines when forking while resetting cost", async () => {
    coreSessionOptions.length = 0;
    const snapshot = new DiffReviewSnapshot({
      repoRoot: "/repo",
      cwd: "/repo",
      diffArgs: [],
      patch: "diff --git a/src/a.ts b/src/a.ts",
      files: [{ path: "src/a.ts", status: "modified", newPath: "src/a.ts" }],
      patchByPath: new Map([["src/a.ts", "diff --git a/src/a.ts b/src/a.ts"]]),
      scopeLabel: formatDiffReviewScope([]),
    });

    const parent = new DiffReviewThread({
      threadId: "thread-parent",
      snapshot,
      persona: {
        id: "coder",
        label: "coder",
        model: { provider: "anthropic", id: "claude-opus-4-7", contextWindow: 200000 },
        systemPrompt: "main system prompt",
        settings: { reasoning: "high" },
        skills: "*",
        source: "builtin",
      },
      config: {},
    });
    await parent.submitMessage("bootstrap");

    const childUpdates = [];
    const child = new DiffReviewThread({
      threadId: "thread-child",
      snapshot,
      persona: {
        id: "coder",
        label: "coder",
        model: { provider: "anthropic", id: "claude-opus-4-7", contextWindow: 200000 },
        systemPrompt: "main system prompt",
        settings: { reasoning: "high" },
        skills: "*",
        source: "builtin",
      },
      config: {},
      forkFrom: parent.createForkSource(),
      onUpdate: (update) => {
        childUpdates.push(update);
      },
    });

    expect(coreSessionOptions).toHaveLength(2);
    expect(coreSessionOptions[1]).toMatchObject({
      systemPrompt: coreSessionOptions[0].systemPrompt,
      subagentPrompts: coreSessionOptions[0].subagentPrompts,
    });
    expect(coreSessionOptions[1].systemPrompt).toBe(coreSessionOptions[0].systemPrompt);
    expect(coreSessionOptions[1].subagentPrompts).toEqual(coreSessionOptions[0].subagentPrompts);

    expect(childUpdates[0]).toEqual({
      costTotal: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        contextWindowUsageTokens: 17,
        contextWindow: 200000,
      },
    });

    await child.submitMessage("thread question");

    expect(childUpdates).toEqual(
      expect.arrayContaining([
        {
          costTotal: 0,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            contextWindowUsageTokens: 17,
            contextWindow: 200000,
          },
        },
        {
          costTotal: 0.42,
          usage: {
            input: 10,
            output: 4,
            cacheRead: 2,
            cacheWrite: 1,
            contextWindowUsageTokens: 17,
            contextWindow: 200000,
          },
          lastActivityText: "agent: review answer",
        },
      ]),
    );
  });
});
