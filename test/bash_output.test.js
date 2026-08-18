import { describe, expect, it } from "vitest";
import {
  buildBashPresentation,
  createBashToolDefinition,
  formatBashToolResultText,
  getBashOutputPolicy,
  prepareBashOutput,
} from "../dist/core/tools/bash.js";
import { tokensToBytes } from "../dist/core/utils/token.js";

const backend = {
  async runBash() {
    return {
      output: "command output\n",
      stdout: "command output\n",
      exitCode: 0,
      truncated: false,
      timedOut: false,
      aborted: false,
      closeSignal: null,
    };
  },
  async runNodeScript() {
    return {
      output: "/tmp/tau-bash-output-test.log",
      stdout: "/tmp/tau-bash-output-test.log",
      exitCode: 0,
      truncated: false,
    };
  },
  async writeFile(path, content) {
    return {
      path,
      bytes: Buffer.byteLength(content, "utf-8"),
      lines: content.split("\n").length,
    };
  },
};

async function runTool(tool, toolCall, signal = new AbortController().signal) {
  const activities = [];
  const outcome = await tool.execute(toolCall, {
    agentId: "test-agent",
    turnId: "test-turn",
    assistantMessageId: "test-assistant",
    signal,
    emitActivity: async (activity) => activities.push(activity),
  });
  return {
    toolResult: { ...outcome, toolCallId: toolCall.id, toolName: toolCall.name },
    uiEvent: activities.at(-1),
    activities,
  };
}

function bashOutput(content) {
  const bytes = Buffer.byteLength(content);
  const lines = content ? content.split("\n").length - Number(content.endsWith("\n")) : 0;
  return {
    output: content,
    model: {
      content,
      truncated: false,
      totalLines: lines,
      outputLines: lines,
      totalBytes: bytes,
      outputBytes: bytes,
    },
    captureTruncated: false,
  };
}

describe("bash output policy", () => {
  it("rejects unknown execution arguments", async () => {
    const tool = createBashToolDefinition(backend, "/project");
    expect(tool.schema.parameters.properties.workingDirectory.pattern).toBe("^[^\\r\\n]+$");
    const result = await runTool(
      tool,
      {
        id: "bash-1",
        name: "bash",
        arguments: { command: "pwd", unexpected: true },
      },
      new AbortController().signal,
    );

    expect(result.toolResult.outcome).toBe("blocked");
    expect(result.toolResult.content).toEqual([
      { type: "text", text: 'Invalid arguments: Unrecognized key: "unexpected"' },
    ]);

    const invalidPath = await runTool(tool, {
      id: "bash-invalid-cwd",
      name: "bash",
      arguments: { command: "pwd", workingDirectory: "one\ntwo" },
    });
    expect(invalidPath.toolResult.outcome).toBe("blocked");
    expect(invalidPath.toolResult.content).toEqual([
      { type: "text", text: "Invalid arguments: workingDirectory must be a single line." },
    ]);
  });

  it.each([
    ["cancellation", { aborted: true }, {}, "cancelled", "Command was cancelled."],
    [
      "timeout",
      { timedOut: true, closeSignal: "SIGTERM" },
      { timeout: 1500 },
      "cancelled",
      "Command timed out after 1500ms.",
    ],
    [
      "signal termination",
      { closeSignal: "SIGKILL" },
      {},
      "failed",
      "Command was terminated by signal SIGKILL.",
    ],
  ])(
    "reports %s from structured termination state",
    async (_name, execution, args, outcome, notice) => {
      const tool = createBashToolDefinition(
        {
          ...backend,
          async runBash() {
            return {
              output: "partial output\n",
              stdout: "partial output\n",
              stderr: "",
              exitCode: null,
              truncated: false,
              timedOut: false,
              aborted: false,
              closeSignal: null,
              ...execution,
            };
          },
        },
        "/project",
      );
      const result = await runTool(tool, {
        id: "bash-terminated",
        name: "bash",
        arguments: { command: "worker", ...args },
      });

      expect(result.toolResult.outcome).toBe(outcome);
      expect(result.toolResult.content[0].text).toBe(`partial output\n\n[${notice}]`);
      expect(result.uiEvent.presentation.details).toEqual([
        { text: "partial output", wrap: "character" },
        { text: `[${notice}]`, wrap: "word" },
      ]);
      expect(result.uiEvent.presentation.metadata).not.toContain("exit ?");
    },
  );

  it("returns a focused failure when the command cannot be executed", async () => {
    const failedBackend = {
      ...backend,
      async runBash() {
        throw new Error("spawn bash ENOENT");
      },
    };
    const tool = createBashToolDefinition(failedBackend, "/project");
    const result = await runTool(tool, {
      id: "bash-execution-failed",
      name: "bash",
      arguments: { command: "pwd" },
    });

    expect([result.toolResult.outcome, result.toolResult.content[0].text]).toEqual([
      "failed",
      "Could not execute command: spawn bash ENOENT",
    ]);
  });

  it("shows the effective working directory throughout the tool lifecycle", async () => {
    const tool = createBashToolDefinition(backend, "/project");
    const toolCall = {
      id: "bash-cwd",
      name: "bash",
      arguments: { command: "pwd" },
    };

    expect(tool.describe(toolCall).presentation.metadata).toEqual(["/project"]);

    const result = await runTool(tool, toolCall);
    expect(result.activities[0].presentation.metadata).toEqual(["/project"]);
    expect(result.uiEvent.presentation.metadata).toContain("/project");
  });

  it("gates default output and includes maxOutputTokens instructions", async () => {
    const policy = getBashOutputPolicy({ mode: "model" });
    const output = "a".repeat(tokensToBytes(policy.maxTokens) + 12);
    const truncationInfo = await prepareBashOutput(output, false, policy, backend);

    expect(truncationInfo.gated).toBe(true);
    expect(truncationInfo.output).toContain("tokens truncated");
    const toolText = formatBashToolResultText({ truncationInfo, exitCode: 0 });
    expect(toolText).toContain("maxOutputTokens");
    expect(toolText).toContain("If you need more output from this truncated result");
    expect(toolText).toContain("User requests are checked");
    expect(toolText).toContain("side effects");
  });

  it("skips gating when output is under the default limit", async () => {
    const policy = getBashOutputPolicy({ mode: "model" });
    const output = "ok".repeat(10);
    const truncationInfo = await prepareBashOutput(output, false, policy, backend);

    expect(truncationInfo.gated).toBeUndefined();
    expect(truncationInfo.model.truncated).toBe(false);
    expect(truncationInfo.output).toBe(output);
  });

  it("truncates without gating when maxOutputTokens is set", async () => {
    const policy = getBashOutputPolicy({
      mode: "model",
      maxOutputTokens: 12000,
      hasMaxOutputTokens: true,
    });
    const output = "b".repeat(tokensToBytes(policy.maxTokens) + 12);
    const truncationInfo = await prepareBashOutput(output, false, policy, backend);

    expect(truncationInfo.gated).toBeUndefined();
    expect(truncationInfo.model.truncated).toBe(true);
    expect(truncationInfo.output).toContain("tokens truncated");
  });

  it("keeps gating when maxOutputTokens is only present without a numeric value", async () => {
    const policy = getBashOutputPolicy({
      mode: "model",
      hasMaxOutputTokens: true,
    });
    const output = "d".repeat(tokensToBytes(8192) + 12);
    const truncationInfo = await prepareBashOutput(output, false, policy, backend);

    expect(truncationInfo.gated).toBe(true);
  });

  it("uses a larger limit for user mode", async () => {
    const policy = getBashOutputPolicy({ mode: "user" });
    const output = "c".repeat(tokensToBytes(policy.maxTokens) - 6);
    const truncationInfo = await prepareBashOutput(output, false, policy, backend);

    expect(truncationInfo.model.truncated).toBe(false);
  });

  it.each([
    ["", 0, "Command produced no output (exit 0)"],
    ["", 2, "Command failed with exit code 2 and produced no output."],
    ["permission denied\n", 126, "permission denied\n\n[Command failed with exit code 126.]"],
  ])("formats command exit results", (output, exitCode, expected) => {
    expect(formatBashToolResultText({ truncationInfo: bashOutput(output), exitCode })).toBe(
      expected,
    );
  });

  it("marks terminal output for character wrapping", () => {
    const presentation = buildBashPresentation({
      toolName: "bash",
      subject: "echo test",
      truncationInfo: bashOutput("alpha beta"),
      exitCode: 0,
      durationMs: 0,
    });

    expect(presentation.details).toEqual([{ text: "alpha beta", wrap: "character" }]);
  });

  it("omits empty-output metadata", () => {
    const presentation = buildBashPresentation({
      toolName: "bash",
      subject: "echo test",
      truncationInfo: bashOutput(""),
      exitCode: 0,
      durationMs: 12,
    });

    expect(presentation.metadata).toEqual(["exit 0", "12ms"]);
  });

  it("shows working directory after exit status", () => {
    const presentation = buildBashPresentation({
      toolName: "bash",
      subject: "echo test",
      truncationInfo: bashOutput(""),
      exitCode: 0,
      workingDirectory: "/tmp/tau",
      durationMs: 12,
    });

    expect(presentation.metadata).toEqual(["exit 0", "/tmp/tau", "12ms"]);
  });
});
