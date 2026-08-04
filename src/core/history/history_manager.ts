import { LocalHistoryStore } from "./local_history_store.js";
import { RemoteHistoryClient } from "./remote_history_client.js";
import type {
  HistoryEntry,
  HistoryQuery,
  HistoryReadInput,
  HistoryRemoteTarget,
  HistorySearchInput,
  HistorySessionRecord,
} from "./types.js";

const REPLICATION_BATCH_SIZE = 10;
const REPLICATION_BATCH_BYTES = 6 * 1024 * 1024;
const REPLICATION_TIMEOUT_MS = 15_000;

export class HistoryManager {
  private readonly replicationRuns = new Map<string, Promise<void>>();
  private readonly targets = new Map<string, HistoryRemoteTarget>();
  private local: LocalHistoryStore | undefined;
  private failureReason: string | undefined;

  constructor(local: LocalHistoryStore | undefined, failureReason?: string) {
    if (!local && !failureReason) {
      throw new Error("history manager requires a local store or failure reason");
    }
    this.local = local;
    this.failureReason = failureReason;
  }

  static open(path: string): HistoryManager {
    try {
      return new HistoryManager(new LocalHistoryStore(path));
    } catch (error) {
      return new HistoryManager(undefined, formatFailureReason(error));
    }
  }

  registerSession(session: HistorySessionRecord, remote?: HistoryRemoteTarget): string | undefined {
    return this.runLocalMutation((local) => {
      local.createSession(session, remote);
      if (remote) this.scheduleReplication(remote);
    });
  }

  append(
    sessionId: string,
    entries: HistoryEntry[],
    remote?: HistoryRemoteTarget,
  ): string | undefined {
    return this.runLocalMutation((local) => {
      const inserted = local.append(sessionId, entries, remote);
      if (inserted.length > 0 && remote) this.scheduleReplication(remote);
    });
  }

  truncateFromSources(
    sessionId: string,
    sourceIds: string[],
    remote?: HistoryRemoteTarget,
  ): string | undefined {
    return this.runLocalMutation((local) => {
      const truncated = local.truncateFromSources(sessionId, sourceIds, remote);
      if (truncated !== undefined && remote) this.scheduleReplication(remote);
    });
  }

  query(remote?: HistoryRemoteTarget): HistoryQuery {
    if (remote) {
      const client = new RemoteHistoryClient(remote);
      return {
        search: async (input, signal) => {
          this.requireLocal();
          return await client.search(input, signal);
        },
        read: async (input, signal) => {
          this.requireLocal();
          return await client.read(input, signal);
        },
      };
    }

    return {
      search: async (input) => await this.searchLocal(input),
      read: async (input) => await this.readLocal(input),
    };
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.replicationRuns.values()]);
  }

  close(): void {
    const local = this.local;
    this.local = undefined;
    this.failureReason ??= "history manager is closed";
    if (!local) return;
    try {
      local.close();
    } catch {
      // History is best-effort, including during host shutdown.
    }
  }

  private runLocalMutation(action: (local: LocalHistoryStore) => void): string | undefined {
    const local = this.local;
    if (!local) return this.failureReason;
    try {
      action(local);
      return undefined;
    } catch (error) {
      return this.disable(error);
    }
  }

  private async searchLocal(input: HistorySearchInput) {
    const local = this.requireLocal();
    return await local.search(input);
  }

  private async readLocal(input: HistoryReadInput) {
    const local = this.requireLocal();
    return await local.read(input);
  }

  private requireLocal(): LocalHistoryStore {
    if (this.local) return this.local;
    throw new Error(`session history is unavailable: ${this.failureReason ?? "unknown failure"}`);
  }

  private disable(error: unknown): string {
    const reason = formatFailureReason(error);
    this.failureReason = reason;
    const local = this.local;
    this.local = undefined;
    if (local) {
      try {
        local.close();
      } catch {
        // Preserve the original failure reason.
      }
    }
    return reason;
  }

  private scheduleReplication(target: HistoryRemoteTarget): void {
    this.targets.set(target.endpoint, target);
    if (this.replicationRuns.has(target.endpoint)) return;
    const run = this.replicate(target.endpoint).finally(() => {
      if (this.replicationRuns.get(target.endpoint) === run) {
        this.replicationRuns.delete(target.endpoint);
      }
    });
    this.replicationRuns.set(target.endpoint, run);
    void run.catch(() => undefined);
  }

  private async replicate(endpoint: string): Promise<void> {
    const target = this.targets.get(endpoint);
    if (!target) return;
    const client = new RemoteHistoryClient(target);
    while (true) {
      const local = this.local;
      if (!local) return;
      const pending = local.listPendingOperations(endpoint, REPLICATION_BATCH_SIZE);
      if (pending.length === 0) return;
      const batch = boundedReplicationBatch(pending);
      await client.applyOperations(
        batch.map((item) => item.operation),
        AbortSignal.timeout(REPLICATION_TIMEOUT_MS),
      );
      local.acknowledgeOperations(batch.map((item) => item.rowId));
    }
  }
}

function formatFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const text = String(error).trim();
  return text || "unknown failure";
}

function boundedReplicationBatch<T extends { operation: unknown }>(pending: T[]): T[] {
  const batch: T[] = [];
  let bytes = 0;
  for (const item of pending) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item.operation), "utf8");
    if (batch.length > 0 && bytes + itemBytes > REPLICATION_BATCH_BYTES) break;
    batch.push(item);
    bytes += itemBytes;
  }
  return batch;
}
