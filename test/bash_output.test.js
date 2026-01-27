import { describe, expect, it } from "vitest";
import {
  formatBashToolResultText,
  getBashOutputPolicy,
  prepareBashOutput,
} from "../dist/core/tools/bash.js";
import { tokensToBytes } from "../dist/core/utils/token.js";

describe("bash output policy", () => {
  it("gates default mode output and returns grant code instructions", () => {
    const policy = getBashOutputPolicy("model_default");
    const output = "a".repeat(tokensToBytes(policy.maxTokens) + 12);
    const truncationInfo = prepareBashOutput(output, false, policy);

    expect(truncationInfo.gate).toBeDefined();
    expect(truncationInfo.output).toContain("tokens truncated");
    const toolText = formatBashToolResultText({ truncationInfo, exitCode: 0 });
    expect(toolText).toContain("grantCode");
    expect(toolText).toContain(truncationInfo.gate.grantCode);
    expect(toolText).toContain("side effects");
  });

  it("skips gating when output is under the default limit", () => {
    const policy = getBashOutputPolicy("model_default");
    const output = "ok".repeat(10);
    const truncationInfo = prepareBashOutput(output, false, policy);

    expect(truncationInfo.gate).toBeUndefined();
    expect(truncationInfo.model.truncated).toBe(false);
    expect(truncationInfo.output).toBe(output);
  });

  it("truncates in extended mode without gating", () => {
    const policy = getBashOutputPolicy("model_extended");
    const output = "b".repeat(tokensToBytes(policy.maxTokens) + 12);
    const truncationInfo = prepareBashOutput(output, false, policy);

    expect(truncationInfo.gate).toBeUndefined();
    expect(truncationInfo.model.truncated).toBe(true);
    expect(truncationInfo.output).toContain("tokens truncated");
  });

  it("uses a larger limit for user mode", () => {
    const policy = getBashOutputPolicy("user");
    const output = "c".repeat(tokensToBytes(policy.maxTokens) - 6);
    const truncationInfo = prepareBashOutput(output, false, policy);

    expect(truncationInfo.model.truncated).toBe(false);
  });
});
