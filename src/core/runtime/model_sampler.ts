import { randomUUID } from "node:crypto";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ReasoningEffort } from "../types.js";
import type { TauStreamOptions } from "../utils/streaming_settings.js";
import type { ModelExecutor } from "./model_executor.js";

export type ModelSampleInput = {
  context: Context & { systemPrompt: string };
  options: {
    reasoning?: ReasoningEffort;
    maxTokens?: number;
  };
  signal?: AbortSignal;
};

export type ModelSamplingTarget = {
  model: Pick<ModelExecutor, "stream" | "cleanupSession">;
  streamOptions: TauStreamOptions;
};

export async function sampleModel(
  target: ModelSamplingTarget,
  input: ModelSampleInput,
): Promise<AssistantMessage> {
  input.signal?.throwIfAborted();
  const sampleSessionId = `sample-${randomUUID()}`;
  const stream = target.model.stream(structuredClone(input.context), {
    ...target.streamOptions,
    ...(input.options.reasoning !== undefined ? { reasoning: input.options.reasoning } : {}),
    ...(input.options.maxTokens !== undefined ? { maxTokens: input.options.maxTokens } : {}),
    sessionId: sampleSessionId,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  try {
    const message = await stream.result();
    input.signal?.throwIfAborted();
    return message;
  } finally {
    target.model.cleanupSession(sampleSessionId);
  }
}
