import { Worker } from "node:worker_threads";
import type { LocalHistoryStore } from "./local_history_store.js";

export type HistoryStoreMethod = Exclude<keyof LocalHistoryStore, "close">;
export type HistoryStoreRequest = {
  id: number;
  method: HistoryStoreMethod;
  args: unknown[];
};
export type HistoryStore = {
  [K in keyof LocalHistoryStore]: (
    ...args: Parameters<LocalHistoryStore[K]>
  ) => ReturnType<LocalHistoryStore[K]> | Promise<Awaited<ReturnType<LocalHistoryStore[K]>>>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class ThreadedHistoryStore implements HistoryStore {
  private worker: Worker | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private closed = false;

  constructor(private readonly path: string) {}

  createSession(...args: Parameters<LocalHistoryStore["createSession"]>) {
    return this.request("createSession", args);
  }

  append(...args: Parameters<LocalHistoryStore["append"]>) {
    return this.request("append", args);
  }

  truncateFromSources(...args: Parameters<LocalHistoryStore["truncateFromSources"]>) {
    return this.request("truncateFromSources", args);
  }

  search(...args: Parameters<LocalHistoryStore["search"]>) {
    return this.request("search", args);
  }

  read(...args: Parameters<LocalHistoryStore["read"]>) {
    return this.request("read", args);
  }

  listPendingOperations(...args: Parameters<LocalHistoryStore["listPendingOperations"]>) {
    return this.request("listPendingOperations", args);
  }

  listPendingOperationLanes(...args: Parameters<LocalHistoryStore["listPendingOperationLanes"]>) {
    return this.request("listPendingOperationLanes", args);
  }

  acknowledgeOperations(...args: Parameters<LocalHistoryStore["acknowledgeOperations"]>) {
    return this.request("acknowledgeOperations", args);
  }

  quarantineReplicationSession(
    ...args: Parameters<LocalHistoryStore["quarantineReplicationSession"]>
  ) {
    return this.request("quarantineReplicationSession", args);
  }

  clearReplicationFailure(...args: Parameters<LocalHistoryStore["clearReplicationFailure"]>) {
    return this.request("clearReplicationFailure", args);
  }

  listReplicationFailures(...args: Parameters<LocalHistoryStore["listReplicationFailures"]>) {
    return this.request("listReplicationFailures", args);
  }

  close(): void {
    this.closed = true;
    const worker = this.worker;
    this.fail(new Error("history store is closed"));
    if (worker) void worker.terminate();
  }

  private request<K extends HistoryStoreMethod>(
    method: K,
    args: Parameters<LocalHistoryStore[K]>,
  ): Promise<Awaited<ReturnType<LocalHistoryStore[K]>>> {
    if (this.closed) return Promise.reject(new Error("history store is closed"));
    if (!this.worker) {
      const worker = new Worker(new URL("./history_store_worker.js", import.meta.url), {
        workerData: { path: this.path },
        execArgv: [],
      });
      this.worker = worker;
      worker.on("message", ({ id, result, error }) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        if (error)
          pending.reject(Object.assign(new Error(error.message), { errcode: error.errcode }));
        else pending.resolve(result);
        if (this.pending.size === 0) worker.unref();
      });
      worker.on("error", (error) => {
        if (this.worker === worker) this.fail(error);
      });
      worker.on("exit", (code) => {
        if (this.worker === worker) this.fail(new Error(`history worker exited (${code})`));
      });
    }
    const worker = this.worker;
    worker.ref();
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, {
        resolve: (value) => resolve(value as Awaited<ReturnType<LocalHistoryStore[K]>>),
        reject,
      });
      try {
        worker.postMessage({ id, method, args } satisfies HistoryStoreRequest);
      } catch (error) {
        this.pending.delete(id);
        if (this.pending.size === 0) worker.unref();
        reject(error);
      }
    });
  }

  private fail(error: Error): void {
    this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
