export function isFlexRetryEnabled(options: {
  modelApi: string;
  serviceTier?: string | null;
  signal?: AbortSignal;
}): boolean {
  const { modelApi, serviceTier, signal } = options;
  return modelApi === "openai-responses" && serviceTier === "flex" && !signal?.aborted;
}

export function shouldRetryFlexAfterResponse(options: {
  modelApi: string;
  serviceTier?: string | null;
  signal?: AbortSignal;
  didEmitAnyOutput?: boolean;
  stopReason?: string;
}): boolean {
  const { didEmitAnyOutput, stopReason } = options;
  if (!isFlexRetryEnabled(options)) {
    return false;
  }
  return !didEmitAnyOutput && stopReason === "error";
}
