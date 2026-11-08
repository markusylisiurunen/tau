import { describe, expect, it } from "vitest";
import {
  createBashToolDefinition,
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

  it("gates oversized default output", async () => {
    const policy = getBashOutputPolicy({ mode: "model" });
    const output = "a".repeat(tokensToBytes(policy.maxTokens) + 12);
    const truncationInfo = await prepareBashOutput(output, false, policy, backend);

    expect(truncationInfo.gated).toBe(true);
    expect(truncationInfo.output).toContain("tokens truncated");
    expect(truncationInfo.model.truncated).toBe(true);
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
});
