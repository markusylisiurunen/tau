import type { AgentState } from "../agent/agent_runtime.js";
import type { ClaudeCodeTokenUsage } from "./claude_code_protocol.js";
import type { SavedAssistant } from "./trace.js";
import type { ClaudeCodeSubagentConfig, NativeSubagentConfig } from "./types.js";

export type ClaudeCodeContext = {
  sessionId?: string;
  usage: ClaudeCodeTokenUsage;
  cost: number;
  messages: [string, ClaudeCodeTokenUsage | null][];
  contextTokens: number;
  contextSize: number;
};

export type WorkerLaunch =
  | { kind: "native"; config: NativeSubagentConfig; context?: AgentState }
  | { kind: "claude-code"; config: ClaudeCodeSubagentConfig; context?: ClaudeCodeContext };

export type WorkerRuntimeState = Required<WorkerLaunch>;

export type WorkerCheckpoint = WorkerRuntimeState & {
  pending: { queue: number; steer: number };
  lastAssistantSeq?: number;
  assistant?: SavedAssistant;
  originHistoryEntryId: string;
  personaId?: string;
  notifyOnCompletion: boolean;
  traceSequence: number;
};

/** Scoped to a single leased parent session. */
export interface WorkerStore {
  ids(): Promise<string[]>;
  read(id: string): Promise<WorkerCheckpoint | undefined>;
  save(id: string, worker: WorkerCheckpoint): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createMemoryWorkerStore(): WorkerStore {
  const workers = new Map<string, WorkerCheckpoint>();
  return {
    ids: async () => [...workers.keys()],
    read: async (id) => structuredClone(workers.get(id)),
    save: async (id, worker) => {
      workers.set(id, structuredClone(worker));
    },
    remove: async (id) => {
      workers.delete(id);
    },
  };
}

export class InvalidWorkerCheckpointError extends Error {}

export class WorkerCheckpointWriter {
  private dirty = false;
  private closed = false;
  private writing?: Promise<void>;
  constructor(private readonly save: () => Promise<void>) {}

  // Requests arriving during a save need another write to capture their changes.
  request() {
    if (!this.closed) {
      this.dirty = true;
      this.writing ??= Promise.resolve().then(async () => {
        try {
          while (this.dirty && !this.closed) {
            this.dirty = false;
            await this.save();
          }
        } finally {
          this.writing = undefined;
        }
      });
    }
    return this.flush();
  }

  flush() {
    return this.writing ?? Promise.resolve();
  }

  close() {
    this.closed = true;
  }
}
