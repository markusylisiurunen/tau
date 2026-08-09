import { parentPort, workerData } from "node:worker_threads";
import { codeModeMath, createCodeModeDate } from "./capabilities.mjs";

if (!parentPort) {
  throw new Error("code-mode sandbox requires a parent port");
}
if (
  typeof workerData !== "object" ||
  workerData === null ||
  typeof workerData.code !== "string" ||
  typeof workerData.docs !== "string" ||
  typeof workerData.name !== "string" ||
  !Array.isArray(workerData.methods)
) {
  throw new Error("code-mode sandbox received invalid worker data");
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
    try {
      request.resolve(JSON.parse(message.valueJson));
    } catch {
      request.reject(new Error("code-mode bridge returned invalid JSON"));
    }
    return;
  }

  const error = new Error(message.error?.message || "Code-mode API request failed");
  if (message.error?.name) error.name = message.error.name;
  request.reject(error);
});

function requestApi(methodId, argsJson) {
  if (!Number.isSafeInteger(methodId) || methodId < 0 || typeof argsJson !== "string") {
    return Promise.reject(new Error("invalid code-mode bridge request"));
  }
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "request", id, methodId, argsJson });
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
    _apiName: workerData.name,
    _methods: harden(workerData.methods),
    _requestApi: harden(requestApi),
    _writeOutput: harden(writeOutput),
    docs: workerData.docs,
  },
  __options__: true,
});

compartment.evaluate(String.raw`
(() => {
  const apiName = _apiName;
  const methods = _methods;
  const requestApiBridge = _requestApi;
  const writeOutputBridge = _writeOutput;
  delete globalThis._apiName;
  delete globalThis._methods;
  delete globalThis._requestApi;
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

  function serializeArguments(args) {
    return JSON.stringify(args, (_key, value) => {
      if (
        value === undefined ||
        typeof value === "function" ||
        typeof value === "symbol" ||
        typeof value === "bigint" ||
        (typeof value === "number" && !Number.isFinite(value))
      ) {
        throw new TypeError("Code-mode API arguments must be JSON-serializable values");
      }
      return value;
    });
  }

  const api = Object.create(null);
  for (const method of methods) {
    let target = api;
    for (const segment of method.path.slice(0, -1)) {
      target[segment] ??= Object.create(null);
      target = target[segment];
    }
    target[method.path.at(-1)] = (...args) =>
      requestApiBridge(method.id, serializeArguments(args));
  }

  function freezeApi(value) {
    for (const child of Object.values(value)) {
      if (typeof child === "object" && child !== null) freezeApi(child);
    }
    return Object.freeze(value);
  }

  Object.defineProperty(globalThis, apiName, {
    value: freezeApi(api),
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
