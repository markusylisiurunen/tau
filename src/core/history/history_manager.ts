import type { LocalHistoryStore } from "./local_history_store.js";
import { RemoteHistoryClient } from "./remote_history_client.js";
import type {
  HistoryEntry,
  HistoryQuery,
  HistoryRemoteTarget,
  HistorySessionRecord,
} from "./types.js";

const REPLICATION_BATCH_SIZE = 1;
const REPLICATION_BATCH_BYTES = 6 * 1024 * 1024;
const REPLICATION_TIMEOUT_MS = 15_000;

export class HistoryManager {
  private readonly replicationRuns = new Map<string, Promise<void>>();
  private readonly targets = new Map<string, HistoryRemoteTarget>();

  constructor(private readonly local: LocalHistoryStore) {}

  registerSession(session: HistorySessionRecord, remote?: HistoryRemoteTarget): void {
    this.local.createSession(session, remote);
    if (remote) this.scheduleReplication(remote);
  }

  append(sessionId: string, entries: HistoryEntry[], remote?: HistoryRemoteTarget): void {
    const inserted = this.local.append(sessionId, entries, remote);
    if (inserted.length > 0 && remote) this.scheduleReplication(remote);
  }

  truncateFromSources(sessionId: string, sourceIds: string[], remote?: HistoryRemoteTarget): void {
    const truncated = this.local.truncateFromSources(sessionId, sourceIds, remote);
    if (truncated !== undefined && remote) this.scheduleReplication(remote);
  }

  query(remote?: HistoryRemoteTarget): HistoryQuery {
    return remote ? new RemoteHistoryClient(remote) : this.local;
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.replicationRuns.values()]);
  }

  close(): void {
    this.local.close();
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
      const pending = this.local.listPendingOperations(endpoint, REPLICATION_BATCH_SIZE);
      if (pending.length === 0) return;
      const batch = boundedReplicationBatch(pending);
      await client.applyOperations(
        batch.map((item) => item.operation),
        AbortSignal.timeout(REPLICATION_TIMEOUT_MS),
      );
      this.local.acknowledgeOperations(batch.map((item) => item.rowId));
    }
  }
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
