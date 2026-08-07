import { parentPort, workerData } from "node:worker_threads";
import { codeModeMath, createCodeModeDate } from "../capabilities.mjs";

if (!parentPort) throw new Error("history sandbox requires a parent port");
if (
  typeof workerData !== "object" ||
  workerData === null ||
  typeof workerData.code !== "string" ||
  typeof workerData.docs !== "string"
) {
  throw new Error("history sandbox received invalid worker data");
}

lockdown();

const codeModeDate = createCodeModeDate();
const pending = new Map();
let nextRequestId = 1;

parentPort.on("message", (message) => {
  if (message?.type !== "response" || typeof message.id !== "number") return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.ok) {
    request.resolve(message.value);
    return;
  }
  const error = new Error(message.error?.message || "History request failed");
  if (message.error?.name) error.name = message.error.name;
  request.reject(error);
});

function requestHistory(method, argsJson) {
  if (typeof method !== "string" || typeof argsJson !== "string") {
    return Promise.reject(new Error("invalid history bridge request"));
  }
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "request", id, method, argsJson });
  });
}

function writeOutput(stream, text) {
  if ((stream !== "stdout" && stream !== "stderr") || typeof text !== "string") {
    throw new Error("invalid console bridge output");
  }
  const output = stream === "stderr" ? process.stderr : process.stdout;
  output.write(text + "\n");
}

const compartment = new Compartment({
  globals: {
    Date: codeModeDate,
    Math: codeModeMath,
    _requestHistory: harden(requestHistory),
    _writeOutput: harden(writeOutput),
    docs: workerData.docs,
  },
  __options__: true,
});

compartment.evaluate(String.raw`
(() => {
  const requestHistoryBridge = _requestHistory;
  const writeOutputBridge = _writeOutput;
  delete globalThis._requestHistory;
  delete globalThis._writeOutput;

  function formatOutputValue(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || value.message;
    try {
      const serialized = JSON.stringify(value);
      if (serialized !== undefined) return serialized;
    } catch {}
    return String(value);
  }
  function writeConsole(stream, values) {
    writeOutputBridge(stream, values.map(formatOutputValue).join(" "));
  }
  Object.defineProperty(globalThis, "console", {
    value: Object.freeze({
      debug: (...values) => writeConsole("stdout", values),
      error: (...values) => writeConsole("stderr", values),
      info: (...values) => writeConsole("stdout", values),
      log: (...values) => writeConsole("stdout", values),
      warn: (...values) => writeConsole("stderr", values),
    }),
  });
  function callHistory(method, args) {
    return requestHistoryBridge(method, JSON.stringify(args));
  }
  Object.defineProperty(globalThis, "history", {
    value: Object.freeze({
      search: (...args) => callHistory("search", args),
      read: (...args) => callHistory("read", args),
    }),
  });
})();
`);

try {
  await compartment.evaluate("(async () => {\n" + workerData.code + "\n})()");
} catch (error) {
  writeOutput("stderr", error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
} finally {
  parentPort.close();
}
