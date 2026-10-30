import type { Config } from "../config/index.js";
import type { HistoryQuery } from "../history/types.js";
import type { McpManager } from "../mcp/manager.js";
import type { CoreDeps } from "../runtime/deps.js";
import type { AgentJobRegistry } from "../tools/agent_jobs.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import { ClaudeCodeRuntime } from "./claude_code_runtime.js";
import type { SubagentRuntimeEvent } from "./events.js";
import { NativeSubagentRuntime } from "./native_subagent_runtime.js";
import type { SubagentRunFailure, SubagentRuntimeConfig, SubagentStateSnapshot } from "./types.js";

export type SubagentRuntimeOutcome =
  | { status: "succeeded"; response: string }
  | { status: "failed"; failure: Exclude<SubagentRunFailure, { kind: "interrupted" }> }
  | { status: "interrupted" };

export type SubagentRuntimeSettlement = {
  outcome: SubagentRuntimeOutcome;
  unconsumed: string[];
};

export interface SubagentRuntime {
  readonly model: SubagentStateSnapshot["model"];
  readonly contextWindow: number;
  readonly pendingSteering: number;
  // Settlement includes event delivery and all steering deliveries, even after failure.
  submit(prompt: string): Promise<SubagentRuntimeSettlement>;
  steer(prompt: string): void;
  interrupt(): void;
  dispose(): void;
}

export type SubagentRuntimeOptions = {
  id: string;
  config: Config;
  backend: ToolExecutionBackend;
  jobs: AgentJobRegistry;
  history?: HistoryQuery;
  mcp?: McpManager;
  personaId?: string;
  deps: CoreDeps;
  onEvent: (event: SubagentRuntimeEvent) => Promise<void>;
};

export function createSubagentRuntime(
  config: SubagentRuntimeConfig,
  options: SubagentRuntimeOptions,
): SubagentRuntime {
  return config.kind === "native"
    ? new NativeSubagentRuntime(config, options)
    : new ClaudeCodeRuntime({
        config,
        backend: options.backend,
        onEvent: options.onEvent,
        now: () => options.deps.clock.now(),
      });
}
