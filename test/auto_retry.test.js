import { describe, expect, it } from "vitest";
import { shouldAutoRetry } from "../dist/core/utils/auto_retry.js";

const model = { contextWindow: 200_000 };

describe("auto retry", () => {
  it("treats azure high-demand capacity errors as transient", () => {
    const error = {
      role: "assistant",
      stopReason: "error",
      errorMessage:
        "The system is currently experiencing high demand and cannot process your request. Your request exceeds the maximum usage size allowed during peak load. For improved capacity reliability, consider switching to Provisioned Throughput.",
    };

    expect(shouldAutoRetry({ model, error })).toBe(true);
  });

  it("does not retry non-transient assistant errors", () => {
    const error = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "invalid api key provided",
    };

    expect(shouldAutoRetry({ model, error })).toBe(false);
  });
});
