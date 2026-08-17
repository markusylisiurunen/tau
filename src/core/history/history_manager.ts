import { LocalHistoryStore } from "./local_history_store.js";
import { RemoteHistoryClient, RemoteHistoryError } from "./remote_history_client.js";
import type {
  HistoryEntry,
  HistoryQuery,
  HistoryReadInput,
  HistoryRemoteTarget,
  HistorySearchInput,
  HistorySessionRecord,
} from "./types.js";

const REPLICATION_BATCH_SIZE = 10;
const REPLICATION_LANE_BATCH_SIZE = 10;
const REPLICATION_BATCH_BYTES = 6 * 1024 * 1024;
const REPLICATION_TIMEOUT_MS = 15_000;
const PERMANENT_REPLICATION_ERROR_CODES = new Set([
  "immutable_conflict",
  "invalid_request",
  "not_found",
  "request_too_large",
]);

export type HistoryReplicationFailureDiagnostic = {
  event: "history_replication_failed";
  endpoint: string;
  sessionId?: string;
  operationId?: string;
  quarantined?: true;
  error: {
    status?: number;
    code?: string;
    message: string;
  };
};

export type HistoryManagerOptions = {
  failureReason?: string;
  reportReplicationFailure?: (diagnostic: HistoryReplicationFailureDiagnostic) => void;
};

export class HistoryManager {
  private readonly replicationRuns = new Map<string, Promise<void>>();
  private readonly targets = new Map<string, HistoryRemoteTarget>();
  private readonly reportReplicationFailure: NonNullable<
    HistoryManagerOptions["reportReplicationFailure"]
  >;
  private local: LocalHistoryStore | undefined;
  private failureReason: string | undefined;

  constructor(local: LocalHistoryStore | undefined, options: HistoryManagerOptions = {}) {
    if (!local && !options.failureReason) {
      throw new Error("history manager requires a local store or failure reason");
    }
    this.local = local;
    this.failureReason = options.failureReason;
    this.reportReplicationFailure = options.reportReplicationFailure ?? (() => {});
  }

  static open(
    path: string,
    options: Omit<HistoryManagerOptions, "failureReason"> = {},
  ): HistoryManager {
    try {
      return new HistoryManager(new LocalHistoryStore(path), options);
    } catch (error) {
      return new HistoryManager(undefined, {
        ...options,
        failureReason: formatFailureReason(error),
      });
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
    void run.catch((error) => {
      this.emitReplicationFailure({ endpoint: target.endpoint, error });
    });
  }

  private async replicate(endpoint: string): Promise<void> {
    const target = this.targets.get(endpoint);
    if (!target) return;
    const client = new RemoteHistoryClient(target);
    while (true) {
      const local = this.local;
      if (!local) return;
      const lanes = local.listPendingOperationLanes(
        endpoint,
        REPLICATION_LANE_BATCH_SIZE,
        REPLICATION_BATCH_SIZE,
      );
      if (lanes.length === 0) return;
      for (const pending of lanes) {
        const batch = boundedReplicationBatch(pending);
        const first = batch[0]?.operation;
        if (!first) continue;
        try {
          await client.applyOperations(
            batch.map((item) => item.operation),
            AbortSignal.timeout(REPLICATION_TIMEOUT_MS),
          );
        } catch (error) {
          if (isPermanentReplicationFailure(error)) {
            local.quarantineReplicationSession({
              endpoint,
              sessionId: first.sessionId,
              operationId: first.id,
              code: error.code,
              message: error.message,
              failedAt: Date.now(),
            });
            this.emitReplicationFailure({
              endpoint,
              sessionId: first.sessionId,
              operationId: first.id,
              error,
              quarantined: true,
            });
            continue;
          }
          this.emitReplicationFailure({
            endpoint,
            sessionId: first.sessionId,
            operationId: first.id,
            error,
          });
          return;
        }
        local.acknowledgeOperations(batch.map((item) => item.rowId));
      }
    }
  }

  private emitReplicationFailure(input: {
    endpoint: string;
    sessionId?: string;
    operationId?: string;
    error: unknown;
    quarantined?: boolean;
  }): void {
    const error = input.error;
    try {
      this.reportReplicationFailure({
        event: "history_replication_failed",
        endpoint: input.endpoint,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.operationId ? { operationId: input.operationId } : {}),
        ...(input.quarantined ? { quarantined: true } : {}),
        error: {
          ...(error instanceof RemoteHistoryError
            ? { status: error.status, ...(error.code ? { code: error.code } : {}) }
            : {}),
          message: formatFailureReason(error),
        },
      });
    } catch {
      // History diagnostics must not affect replication.
    }
  }
}

function formatFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const text = String(error).trim();
  return text || "unknown failure";
}

function isPermanentReplicationFailure(error: unknown): error is RemoteHistoryError & {
  code: string;
} {
  return (
    error instanceof RemoteHistoryError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.code !== undefined &&
    PERMANENT_REPLICATION_ERROR_CODES.has(error.code)
  );
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
