import type { AgentState } from "../agent/agent_runtime.js";
import type { ClaudeCodeTokenUsage } from "./claude_code_protocol.js";
import type {
  ClaudeCodeSubagentConfig,
  NativeSubagentConfig,
  SubagentStateSnapshot,
} from "./types.js";

export type ClaudeCodeContext = {
  sessionId?: string;
  usage: ClaudeCodeTokenUsage;
  cost: number;
  messages: [string, ClaudeCodeTokenUsage | null][];
  contextTokens: number;
  contextSize: number;
};

export type WorkerRuntimeState =
  | { kind: "native"; config: NativeSubagentConfig; context: AgentState }
  | { kind: "claude-code"; config: ClaudeCodeSubagentConfig; context: ClaudeCodeContext };

export type WorkerCheckpoint = WorkerRuntimeState & {
  state: Omit<SubagentStateSnapshot, "availability" | "workingDirectory" | "model">;
  pending: { queue: number; steer: number };
  lastAssistantSeq?: number;
  assistant?: import("./trace.js").SavedAssistant;
  originHistoryEntryId: string;
  personaId?: string;
  notifyOnCompletion: boolean;
  traceSequence: number;
};

/** Scoped to a single leased parent session. */
export interface WorkerStore {
  list(): Promise<WorkerCheckpoint[]>;
  save(worker: WorkerCheckpoint): Promise<void>;
  remove(id: string): Promise<void>;
}
