import { describe, expect, it, vi } from "vitest";
import { createDiffReviewToolDefinition } from "../dist/core/tools/diff_review.js";

function createToolCall(args = { source: "git_diff", diffArgs: ["--staged"] }) {
  return {
    id: "tool-call-1",
    type: "toolCall",
    name: "diff_review",
    arguments: args,
  };
}

function createBridge(overrides = {}) {
  return {
    snapshot: {
      files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
    },
    getUiState: () => ({
      diffToolUiText: "http://127.0.0.1:4321",
      reviewAgents: [],
    }),
    onUiStateChange: vi.fn((listener) => {
      listener({
        diffToolUiText: "http://127.0.0.1:4321",
        reviewAgents: [],
      });
      return () => {};
    }),
    cancel: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("diff_review tool", () => {
  it("returns completed review feedback as a plain tool result with review context", async () => {
    let resolveResult;
    const result = new Promise((resolve) => {
      resolveResult = resolve;
    });
    const bridge = createBridge();
    const startSession = vi.fn(async () => ({ bridge, result }));
    const definition = createDiffReviewToolDefinition({
      getDiffToolConfig: () => ({ command: "tau-diff-tool" }),
      startSession,
    });

    const dispatched = await definition.dispatch(
      createToolCall(),
      "read-only",
      new AbortController().signal,
      { scope: "main" },
    );

    expect(dispatched.kind).toBe("phased");
    expect(dispatched.startedUiEvent).toMatchObject({
      type: "diff_review_started",
      command: "git diff --staged",
    });

    const nextUi = dispatched.uiEvents[Symbol.asyncIterator]().next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(nextUi).resolves.toMatchObject({
      value: {
        type: "diff_review_updated",
        diffToolUiText: "http://127.0.0.1:4321",
      },
      done: false,
    });

    resolveResult({ status: "returned", review: "Looks good." });
    const final = await dispatched.run;

    expect(final.toolResult.isError).toBe(false);
    expect(final.toolResult.content[0].text).toContain("Diff review completed.");
    expect(final.toolResult.content[0].text).toContain("Reviewed scope: git diff --staged");
    expect(final.toolResult.content[0].text).toContain("- src/a.ts");
    expect(final.toolResult.content[0].text).toContain("Treat the returned review as feedback");
    expect(final.toolResult.content[0].text).toContain("Looks good.");
    expect(final.toolResult.content[0].text).not.toContain("<system>");
    expect(final.uiEvent).toMatchObject({
      type: "diff_review_finished",
      status: "success",
      reviewedFiles: ["src/a.ts", "src/b.ts"],
      uiText: {
        statusLine: "success · 2 reviewed files",
      },
    });
    expect(final.uiEvent.uiText.fullLines.map((line) => line.text).join("\n")).toBe(
      final.toolResult.content[0].text,
    );
    expect(startSession).toHaveBeenCalledWith({
      source: { kind: "git_diff", diffArgs: ["--staged"] },
      diffTool: { command: "tau-diff-tool" },
      signal: expect.any(AbortSignal),
    });
  });

  it("starts patch-file reviews with multiple patch files", async () => {
    const result = Promise.resolve({ status: "cancelled", reason: "tool_cancelled" });
    const bridge = createBridge();
    const startSession = vi.fn(async () => ({ bridge, result }));
    const definition = createDiffReviewToolDefinition({
      getDiffToolConfig: () => ({ command: "tau-diff-tool" }),
      startSession,
    });

    const dispatched = await definition.dispatch(
      createToolCall({
        source: "patch_files",
        patchFiles: ["/tmp/one.patch", "/tmp/two.patch"],
        label: "selected hunks",
      }),
      "read-only",
      new AbortController().signal,
      { scope: "main" },
    );

    expect(dispatched.kind).toBe("phased");
    expect(dispatched.startedUiEvent).toMatchObject({
      type: "diff_review_started",
      command: "selected hunks",
    });
    await dispatched.run;
    expect(startSession).toHaveBeenCalledWith({
      source: {
        kind: "patch_files",
        patchFiles: ["/tmp/one.patch", "/tmp/two.patch"],
        scopeLabel: "selected hunks",
      },
      diffTool: { command: "tau-diff-tool" },
      signal: expect.any(AbortSignal),
    });
  });

  it("blocks outside the main assistant", async () => {
    const definition = createDiffReviewToolDefinition({
      getDiffToolConfig: () => ({ command: "tau-diff-tool" }),
      startSession: vi.fn(),
    });

    const result = await definition.dispatch(
      createToolCall(),
      "read-only",
      new AbortController().signal,
      { scope: "subagent" },
    );

    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(true);
    expect(result.uiEvent).toMatchObject({
      type: "diff_review_blocked",
      reason: "diff_review is only available to the main assistant, not subagents.",
    });
  });
});
