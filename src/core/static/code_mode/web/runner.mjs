import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import Exa from "exa-js";

const CHILD_SOURCE = String.raw`
import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import vm from "node:vm";

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
    request.resolve(message.value);
    return;
  }

  const error = new Error(message.error?.message || "Exa request failed");
  if (message.error?.name) error.name = message.error.name;
  if (message.error?.stack) error.stack = message.error.stack;
  request.reject(error);
});

function callExa(method, args) {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    requests.write(JSON.stringify({ id, method, args }) + "\n");
  });
}

await initialized;

const exa = Object.freeze({
  search: (...args) => callExa("search", args),
  getContents: (...args) => callExa("getContents", args),
});
const context = vm.createContext(
  {
    console,
    docs: initialization.docs,
    exa,
    clearInterval,
    clearTimeout,
    setInterval,
    setTimeout,
    structuredClone,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
  },
  {
    codeGeneration: { strings: true, wasm: false },
    name: "tau-web-code-mode",
  },
);
const script = new vm.Script(
  "(async () => {\n" + initialization.code + "\n})()",
  { filename: "tau-web-code-mode.js" },
);
await script.runInContext(context);
requests.end();
responses.close();
`;

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

const input = JSON.parse(await readStdin());
const documentation = await readFile(new URL("./documentation.md", import.meta.url), "utf8");
const exa = new Exa(input.apiKey);
const child = spawn(
  process.execPath,
  ["--permission", "--no-warnings", "--input-type=module", "--eval", CHILD_SOURCE],
  {
    cwd: input.cwd,
    env: {
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
      ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  },
);

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

const rpcOutput = child.stdio[3];
if (!rpcOutput) {
  throw new Error("failed to create Exa SDK bridge");
}

const rpcLines = createInterface({ input: rpcOutput, crlfDelay: Infinity });
rpcLines.on("line", (line) => {
  void (async () => {
    let request;
    try {
      request = JSON.parse(line);
      if (request.method !== "search" && request.method !== "getContents") {
        throw new Error("unsupported Exa SDK method '" + String(request.method) + "'");
      }
      const method = exa[request.method];
      const value = await method.apply(exa, request.args);
      child.stdin.write(JSON.stringify({ id: request.id, ok: true, value }) + "\n");
    } catch (error) {
      child.stdin.write(
        JSON.stringify({
          id: request?.id,
          ok: false,
          error: serializeError(error),
        }) + "\n",
      );
    }
  })();
});

child.stdin.write(JSON.stringify({ code: input.code, docs: documentation }) + "\n");

const result = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
});
rpcLines.close();

if (result.signal) {
  console.error(`web code process terminated by ${result.signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.exitCode ?? 1;
}
