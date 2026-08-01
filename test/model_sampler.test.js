import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { sampleModel } from "../dist/core/runtime/model_sampler.js";

function createResultStream(message, error) {
  return {
    async *[Symbol.asyncIterator]() {},
    async result() {
      if (error) throw error;
      return message;
    },
  };
}

describe("sampleModel", () => {
  it("samples an explicit model target with per-call overrides", async () => {
    const message = fauxAssistantMessage("sampled");
    const stream = vi.fn(() => createResultStream(message));
    const cleanupSession = vi.fn();
    const context = {
      systemPrompt: "Classify the request.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "A request" }],
          timestamp: 1,
        },
      ],
    };
    const controller = new AbortController();

    await expect(
      sampleModel(
        {
          model: { stream, cleanupSession },
          streamOptions: { reasoning: "low", serviceTier: "priority" },
        },
        {
          context,
          options: { reasoning: "high", maxTokens: 500 },
          signal: controller.signal,
        },
      ),
    ).resolves.toEqual(message);

    expect(stream).toHaveBeenCalledOnce();
    const [sampledContext, options] = stream.mock.calls[0];
    expect(sampledContext).toEqual(context);
    expect(sampledContext).not.toBe(context);
    expect(options).toMatchObject({
      reasoning: "high",
      serviceTier: "priority",
      maxTokens: 500,
      signal: controller.signal,
    });
    expect(options.sessionId).toMatch(/^sample-/);
    expect(cleanupSession).toHaveBeenCalledWith(options.sessionId);
  });

  it("cleans up the isolated model session when sampling fails", async () => {
    const error = new Error("sample failed");
    const cleanupSession = vi.fn();

    await expect(
      sampleModel(
        {
          model: {
            stream: () => createResultStream(undefined, error),
            cleanupSession,
          },
          streamOptions: {},
        },
        {
          context: { systemPrompt: "Sample.", messages: [] },
          options: {},
        },
      ),
    ).rejects.toBe(error);

    expect(cleanupSession).toHaveBeenCalledOnce();
    expect(cleanupSession.mock.calls[0][0]).toMatch(/^sample-/);
  });
});
