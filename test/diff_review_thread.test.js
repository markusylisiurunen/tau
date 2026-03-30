import { describe, expect, it, vi } from "vitest";

const { appendUsageLogEntryMock } = vi.hoisted(() => ({
  appendUsageLogEntryMock: vi.fn(),
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
      hostCwd: "/repo",
      home: "/home/test",
      includeAgentContext: true,
      projectContextBlock: "### Project context\n",
      sandboxEnabled: false,
      skillsBlock: "### Skills\n",
    },
  }),
}));

vi.mock("../src/core/runtime/session_prompt_composer.ts", () => ({
  composeSessionPrompts: () => ({
    environmentTag: "<environment></environment>",
    baseSystemPrompt: "review system prompt",
    subagentPrompts: {},
  }),
}));

vi.mock("../src/core/session/core_session.ts", () => ({
  CoreSession: class CoreSession {
    historyEntries = [];
    addUserText() {}
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

    async run() {
      this.session.historyEntries.push({
        message: {
          role: "assistant",
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-opus-4-6",
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
        },
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
  createLocalToolExecutionBackend: () => ({ kind: "local" }),
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
import { DiffReviewSnapshot } from "../src/core/diff_review/snapshot.ts";

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
    });

    const thread = new DiffReviewThread({
      threadId: "thread-1",
      snapshot,
      persona: {
        id: "coder",
        label: "coder",
        model: { provider: "anthropic", id: "claude-opus-4-6" },
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
      model: "claude-opus-4-6",
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
});
