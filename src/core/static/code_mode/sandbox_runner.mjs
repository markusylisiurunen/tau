import { Buffer } from "node:buffer";
import { parentPort, workerData } from "node:worker_threads";
import { decodeBridgeValue, encodeBridgeValue } from "../../../code_mode/wire.js";
import { truncateToBytesFromEnd } from "../../utils/truncate.js";
import { codeModeMath, createCodeModeDate } from "./capabilities.mjs";
import { compileModules } from "./modules.mjs";

if (!parentPort) {
  throw new Error("code-mode sandbox requires a parent port");
}
if (
  typeof workerData !== "object" ||
  workerData === null ||
  typeof workerData.code !== "string" ||
  typeof workerData.cwd !== "string" ||
  (workerData.entryPath !== undefined && typeof workerData.entryPath !== "string") ||
  !Number.isSafeInteger(workerData.sourceMethodId) ||
  typeof workerData.inputJson !== "string" ||
  !Array.isArray(workerData.apis) ||
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
      request.resolve(decodeBridgeValue(message.valueJson));
    } catch {
      request.reject(new Error("code-mode bridge returned invalid JSON"));
    }
    return;
  }

  const error = new Error(message.error?.message || "Code-mode API request failed");
  if (message.error?.name) error.name = message.error.name;
  if (typeof message.error?.code === "string") error.code = message.error.code;
  if (message.error?.exitCode === null || typeof message.error?.exitCode === "number") error.exitCode = message.error.exitCode;
  request.reject(error);
});

function requestApi(methodId, argsJson) {
  if (!Number.isSafeInteger(methodId) || methodId < 0 || typeof argsJson !== "string") {
    return Promise.reject(new Error("invalid code-mode bridge request"));
  }
  if (Buffer.byteLength(argsJson, "utf8") > workerData.maxBridgePayloadBytes) {
    return Promise.reject(
      new Error(
        `code-mode API arguments exceeded ${workerData.maxBridgePayloadBytes} bridge payload bytes; use file paths instead of inline media`,
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
    bytes: outputBytes,
  });
  outputText = "";
  outputBytes = 0;
}

function writeOutput(text) {
  const output = text + "\n";
  outputBytes += Buffer.byteLength(output);
  outputText = truncateToBytesFromEnd(outputText + output, workerData.maxCaptureBytes);
  flushOutput();
}

const compartment = new Compartment({
  globals: {
    Date: codeModeDate,
    Math: codeModeMath,
    _apis: harden(workerData.apis),
    _requestApi: harden(requestApi),
    _writeOutput: harden(writeOutput),
    _encodeValue: harden(encodeBridgeValue),
    _inputJson: workerData.inputJson,
  },
  __options__: true,
});

const packages = compartment.evaluate(String.raw`
(() => {
  const input = JSON.parse(_inputJson);
  const apis = _apis;
  const requestApi = _requestApi;
  const writeOutput = _writeOutput;
  const encodeValue = _encodeValue;
  for (const name of ["_inputJson", "_apis", "_requestApi", "_writeOutput", "_encodeValue", "console"]) {
    delete globalThis[name];
  }

  const printText = (text) => {
    if (typeof text !== "string") throw new TypeError("printText expects a string. Select relevant fields and format concise plain text to save tokens. Only use JSON.stringify on selected data when JSON structure is needed; do not dump whole responses.");
    writeOutput(text);
  };
  const truncate = (text, options) => {
    if (typeof text !== "string") throw new TypeError("truncate expects a string");
    const { maxChars, maxLines, keep = "both" } = options;
    if ((maxChars === undefined) === (maxLines === undefined)) {
      throw new TypeError("Specify exactly one of maxChars and maxLines");
    }
    const limit = maxChars ?? maxLines;
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive integer");
    if (!["head", "tail", "both"].includes(keep)) throw new TypeError("invalid keep option");
    const values = maxLines === undefined ? Array.from(text) : text.split(/\r\n|\n|\r/);
    if (values.length <= limit) return text;
    const head = keep === "head" ? limit : keep === "tail" ? 0 : Math.ceil(limit / 2);
    const tail = limit - head;
    return [...values.slice(0, head), "…", ...(tail > 0 ? values.slice(-tail) : [])]
      .join(maxLines === undefined ? "" : "\n");
  };

  const freeze = (value) => {
    for (const child of Object.values(value)) {
      if (typeof child === "object" && child !== null) freeze(child);
    }
    return Object.freeze(value);
  };
  const packages = Object.create(null);
  for (const definition of apis) {
    const api = Object.create(null);
    for (const method of definition.methods) {
      let target = api;
      for (const segment of method.path.slice(0, -1)) {
        target[segment] ??= Object.create(null);
        target = target[segment];
      }
      target[method.path.at(-1)] = (...args) => requestApi(method.id, encodeValue(args, true));
    }
    packages[definition.name] = api;
  }
  const core = packages["@tau/core"];
  const printImage = core.printImage;
  core.printImage = async (image) => { await printImage(image); };
  Object.assign(core, { input, printText, truncate });
  for (const api of Object.values(packages)) {
    for (const value of Object.values(api)) {
      if (value !== input && typeof value === "object" && value !== null) freeze(value);
    }
    Object.freeze(api);
  }
  return Object.freeze(packages);
})();
`);

try {
  const program = await compileModules({
    code: workerData.code,
    cwd: workerData.cwd,
    entryPath: workerData.entryPath,
    packages,
    readSource: (path) => requestApi(workerData.sourceMethodId, encodeBridgeValue([path], false)),
  });
  const execute = compartment.evaluate("(async (__tauPackages) => {\n\"use strict\";\n" + program + "\n})");
  await execute(packages);
} catch (error) {
  writeOutput(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
} finally {
  flushOutput(true);
  parentPort.close();
}
