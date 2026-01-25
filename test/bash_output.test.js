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
    const stdout = Array(policy.maxTotalLines + 5)
      .fill("ok")
      .join("\n");
    const truncationInfo = prepareBashOutput(stdout, "", false, {
      mode: "model_default",
      policy,
    });

    expect(truncationInfo.gate).toBeDefined();
    const toolText = formatBashToolResultText({ truncationInfo, exitCode: 0 });
    expect(toolText).toContain("grantCode");
    expect(toolText).toContain(truncationInfo.gate.grantCode);
  });

  it("applies per-line caps in default mode", () => {
    const policy = getBashOutputPolicy("model_default");
    const maxLineBytes = tokensToBytes(policy.maxLineTokens);
    const longLine = "a".repeat(maxLineBytes + 12);
    const truncationInfo = prepareBashOutput(longLine, "", false, {
      mode: "model_default",
      policy,
    });

    const outputBytes = Buffer.byteLength(truncationInfo.output, "utf-8");
    expect(outputBytes).toBeLessThan(Buffer.byteLength(longLine, "utf-8"));
    expect(outputBytes).toBeLessThanOrEqual(maxLineBytes);
  });

  it("skips per-line caps in extended mode and uses per-stream truncation", () => {
    const defaultPolicy = getBashOutputPolicy("model_default");
    const extendedPolicy = getBashOutputPolicy("model_extended");
    const longLine = "b".repeat(tokensToBytes(defaultPolicy.maxLineTokens) + 12);

    const lineInfo = prepareBashOutput(longLine, "", false, {
      mode: "model_extended",
      policy: extendedPolicy,
    });

    expect(lineInfo.gate).toBeUndefined();
    expect(lineInfo.output).toBe(longLine);

    const manyLines = Array(extendedPolicy.maxStdoutLines + 12)
      .fill("ok")
      .join("\n");
    const truncInfo = prepareBashOutput(manyLines, "", false, {
      mode: "model_extended",
      policy: extendedPolicy,
    });

    expect(truncInfo.gate).toBeUndefined();
    expect(truncInfo.model.truncated).toBe(true);
  });

  it("preserves stderr markers while respecting total budgets", () => {
    const policy = getBashOutputPolicy("model_default");
    const stdout = Array(policy.maxTotalLines + 12)
      .fill("out")
      .join("\n");
    const stderr = Array(policy.maxTotalLines + 12)
      .fill("err")
      .join("\n");

    const truncationInfo = prepareBashOutput(stdout, stderr, false, {
      mode: "model_default",
      policy,
    });

    expect(truncationInfo.output).toContain("[stderr]");
    expect(truncationInfo.model.outputLines).toBeLessThanOrEqual(policy.maxTotalLines);
  });
});
