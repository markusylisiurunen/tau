import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import "ses";

lockdown();

const requests = createWriteStream(null, { fd: 3 });
const responses = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Map();
let nextRequestId = 1;
let initialization;
let resolveInitialization;
const initialized = new Promise((resolve) => {
  resolveInitialization = resolve;
});

responses.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (!initialization) {
    initialization = message;
    resolveInitialization();
    return;
  }

  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.ok) {
    request.resolve(JSON.stringify(message.value));
    return;
  }

  const error = new Error(message.error?.message || "Web request failed");
  if (message.error?.name) error.name = message.error.name;
  request.reject(error);
});

function requestWeb(method, argsJson) {
  if (typeof method !== "string" || typeof argsJson !== "string") {
    return Promise.reject(new Error("invalid web bridge request"));
  }
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    requests.write(JSON.stringify({ id, method, argsJson }) + "\n");
  });
}

function writeOutput(stream, text) {
  if ((stream !== "stdout" && stream !== "stderr") || typeof text !== "string") {
    throw new Error("invalid console bridge output");
  }
  const output = stream === "stderr" ? process.stderr : process.stdout;
  output.write(text + "\n");
}

await initialized;

const compartment = new Compartment({
  globals: {
    _requestWeb: harden(requestWeb),
    _writeOutput: harden(writeOutput),
    docs: initialization.docs,
  },
  __options__: true,
});

compartment.evaluate(String.raw`
(() => {
  const requestWebBridge = _requestWeb;
  const writeOutputBridge = _writeOutput;
  delete globalThis._requestWeb;
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
  function callWeb(method, args) {
    return requestWebBridge(method, JSON.stringify(args)).then((value) => JSON.parse(value));
  }
  Object.defineProperty(globalThis, "web", {
    value: Object.freeze({
      discover: (...args) => callWeb("discover", args),
      search: (...args) => callWeb("search", args),
      fetch: (...args) => callWeb("fetch", args),
    }),
  });
})();
`);

try {
  await compartment.evaluate("(async () => {\n" + initialization.code + "\n})()");
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
} finally {
  requests.end();
  responses.close();
}
