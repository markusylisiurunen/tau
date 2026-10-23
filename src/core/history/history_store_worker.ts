import { parentPort, workerData } from "node:worker_threads";
import { LocalHistoryStore } from "./local_history_store.js";
import type { HistoryStoreRequest } from "./threaded_history_store.js";

const port = parentPort!;
let store: LocalHistoryStore | undefined;
port.on("message", async ({ id, method, args }: HistoryStoreRequest) => {
  try {
    store ??= new LocalHistoryStore(workerData.path, { busyTimeoutMs: 50 });
    const result = await Reflect.apply(store[method], store, args);
    port.postMessage({ id, result });
  } catch (error) {
    port.postMessage({
      id,
      error: {
        message: error instanceof Error ? error.message : String(error),
        errcode: (error as { errcode?: number })?.errcode,
      },
    });
  }
});
