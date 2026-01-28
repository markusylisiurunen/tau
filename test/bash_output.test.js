import { describe, expect, it } from "vitest";
import {
  formatBashToolResultText,
  getBashOutputPolicy,
  prepareBashOutput,
} from "../dist/core/tools/bash.js";
import { tokensToBytes } from "../dist/core/utils/token.js";

describe("bash output policy", () => {
  it("gates default output and includes maxOutputTokens instructions", () => {
    const policy = getBashOutputPolicy({ mode: "model" });
    const output = "a".repeat(tokensToBytes(policy.maxTokens) + 12);
    const truncationInfo = prepareBashOutput(output, false, policy);

    expect(truncationInfo.gated).toBe(true);
    expect(truncationInfo.output).toContain("tokens truncated");
    const toolText = formatBashToolResultText({ truncationInfo, exitCode: 0 });
    expect(toolText).toContain("maxOutputTokens");
    expect(toolText).toContain("user requests are checked");
    expect(toolText).toContain("side effects");
  });

  it("skips gating when output is under the default limit", () => {
    const policy = getBashOutputPolicy({ mode: "model" });
    const output = "ok".repeat(10);
    const truncationInfo = prepareBashOutput(output, false, policy);

    expect(truncationInfo.gated).toBeUndefined();
    expect(truncationInfo.model.truncated).toBe(false);
    expect(truncationInfo.output).toBe(output);
  });

  it("truncates without gating when maxOutputTokens is set", () => {
    const policy = getBashOutputPolicy({
      mode: "model",
      maxOutputTokens: 12000,
      hasMaxOutputTokens: true,
    });
    const output = "b".repeat(tokensToBytes(policy.maxTokens) + 12);
    const truncationInfo = prepareBashOutput(output, false, policy);

    expect(truncationInfo.gated).toBeUndefined();
    expect(truncationInfo.model.truncated).toBe(true);
    expect(truncationInfo.output).toContain("tokens truncated");
  });

  it("uses a larger limit for user mode", () => {
    const policy = getBashOutputPolicy({ mode: "user" });
    const output = "c".repeat(tokensToBytes(policy.maxTokens) - 6);
    const truncationInfo = prepareBashOutput(output, false, policy);

    expect(truncationInfo.model.truncated).toBe(false);
  });
});
