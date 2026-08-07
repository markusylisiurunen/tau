import { parentPort, workerData } from "node:worker_threads";
import { codeModeMath, createCodeModeDate } from "../capabilities.mjs";

if (!parentPort) {
  throw new Error("nook sandbox requires a parent port");
}
if (
  typeof workerData !== "object" ||
  workerData === null ||
  typeof workerData.code !== "string" ||
  typeof workerData.docs !== "string"
) {
  throw new Error("nook sandbox received invalid worker data");
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

  const error = new Error(message.error?.message || "Nook request failed");
  if (message.error?.name) error.name = message.error.name;
  request.reject(error);
});

function requestNook(method, argsJson) {
  if (typeof method !== "string" || typeof argsJson !== "string") {
    return Promise.reject(new Error("invalid nook bridge request"));
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
    _requestNook: harden(requestNook),
    _writeOutput: harden(writeOutput),
    docs: workerData.docs,
  },
  __options__: true,
});

compartment.evaluate(String.raw`
(() => {
  const requestNookBridge = _requestNook;
  const writeOutputBridge = _writeOutput;
  delete globalThis._requestNook;
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
        throw new TypeError("Nook arguments must be JSON-serializable values");
      }
      return value;
    });
  }
  function callNook(method, args) {
    return requestNookBridge(method, serializeArguments(args));
  }
  Object.defineProperty(globalThis, "nook", {
    value: Object.freeze({
      skill: (...args) => callNook("skill", args),
      sites: Object.freeze({
        list: (...args) => callNook("sites.list", args),
        copy: (...args) => callNook("sites.copy", args),
        deploy: (...args) => callNook("sites.deploy", args),
        delete: (...args) => callNook("sites.delete", args),
      }),
      templates: Object.freeze({
        list: (...args) => callNook("templates.list", args),
        copy: (...args) => callNook("templates.copy", args),
        save: (...args) => callNook("templates.save", args),
        delete: (...args) => callNook("templates.delete", args),
      }),
      kv: Object.freeze({
        get: (...args) => callNook("kv.get", args),
        getToFile: (...args) => callNook("kv.getToFile", args),
        put: (...args) => callNook("kv.put", args),
        putFromFile: (...args) => callNook("kv.putFromFile", args),
        delete: (...args) => callNook("kv.delete", args),
        list: (...args) => callNook("kv.list", args),
      }),
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
