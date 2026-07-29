import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import Exa from "exa-js";
import { discoverAgentContent } from "./discovery.mjs";

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

  const error = new Error(message.error?.message || "Web request failed");
  if (message.error?.name) error.name = message.error.name;
  if (message.error?.stack) error.stack = message.error.stack;
  request.reject(error);
});

function callWeb(method, args) {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    requests.write(JSON.stringify({ id, method, args }) + "\n");
  });
}

await initialized;

const web = Object.freeze({
  discover: (...args) => callWeb("discover", args),
  search: (...args) => callWeb("search", args),
  fetch: (...args) => callWeb("fetch", args),
});
const context = vm.createContext(
  {
    console,
    docs: initialization.docs,
    web,
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

const SEARCH_OPTION_KEYS = new Set([
  "numResults",
  "includeDomains",
  "excludeDomains",
  "startPublishedDate",
  "endPublishedDate",
  "category",
  "userLocation",
  "maxAgeHours",
]);
const FETCH_OPTION_KEYS = new Set([
  "mode",
  "query",
  "maxCharacters",
  "maxAgeHours",
  "subpages",
  "subpageTarget",
  "links",
]);
const SEARCH_CATEGORIES = new Set([
  "company",
  "people",
  "publication",
  "news",
  "personal site",
  "financial report",
]);

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

function parseOptions(value, allowedKeys, method) {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`web.${method} options must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`web.${method} does not support option '${key}'`);
    }
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalInteger(value, name, minimum, maximum) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum || (maximum !== undefined && value > maximum)) {
    const range = maximum === undefined ? `at least ${minimum}` : `between ${minimum} and ${maximum}`;
    throw new Error(`${name} must be an integer ${range}`);
  }
  return value;
}

function optionalStringArray(value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return value.map((entry, index) => requireString(entry, `${name}[${index}]`));
}

function normalizeSearchArguments(args) {
  if (!Array.isArray(args) || args.length < 1 || args.length > 2) {
    throw new Error("web.search expects query and optional options");
  }
  const query = requireString(args[0], "web.search query");
  const options = parseOptions(args[1], SEARCH_OPTION_KEYS, "search");
  const numResults = optionalInteger(options.numResults, "web.search numResults", 1, 100);
  const includeDomains = optionalStringArray(options.includeDomains, "web.search includeDomains");
  const excludeDomains = optionalStringArray(options.excludeDomains, "web.search excludeDomains");
  const startPublishedDate =
    options.startPublishedDate === undefined
      ? undefined
      : requireString(options.startPublishedDate, "web.search startPublishedDate");
  const endPublishedDate =
    options.endPublishedDate === undefined
      ? undefined
      : requireString(options.endPublishedDate, "web.search endPublishedDate");
  const category = options.category;
  if (category !== undefined && !SEARCH_CATEGORIES.has(category)) {
    throw new Error(`web.search category must be one of: ${[...SEARCH_CATEGORIES].join(", ")}`);
  }
  if (
    (category === "company" || category === "people") &&
    (excludeDomains || startPublishedDate || endPublishedDate)
  ) {
    throw new Error(
      `web.search category '${category}' does not support excludeDomains or publication-date filters`,
    );
  }
  let userLocation;
  if (options.userLocation !== undefined) {
    userLocation = requireString(options.userLocation, "web.search userLocation").toUpperCase();
    if (!/^[A-Z]{2}$/.test(userLocation)) {
      throw new Error("web.search userLocation must be a two-letter country code");
    }
  }
  const maxAgeHours = optionalInteger(options.maxAgeHours, "web.search maxAgeHours", -1);

  return [
    query,
    {
      type: "auto",
      ...(numResults !== undefined ? { numResults } : {}),
      ...(includeDomains ? { includeDomains } : {}),
      ...(excludeDomains ? { excludeDomains } : {}),
      ...(startPublishedDate ? { startPublishedDate } : {}),
      ...(endPublishedDate ? { endPublishedDate } : {}),
      ...(category ? { category } : {}),
      ...(userLocation ? { userLocation } : {}),
      contents: {
        highlights: true,
        ...(maxAgeHours !== undefined ? { maxAgeHours } : {}),
      },
    },
  ];
}

function normalizeFetchArguments(args) {
  if (!Array.isArray(args) || args.length < 1 || args.length > 2) {
    throw new Error("web.fetch expects urls and optional options");
  }
  const rawUrls = typeof args[0] === "string" ? [args[0]] : args[0];
  const urls = optionalStringArray(rawUrls, "web.fetch urls");
  if (!urls) throw new Error("web.fetch urls must be a non-empty string or string array");
  const options = parseOptions(args[1], FETCH_OPTION_KEYS, "fetch");
  const mode = options.mode ?? "highlights";
  if (mode !== "highlights" && mode !== "text") {
    throw new Error("web.fetch mode must be 'highlights' or 'text'");
  }
  const query =
    options.query === undefined ? undefined : requireString(options.query, "web.fetch query");
  if (mode === "text" && query !== undefined) {
    throw new Error("web.fetch query is only supported in highlights mode");
  }
  const maxCharacters = optionalInteger(
    options.maxCharacters,
    "web.fetch maxCharacters",
    1,
  );
  const maxAgeHours = optionalInteger(options.maxAgeHours, "web.fetch maxAgeHours", -1);
  const subpages = optionalInteger(options.subpages, "web.fetch subpages", 0);
  const subpageTarget =
    typeof options.subpageTarget === "string"
      ? requireString(options.subpageTarget, "web.fetch subpageTarget")
      : optionalStringArray(options.subpageTarget, "web.fetch subpageTarget");
  const links = optionalInteger(options.links, "web.fetch links", 0);

  const contentOptions =
    mode === "text"
      ? { text: maxCharacters === undefined ? true : { maxCharacters } }
      : {
          highlights:
            query === undefined && maxCharacters === undefined
              ? true
              : {
                  ...(query ? { query } : {}),
                  ...(maxCharacters !== undefined ? { maxCharacters } : {}),
                },
        };

  return [
    urls,
    {
      ...contentOptions,
      ...(maxAgeHours !== undefined ? { maxAgeHours } : {}),
      ...(subpages !== undefined ? { subpages } : {}),
      ...(subpageTarget ? { subpageTarget } : {}),
      ...(links !== undefined ? { extras: { links } } : {}),
    },
  ];
}

function normalizeStatus(status) {
  const normalized = {
    id: status?.id,
    status: status?.status,
  };
  if (status?.error) {
    normalized.error = {
      tag: status.error.tag,
      httpStatusCode: status.error.httpStatusCode,
    };
  }
  return normalized;
}

function normalizeResult(result) {
  const normalized = {
    title: result?.title,
    url: result?.url,
  };
  for (const key of ["publishedDate", "author", "text", "highlights"]) {
    if (result?.[key] !== undefined) normalized[key] = result[key];
  }
  if (Array.isArray(result?.subpages)) {
    normalized.subpages = result.subpages.map(normalizeResult);
  }
  if (Array.isArray(result?.extras?.links)) {
    normalized.links = result.extras.links;
  }
  return normalized;
}

function normalizeResponse(response) {
  return {
    results: Array.isArray(response?.results) ? response.results.map(normalizeResult) : [],
    statuses: Array.isArray(response?.statuses) ? response.statuses.map(normalizeStatus) : [],
  };
}

async function handleWebRequest(exa, request) {
  switch (request.method) {
    case "discover": {
      if (!Array.isArray(request.args) || request.args.length !== 1) {
        throw new Error("web.discover expects one URL");
      }
      return discoverAgentContent(request.args[0]);
    }
    case "search": {
      if (!exa) throw new Error("Missing Exa API key.");
      const args = normalizeSearchArguments(request.args);
      return normalizeResponse(await exa.search(...args));
    }
    case "fetch": {
      if (!exa) throw new Error("Missing Exa API key.");
      const args = normalizeFetchArguments(request.args);
      return normalizeResponse(await exa.getContents(...args));
    }
    default:
      throw new Error(`unsupported web method '${String(request.method)}'`);
  }
}

const input = JSON.parse(await readStdin());
const documentation = await readFile(new URL("./documentation.md", import.meta.url), "utf8");
const exa = input.apiKey ? new Exa(input.apiKey) : undefined;
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
  throw new Error("failed to create web API bridge");
}

const rpcLines = createInterface({ input: rpcOutput, crlfDelay: Infinity });
rpcLines.on("line", (line) => {
  void (async () => {
    let request;
    try {
      request = JSON.parse(line);
      const value = await handleWebRequest(exa, request);
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
