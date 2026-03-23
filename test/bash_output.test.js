import { describe, expect, it, vi } from "vitest";
import {
  buildBashUiText,
  formatBashToolResultText,
  getBashOutputPolicy,
  prepareBashOutput,
} from "../dist/core/tools/bash.js";
import { tokensToBytes } from "../dist/core/utils/token.js";

const backend = {
  async runBash() {
    return {
      output: "/tmp/tau-bash-output-test.log\n",
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

describe("bash output policy", () => {
  it("gates default output and includes maxOutputTokens instructions", async () => {
    const policy = getBashOutputPolicy({ mode: "model" });
    const output = "a".repeat(tokensToBytes(policy.maxTokens) + 12);
    const truncationInfo = await prepareBashOutput(output, false, policy, backend);

    expect(truncationInfo.gated).toBe(true);
    expect(truncationInfo.output).toContain("tokens truncated");
    const toolText = formatBashToolResultText({ truncationInfo, exitCode: 0 });
    expect(toolText).toContain("default bash output policy");
    expect(toolText).toContain("maxOutputTokens");
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

  it("respects explicit maxOutputTokens without calling a gatekeeper", async () => {
    const policy = getBashOutputPolicy({
      mode: "model",
      maxOutputTokens: 1024,
      hasMaxOutputTokens: true,
      gatekeeperModel: "openai/gpt-5.4:low",
    });
    const gatekeeper = vi.fn(async () => ({ decision: "gate" }));
    const output = "b".repeat(tokensToBytes(1024) + 12);
    const truncationInfo = await prepareBashOutput(output, false, policy, backend, {
      command: "cat big.txt",
      signal: new AbortController().signal,
      gatekeeper,
    });

    expect(gatekeeper).not.toHaveBeenCalled();
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

  it("skips gatekeeper calls for experimental mode under 4096 tokens", async () => {
    const policy = getBashOutputPolicy({
      mode: "model",
      gatekeeperModel: "openai/gpt-5.4:low",
    });
    const gatekeeper = vi.fn(async () => ({ decision: "gate" }));
    const output = "e".repeat(tokensToBytes(4000));
    const truncationInfo = await prepareBashOutput(output, false, policy, backend, {
      command: "rg needle src",
      signal: new AbortController().signal,
      gatekeeper,
    });

    expect(gatekeeper).not.toHaveBeenCalled();
    expect(truncationInfo.gated).toBeUndefined();
    expect(truncationInfo.model.truncated).toBe(false);
    expect(truncationInfo.output).toBe(output);
  });

  it("allows reviewed output through when the gatekeeper says allow", async () => {
    const policy = getBashOutputPolicy({
      mode: "model",
      gatekeeperModel: "openai/gpt-5.4:low",
    });
    const gatekeeper = vi.fn(async () => ({ decision: "allow" }));
    const output = "f".repeat(tokensToBytes(5000));
    const truncationInfo = await prepareBashOutput(output, false, policy, backend, {
      command: "rg needle src",
      signal: new AbortController().signal,
      gatekeeper,
    });

    expect(gatekeeper).toHaveBeenCalledTimes(1);
    expect(truncationInfo.gated).toBeUndefined();
    expect(truncationInfo.model.truncated).toBe(false);
    expect(truncationInfo.output).toBe(output);
  });

  it("gates reviewed output when the gatekeeper says gate", async () => {
    const policy = getBashOutputPolicy({
      mode: "model",
      gatekeeperModel: "openai/gpt-5.4:low",
    });
    const gatekeeper = vi.fn(async () => ({
      decision: "gate",
      note: "the output was judged likely accidental or too noisy.",
    }));
    const output = "g".repeat(tokensToBytes(5000));
    const truncationInfo = await prepareBashOutput(output, false, policy, backend, {
      command: "rg needle src",
      signal: new AbortController().signal,
      gatekeeper,
    });

    expect(gatekeeper).toHaveBeenCalledTimes(1);
    expect(truncationInfo.gated).toBe(true);
    const toolText = formatBashToolResultText({ truncationInfo, exitCode: 0 });
    expect(toolText).toContain("experimental bashOutputGatekeeper model");
    expect(toolText).toContain("Full output saved to");
  });

  it("hard-gates experimental output above 12288 tokens without a gatekeeper call", async () => {
    const policy = getBashOutputPolicy({
      mode: "model",
      gatekeeperModel: "openai/gpt-5.4:low",
    });
    const gatekeeper = vi.fn(async () => ({ decision: "allow" }));
    const output = "h".repeat(tokensToBytes(13000));
    const truncationInfo = await prepareBashOutput(output, false, policy, backend, {
      command: "rg needle src",
      signal: new AbortController().signal,
      gatekeeper,
    });

    expect(gatekeeper).not.toHaveBeenCalled();
    expect(truncationInfo.gated).toBe(true);
    const toolText = formatBashToolResultText({ truncationInfo, exitCode: 0 });
    expect(toolText).toContain("hard limit");
  });

  it("fails closed when the gatekeeper call fails", async () => {
    const policy = getBashOutputPolicy({
      mode: "model",
      gatekeeperModel: "openai/gpt-5.4:low",
    });
    const gatekeeper = vi.fn(async () => ({
      decision: "gate",
      note: "the gatekeeper model 'openai/gpt-5.4:low' call failed.",
    }));
    const output = "i".repeat(tokensToBytes(5000));
    const truncationInfo = await prepareBashOutput(output, false, policy, backend, {
      command: "rg needle src",
      signal: new AbortController().signal,
      gatekeeper,
    });

    expect(gatekeeper).toHaveBeenCalledTimes(1);
    expect(truncationInfo.gated).toBe(true);
    const toolText = formatBashToolResultText({ truncationInfo, exitCode: 0 });
    expect(toolText).toContain("call failed");
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

  it("omits working directory when it is not provided", () => {
    const uiText = buildBashUiText({
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
      durationMs: 12,
    });

    expect(uiText.statusLine).toBe("exit 0 · 12ms · no output");
  });

  it("shows working directory after exit status", () => {
    const uiText = buildBashUiText({
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
      workingDirectory: "/tmp/tau",
      durationMs: 12,
    });

    expect(uiText.statusLine).toBe("exit 0 · /tmp/tau · 12ms · no output");
  });
});
