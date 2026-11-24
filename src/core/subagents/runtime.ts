import type { Availability } from "../agent/capabilities.js";
import type { AgentsPackageOptions } from "../code_mode/agents.js";
import type { SessionRuntimeSettings } from "../config/index.js";
import type { HistoryRecordSink } from "../history/recorder.js";
import type { HistoryQuery } from "../history/types.js";
import type { McpManager } from "../mcp/manager.js";
import type { CoreDeps } from "../runtime/deps.js";
import type { AgentJobRegistry } from "../tools/agent_jobs.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import type { AgentSupervisor } from "./agent_supervisor.js";
import type { WorkerLaunch, WorkerRuntimeState } from "./checkpoint.js";
import { ClaudeCodeRuntime } from "./claude_code_runtime.js";
import type { SubagentRuntimeEvent } from "./events.js";
import { NativeSubagentRuntime } from "./native_subagent_runtime.js";
import type { SubagentRunFailure, SubagentStateSnapshot } from "./types.js";

export type SubagentRuntimeOutcome =
  | { status: "succeeded"; response: string }
  | { status: "failed"; failure: Exclude<SubagentRunFailure, { kind: "interrupted" }> }
  | { status: "interrupted" };

export type SubagentRuntimeSettlement = {
  outcome: SubagentRuntimeOutcome;
  unconsumed: string[];
};

export interface SubagentRuntime {
  checkpoint(): WorkerRuntimeState;
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
  checkpoint: () => Promise<void>;
  sessionIds: string[];
  supervisor: AgentSupervisor;
  /** Whether this worker may start workers of its own. */
  delegation: Availability;
  agents: AgentsPackageOptions;
  config: SessionRuntimeSettings;
  backend: ToolExecutionBackend;
  jobs: AgentJobRegistry;
  history: HistoryQuery;
  openHistory?: () => HistoryRecordSink;
  mcp: McpManager;
  personaId?: string;
  deps: CoreDeps;
  onEvent: (event: SubagentRuntimeEvent) => Promise<void>;
};

export function createSubagentRuntime(
  launch: WorkerLaunch,
  options: SubagentRuntimeOptions,
): SubagentRuntime {
  return launch.kind === "native"
    ? new NativeSubagentRuntime(launch.config, options, launch.context)
    : new ClaudeCodeRuntime({
        config: launch.config,
        restored: launch.context,
        checkpoint: options.checkpoint,
        history: options.openHistory?.(),
        backend: options.backend,
        onEvent: options.onEvent,
        now: () => options.deps.clock.now(),
      });
}
