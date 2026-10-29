import { setTimeout as delay } from "node:timers/promises";
import { RemoteHistoryClient, RemoteHistoryError } from "./remote_history_client.js";
import { type HistoryStore, ThreadedHistoryStore } from "./threaded_history_store.js";
import type {
  HistoryEntry,
  HistoryQuery,
  HistoryRemoteTarget,
  HistorySessionRecord,
} from "./types.js";

const REPLICATION_BATCH_SIZE = 10;
const REPLICATION_LANE_BATCH_SIZE = 10;
const REPLICATION_BATCH_BYTES = 6 * 1024 * 1024;
const REPLICATION_TIMEOUT_MS = 15_000;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;
const FLUSH_TIMEOUT_MS = 2_000;
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

export type HistoryRecordingDiagnostic = {
  event: "history_recording";
  status: "delayed" | "dropped" | "recovered";
  sessionId: string;
  pendingOperations: number;
  pendingBytes: number;
  message: string;
};

export type HistoryDiagnostic = HistoryReplicationFailureDiagnostic | HistoryRecordingDiagnostic;

export type HistoryManagerOptions = {
  reportReplicationFailure?: (diagnostic: HistoryReplicationFailureDiagnostic) => void;
  reportRecording?: (diagnostic: HistoryRecordingDiagnostic) => void;
  maxPendingBytes?: number;
};

type RecordingChange =
  | { type: "register" }
  | { type: "append"; entries: HistoryEntry[] }
  | { type: "truncate"; sourceIds: string[] };
type PendingRecording = {
  session: HistorySessionRecord;
  remote?: HistoryRemoteTarget;
  change: RecordingChange;
  bytes: number;
};

export class HistoryManager {
  private readonly replicationRuns = new Map<string, Promise<void>>();
  private readonly replicationRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly targets = new Map<string, HistoryRemoteTarget>();
  private readonly sessions = new Map<
    string,
    { session: HistorySessionRecord; references: number }
  >();
  private readonly pending: PendingRecording[] = [];
  private pendingBytes = 0;
  private recording: Promise<void> | undefined;
  private closed = false;
  private delayed = false;
  private lastDropDiagnostic = 0;
  private readonly stop = new AbortController();
  private readonly reportReplicationFailure: NonNullable<
    HistoryManagerOptions["reportReplicationFailure"]
  >;

  constructor(
    private readonly local: HistoryStore,
    private readonly options: HistoryManagerOptions = {},
  ) {
    this.reportReplicationFailure = options.reportReplicationFailure ?? (() => {});
  }

  static open(path: string, options: HistoryManagerOptions = {}): HistoryManager {
    return new HistoryManager(new ThreadedHistoryStore(path), options);
  }

  registerSession(session: HistorySessionRecord, remote?: HistoryRemoteTarget): string | undefined {
    const references = (this.sessions.get(session.sessionId)?.references ?? 0) + 1;
    this.sessions.set(session.sessionId, { session: structuredClone(session), references });
    return this.enqueue(session.sessionId, { type: "register" }, remote);
  }

  append(
    sessionId: string,
    entries: HistoryEntry[],
    remote?: HistoryRemoteTarget,
  ): string | undefined {
    if (entries.length === 0) return undefined;
    return this.enqueue(sessionId, { type: "append", entries }, remote);
  }

  truncateFromSources(
    sessionId: string,
    sourceIds: string[],
    remote?: HistoryRemoteTarget,
  ): string | undefined {
    if (sourceIds.length === 0) return undefined;
    return this.enqueue(sessionId, { type: "truncate", sourceIds }, remote);
  }

  forgetSession(sessionId: string): void {
    const registration = this.sessions.get(sessionId);
    if (!registration) return;
    registration.references -= 1;
    if (registration.references === 0) this.sessions.delete(sessionId);
  }

  query(remote?: HistoryRemoteTarget): HistoryQuery {
    const remoteClient = remote ? new RemoteHistoryClient(remote) : undefined;
    return {
      search: async (input, signal) => {
        if (remoteClient) return await remoteClient.search(input, signal);
        await this.flushRecording();
        return await this.local.search(input);
      },
      read: async (input, signal) => {
        if (remoteClient && input.source !== "local") return await remoteClient.read(input, signal);
        await this.flushRecording();
        return await this.local.read(input);
      },
    };
  }

  async flush(): Promise<void> {
    await this.bounded(async () => {
      await this.recording;
      await Promise.allSettled([...this.replicationRuns.values()]);
    });
  }

  async retryReplication(target: HistoryRemoteTarget, sessionId: string): Promise<void> {
    await this.replicationRuns.get(target.endpoint);
    await this.local.clearReplicationFailure(target.endpoint, sessionId);
    this.scheduleReplication(target);
    await this.replicationRuns.get(target.endpoint);
  }

  close(): void {
    if (this.closed) return;
    if (this.pending[0])
      this.reportRecording(
        "dropped",
        this.pending[0].session.sessionId,
        "host closed with pending history",
      );
    this.closed = true;
    this.stop.abort();
    for (const timer of this.replicationRetries.values()) clearTimeout(timer);
    this.replicationRetries.clear();
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.sessions.clear();
    try {
      void Promise.resolve(this.local.close()).catch(() => {});
    } catch {
      // History shutdown must not prevent the host from closing.
    }
  }

  private enqueue(
    sessionId: string,
    change: RecordingChange,
    remote?: HistoryRemoteTarget,
  ): string | undefined {
    if (this.closed) return "history manager is closed";
    const session = this.sessions.get(sessionId)?.session;
    if (!session) return `history session '${sessionId}' was not registered`;
    const bytes = Buffer.byteLength(JSON.stringify({ session, change }));
    if (this.pendingBytes + bytes > (this.options.maxPendingBytes ?? MAX_PENDING_BYTES)) {
      const message = "history buffer is full; this change was dropped";
      this.reportRecording("dropped", sessionId, message);
      return message;
    }
    this.pending.push({ session, change: structuredClone(change), remote, bytes });
    this.pendingBytes += bytes;
    this.startRecording();
    return undefined;
  }

  private startRecording(): void {
    if (this.closed || this.recording || this.pending.length === 0) return;
    this.recording = this.drain().finally(() => {
      this.recording = undefined;
      this.startRecording();
    });
  }

  private async drain(): Promise<void> {
    let attempts = 0;
    while (!this.closed && this.pending[0]) {
      const item = this.pending[0];
      try {
        // Registration may have been dropped during an earlier buffer overflow.
        await this.local.createSession(item.session, item.remote);
        if (item.change.type === "append")
          await this.local.append(item.session.sessionId, item.change.entries, item.remote);
        else if (item.change.type === "truncate")
          await this.local.truncateFromSources(
            item.session.sessionId,
            item.change.sourceIds,
            item.remote,
          );
        if (this.closed) return;
        if (this.delayed) {
          this.delayed = false;
          this.reportRecording("recovered", item.session.sessionId, "history recording resumed");
        }
        if (item.remote) this.scheduleReplication(item.remote);
        attempts = 0;
      } catch (error) {
        if (this.closed) return;
        if (isBusy(error)) {
          if (!this.delayed) {
            this.delayed = true;
            this.reportRecording("delayed", item.session.sessionId, formatFailureReason(error));
          }
          const wait = Math.min(100 * 2 ** Math.min(attempts++, 5), 2_000);
          await delay(wait + (Math.random() * wait) / 4, undefined, {
            signal: this.stop.signal,
            ref: false,
          }).catch(() => {});
          continue;
        }
        this.delayed = true;
        this.reportRecording("dropped", item.session.sessionId, formatFailureReason(error));
      }
      if (this.closed) return;
      this.pending.shift();
      this.pendingBytes -= item.bytes;
    }
  }

  private async flushRecording(): Promise<void> {
    await this.bounded(async () => {
      await this.recording;
    });
  }

  private async bounded(action: () => Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        action(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private reportRecording(
    status: HistoryRecordingDiagnostic["status"],
    sessionId: string,
    message: string,
  ): void {
    if (status === "dropped") {
      const now = Date.now();
      if (now - this.lastDropDiagnostic < 1_000) return;
      this.lastDropDiagnostic = now;
    }
    try {
      this.options.reportRecording?.({
        event: "history_recording",
        status,
        sessionId,
        pendingOperations: this.pending.length,
        pendingBytes: this.pendingBytes,
        message,
      });
    } catch {
      // Diagnostics must not stop recording or agent work.
    }
  }

  private retryReplicationLater(target: HistoryRemoteTarget): void {
    if (this.closed || this.replicationRetries.has(target.endpoint)) return;
    const timer = setTimeout(() => {
      this.replicationRetries.delete(target.endpoint);
      this.scheduleReplication(target);
    }, 5_000);
    timer.unref();
    this.replicationRetries.set(target.endpoint, timer);
  }

  private scheduleReplication(target: HistoryRemoteTarget): void {
    if (this.closed) return;
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
      this.retryReplicationLater(target);
    });
  }

  private async replicate(endpoint: string): Promise<void> {
    const target = this.targets.get(endpoint);
    if (!target) return;
    const client = new RemoteHistoryClient(target);
    while (!this.closed) {
      const local = this.local;
      const lanes = await local.listPendingOperationLanes(
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
            AbortSignal.any([this.stop.signal, AbortSignal.timeout(REPLICATION_TIMEOUT_MS)]),
          );
        } catch (error) {
          if (isPermanentReplicationFailure(error)) {
            await local.quarantineReplicationSession({
              endpoint,
              sessionId: first.sessionId,
              operationId: error.operationId ?? null,
              code: error.code,
              message: error.message,
              failedAt: Date.now(),
            });
            this.emitReplicationFailure({
              endpoint,
              sessionId: first.sessionId,
              operationId: error.operationId,
              error,
              quarantined: true,
            });
            continue;
          }
          this.emitReplicationFailure({
            endpoint,
            sessionId: first.sessionId,
            operationId: error instanceof RemoteHistoryError ? error.operationId : undefined,
            error,
          });
          this.retryReplicationLater(target);
          return;
        }
        await local.acknowledgeOperations(batch.map((item) => item.rowId));
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

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown })?.errcode;
  return typeof code === "number" && ((code & 0xff) === 5 || (code & 0xff) === 6);
}
