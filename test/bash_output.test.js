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

    const emptyCommand = await runTool(tool, {
      id: "bash-empty-command",
      name: "bash",
      arguments: { command: "  " },
    });
    expect(emptyCommand.toolResult.outcome).toBe("blocked");
    expect(emptyCommand.toolResult.content).toEqual([
      { type: "text", text: "Invalid arguments: command must not be empty." },
    ]);

    const invalidTimeout = await runTool(tool, {
      id: "bash-invalid-timeout",
      name: "bash",
      arguments: { command: "pwd", timeout: 0 },
    });
    expect(invalidTimeout.toolResult.outcome).toBe("blocked");
    expect(invalidTimeout.toolResult.content).toEqual([
      { type: "text", text: "Invalid arguments: timeout must be greater than 0." },
    ]);
  });

  it("reports cancellation semantically without exposing the backend abort marker", async () => {
    const cancelledBackend = {
      ...backend,
      async runBash() {
        return {
          output: "partial output\n",
          stdout: "partial output\n",
          stderr: "",
          exitCode: null,
          truncated: false,
          timedOut: false,
          aborted: true,
          closeSignal: null,
        };
      },
    };
    const tool = createBashToolDefinition(cancelledBackend, "/project");
    const result = await runTool(tool, {
      id: "bash-cancelled",
      name: "bash",
      arguments: { command: "sleep 3" },
    });

    expect(result.toolResult.outcome).toBe("cancelled");
    expect(result.toolResult.content).toEqual([
      { type: "text", text: "partial output\n\n[Command was cancelled.]" },
    ]);
    expect(result.uiEvent.presentation.details).toEqual([
      { text: "partial output", wrap: "character" },
      { text: "[Command was cancelled.]", wrap: "word" },
    ]);
    expect(result.uiEvent.presentation.metadata).not.toContain("exit ?");
  });

  it("reports timeouts without exposing the backend termination marker", async () => {
    const timedOutBackend = {
      ...backend,
      async runBash() {
        return {
          output: "partial output\n",
          stdout: "partial output\n",
          stderr: "",
          exitCode: null,
          truncated: false,
          timedOut: true,
          aborted: false,
          closeSignal: "SIGTERM",
        };
      },
    };
    const tool = createBashToolDefinition(timedOutBackend, "/project");
    const result = await runTool(tool, {
      id: "bash-timed-out",
      name: "bash",
      arguments: { command: "sleep 3", timeout: 1500 },
    });

    expect(result.toolResult.outcome).toBe("cancelled");
    expect(result.toolResult.content).toEqual([
      { type: "text", text: "partial output\n\n[Command timed out after 1500ms.]" },
    ]);
    expect(result.uiEvent.presentation.details).toEqual([
      { text: "partial output", wrap: "character" },
      { text: "[Command timed out after 1500ms.]", wrap: "word" },
    ]);
    expect(result.uiEvent.presentation.metadata).not.toContain("exit ?");
  });

  it("reports signal termination without exposing the backend termination marker", async () => {
    const terminatedBackend = {
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
          closeSignal: "SIGKILL",
        };
      },
    };
    const tool = createBashToolDefinition(terminatedBackend, "/project");
    const result = await runTool(tool, {
      id: "bash-terminated",
      name: "bash",
      arguments: { command: "worker" },
    });

    expect(result.toolResult.outcome).toBe("failed");
    expect(result.toolResult.content).toEqual([
      { type: "text", text: "partial output\n\n[Command was terminated by signal SIGKILL.]" },
    ]);
    expect(result.uiEvent.presentation.details).toEqual([
      { text: "partial output", wrap: "character" },
      { text: "[Command was terminated by signal SIGKILL.]", wrap: "word" },
    ]);
    expect(result.uiEvent.presentation.metadata).not.toContain("exit ?");
  });

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

    expect(result.toolResult.outcome).toBe("failed");
    expect(result.toolResult.content).toEqual([
      { type: "text", text: "Could not execute command: spawn bash ENOENT" },
    ]);
    expect(result.uiEvent.type).toBe("bash_blocked");
    expect(result.uiEvent.reason).toBe("Could not execute command: spawn bash ENOENT");
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

  it("returns a default message for empty successful output", () => {
    const toolText = formatBashToolResultText({
      truncationInfo: {
        output: "",
        model: {
          content: "",
          truncated: false,
          totalLines: 0,
          outputLines: 0,
          totalBytes: 0,
          outputBytes: 0,
        },
        captureTruncated: false,
      },
      exitCode: 0,
    });

    expect(toolText).toBe("Command produced no output (exit 0)");
  });

  it("returns the exit status when a failed command produces no output", () => {
    const toolText = formatBashToolResultText({
      truncationInfo: {
        output: "",
        model: {
          content: "",
          truncated: false,
          totalLines: 0,
          outputLines: 0,
          totalBytes: 0,
          outputBytes: 0,
        },
        captureTruncated: false,
      },
      exitCode: 2,
    });

    expect(toolText).toBe("Command failed with exit code 2 and produced no output.");
  });

  it("adds a clear failure sentence after command output", () => {
    const toolText = formatBashToolResultText({
      truncationInfo: {
        output: "permission denied\n",
        model: {
          content: "permission denied\n",
          truncated: false,
          totalLines: 1,
          outputLines: 1,
          totalBytes: 18,
          outputBytes: 18,
        },
        captureTruncated: false,
      },
      exitCode: 126,
    });

    expect(toolText).toBe("permission denied\n\n[Command failed with exit code 126.]");
  });

  it("marks terminal output for character wrapping", () => {
    const presentation = buildBashPresentation({
      toolName: "bash",
      subject: "echo test",
      truncationInfo: {
        output: "alpha beta",
        model: {
          truncated: false,
          totalLines: 1,
          outputLines: 1,
          totalBytes: 10,
          outputBytes: 10,
        },
        captureTruncated: false,
      },
      exitCode: 0,
      durationMs: 0,
    });

    expect(presentation.details).toEqual([{ text: "alpha beta", wrap: "character" }]);
  });

  it("omits empty-output metadata", () => {
    const presentation = buildBashPresentation({
      toolName: "bash",
      subject: "echo test",
      truncationInfo: {
        output: "",
        model: {
          truncated: false,
          totalLines: 0,
          outputLines: 0,
          totalBytes: 0,
          outputBytes: 0,
        },
        captureTruncated: false,
      },
      exitCode: 0,
      durationMs: 12,
    });

    expect(presentation.metadata).toEqual(["exit 0", "12ms"]);
  });

  it("shows working directory after exit status", () => {
    const presentation = buildBashPresentation({
      toolName: "bash",
      subject: "echo test",
      truncationInfo: {
        output: "",
        model: {
          truncated: false,
          totalLines: 0,
          outputLines: 0,
          totalBytes: 0,
          outputBytes: 0,
        },
        captureTruncated: false,
      },
      exitCode: 0,
      workingDirectory: "/tmp/tau",
      durationMs: 12,
    });

    expect(presentation.metadata).toEqual(["exit 0", "/tmp/tau", "12ms"]);
  });
});
