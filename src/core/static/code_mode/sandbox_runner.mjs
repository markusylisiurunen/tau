import { Buffer } from "node:buffer";
import { parentPort, workerData } from "node:worker_threads";
import { truncateToBytesFromEnd } from "../../utils/truncate.js";
import { codeModeMath, createCodeModeDate } from "./capabilities.mjs";

if (!parentPort) {
  throw new Error("code-mode sandbox requires a parent port");
}
if (
  typeof workerData !== "object" ||
  workerData === null ||
  typeof workerData.code !== "string" ||
  typeof workerData.docs !== "string" ||
  !Number.isSafeInteger(workerData.imageMethodId) ||
  workerData.imageMethodId < 0 ||
  !Array.isArray(workerData.apis) ||
  workerData.apis.length === 0 ||
  workerData.apis.some(
    (api) =>
      typeof api !== "object" ||
      api === null ||
      typeof api.name !== "string" ||
      !Array.isArray(api.methods),
  ) ||
  !Number.isSafeInteger(workerData.maxBridgeRequests) ||
  workerData.maxBridgeRequests <= 0 ||
  !Number.isSafeInteger(workerData.maxConcurrentBridgeRequests) ||
  workerData.maxConcurrentBridgeRequests <= 0 ||
  !Number.isSafeInteger(workerData.maxBridgePayloadBytes) ||
  workerData.maxBridgePayloadBytes <= 0 ||
  !Number.isSafeInteger(workerData.maxCaptureBytes) ||
  workerData.maxCaptureBytes <= 0
) {
  throw new Error("code-mode sandbox received invalid worker data");
}

lockdown();

const codeModeDate = createCodeModeDate();
const pending = new Map();
let nextRequestId = 1;
let outputText = "";
let outputStdout = "";
let outputStderr = "";
let outputBytes = 0;
let nextOutputId = 1;
const pendingOutputs = new Set();

parentPort.on("message", (message) => {
  if (message?.type === "output.ack" && typeof message.id === "number") {
    pendingOutputs.delete(message.id);
    flushOutput();
    return;
  }
  if (message?.type !== "response" || typeof message.id !== "number") return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.ok) {
    try {
      if (
        typeof message.valueJson !== "string" ||
        Buffer.byteLength(message.valueJson, "utf8") > workerData.maxBridgePayloadBytes
      ) {
        throw new Error("invalid code-mode bridge response");
      }
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
  if (Buffer.byteLength(argsJson, "utf8") > workerData.maxBridgePayloadBytes) {
    return Promise.reject(
      new Error(
        `code-mode API arguments exceeded ${workerData.maxBridgePayloadBytes} bridge payload bytes`,
      ),
    );
  }
  if (nextRequestId > workerData.maxBridgeRequests) {
    return Promise.reject(
      new Error(`code-mode sandbox exceeded ${workerData.maxBridgeRequests} bridge requests`),
    );
  }
  if (pending.size >= workerData.maxConcurrentBridgeRequests) {
    return Promise.reject(
      new Error(
        `code-mode sandbox exceeded ${workerData.maxConcurrentBridgeRequests} concurrent bridge requests`,
      ),
    );
  }
  flushOutput(true);
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "request", id, methodId, argsJson });
  });
}

function flushOutput(force = false) {
  if (
    !outputBytes ||
    (!force && pendingOutputs.size >= workerData.maxConcurrentBridgeRequests)
  ) return;
  const id = nextOutputId++;
  pendingOutputs.add(id);
  parentPort.postMessage({
    type: "output",
    id,
    text: outputText,
    stdout: outputStdout,
    stderr: outputStderr,
    bytes: outputBytes,
  });
  outputText = "";
  outputStdout = "";
  outputStderr = "";
  outputBytes = 0;
}

function writeOutput(stream, text) {
  if ((stream !== "stdout" && stream !== "stderr") || typeof text !== "string") {
    throw new Error("invalid console bridge output");
  }
  const output = text + "\n";
  outputBytes += Buffer.byteLength(output);
  outputText = truncateToBytesFromEnd(outputText + output, workerData.maxCaptureBytes);
  if (stream === "stdout") {
    outputStdout = truncateToBytesFromEnd(outputStdout + output, workerData.maxCaptureBytes);
  } else {
    outputStderr = truncateToBytesFromEnd(outputStderr + output, workerData.maxCaptureBytes);
  }
  flushOutput();
}

const compartment = new Compartment({
  globals: {
    Date: codeModeDate,
    Math: codeModeMath,
    _apis: harden(workerData.apis),
    _imageMethodId: workerData.imageMethodId,
    _requestApi: harden(requestApi),
    _writeOutput: harden(writeOutput),
    docs: workerData.docs,
  },
  __options__: true,
});

compartment.evaluate(String.raw`
(() => {
  const apis = _apis;
  const requestApiBridge = _requestApi;
  const writeOutputBridge = _writeOutput;
  const imageMethodId = _imageMethodId;
  delete globalThis._imageMethodId;
  delete globalThis._apis;
  delete globalThis._requestApi;
  delete globalThis._writeOutput;

  Object.defineProperty(globalThis, "printText", {
    value: (text) => {
      if (typeof text !== "string") throw new TypeError("printText expects a string");
      writeOutputBridge("stdout", text);
    },
  });
  delete globalThis.console;

  function bound(values, limit, position, unit) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive integer");
    if (!["middle", "start", "end"].includes(position)) throw new TypeError("invalid truncation position");
    if (values.length <= limit) return values.join(unit === "lines" ? "\n" : "");
    const joiner = unit === "lines" ? "\n" : "";
    let kept = unit === "lines" ? limit - 1 : limit;
    let marker;
    while (true) {
      marker = "[" + (values.length - kept) + " " + unit + " omitted]";
      const next = unit === "lines" ? kept : Math.max(0, limit - Array.from(marker).length);
      if (next === kept) break;
      kept = next;
    }
    if (unit !== "lines" && marker.length > limit) return "…";
    const head = position === "end" ? 0 : position === "start" ? kept : Math.ceil(kept / 2);
    const tail = kept - head;
    return [...values.slice(0, head), marker, ...(tail ? values.slice(-tail) : [])].join(joiner);
  }
  Object.defineProperty(globalThis, "truncate", {
    value: (text, { maxChars, position = "middle" }) => {
      if (typeof text !== "string") throw new TypeError("truncate expects a string");
      return bound(Array.from(text), maxChars, position, "characters");
    },
  });
  Object.defineProperty(globalThis, "truncateLines", {
    value: (text, { maxLines, position = "middle" }) => {
      if (typeof text !== "string") throw new TypeError("truncateLines expects a string");
      return bound(text.replace(/\r\n?/g, "\n").split("\n"), maxLines, position, "lines");
    },
  });

  function serializeArguments(args) {
    return JSON.stringify(args, function (_key, value) {
      if (value === undefined && !Array.isArray(this)) return undefined;
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

  Object.defineProperty(globalThis, "printImage", {
    value: async (...args) => {
      await requestApiBridge(imageMethodId, serializeArguments(args));
    },
  });

  function freezeApi(value) {
    for (const child of Object.values(value)) {
      if (typeof child === "object" && child !== null) freezeApi(child);
    }
    return Object.freeze(value);
  }

  for (const definition of apis) {
    const api = Object.create(null);
    for (const method of definition.methods) {
      let target = api;
      for (const segment of method.path.slice(0, -1)) {
        target[segment] ??= Object.create(null);
        target = target[segment];
      }
      target[method.path.at(-1)] = (...args) =>
        requestApiBridge(method.id, serializeArguments(args));
    }
    Object.defineProperty(globalThis, definition.name, {
      value: freezeApi(api),
    });
  }
})();
`);

try {
  await compartment.evaluate("(async () => {\n" + workerData.code + "\n})()");
} catch (error) {
  writeOutput("stderr", error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
} finally {
  flushOutput(true);
  parentPort.close();
}
