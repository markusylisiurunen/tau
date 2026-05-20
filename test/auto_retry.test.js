import { describe, expect, it } from "vitest";
import { shouldAutoRetry } from "../dist/core/utils/auto_retry.js";

const model = { contextWindow: 200_000 };

describe("auto retry", () => {
  it("retries transient provider and transport errors", () => {
    const retryableMessages = [
      "overloaded_error",
      "provider returned error",
      "429 Too Many Requests",
      "500 internal error",
      "service unavailable",
      "network error",
      "connection lost",
      "WebSocket closed 1012",
      "socket hang up",
      "request ended without sending chunks",
      "http2 request did not get a response",
      "timed out waiting for response",
      "timeout",
      "retry delay exceeded",
      "The system is currently experiencing high demand and cannot process your request. Your request exceeds the maximum usage size allowed during peak load. For improved capacity reliability, consider switching to Provisioned Throughput.",
    ];

    for (const message of retryableMessages) {
      const error = {
        role: "assistant",
        stopReason: "error",
        errorMessage: message,
      };

      expect(shouldAutoRetry({ model, error }), message).toBe(true);
    }
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
