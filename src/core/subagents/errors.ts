import type { SubagentRuntimeOutcome } from "./runtime.js";

export class AgentRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentRequestError";
  }
}

export function runtimeFailure(error: unknown): SubagentRuntimeOutcome {
  return {
    status: "failed",
    failure: {
      kind: "runtime-error",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
