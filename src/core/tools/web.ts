import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import { getExaApiKey } from "../config/index.js";
import { formatZodError } from "../utils/zod.js";
import {
  type CodeModeToolImplementation,
  createCodeModeToolDefinition,
  type ParsedCodeModeArguments,
} from "./code_mode.js";
import type { BashExecutionResult, ToolExecutionBackend } from "./execution_backend.js";
import type { ToolDefinition, ToolDispatchContext } from "./registry.js";
import { TOOL_NAME_WEB } from "./tool_names.js";

const WEB_CODE_MODE_TIMEOUT_MS = 60_000;
const WEB_CODE_MODE_PREPARE_TIMEOUT_MS = 5 * 60_000;
const WEB_CODE_MODE_OUTPUT_TOKENS = 16_384;

const WEB_DESCRIPTION = [
  "Run a one-shot JavaScript program to search the web and retrieve page content.",
  "Use this tool only when the user asks to browse or search the web, provides a URL, or otherwise clearly implies that web access is needed.",
  "Top-level await is supported. The program receives exa, docs, and console globals.",
  "Only text written through console methods is returned; program return values are ignored.",
  "Format results as concise, readable plain text instead of dumping raw JSON. Select only relevant fields when possible. When all fields are needed, still flatten and label them compactly rather than serializing the response object. Emit JSON only when the user explicitly requests JSON or another machine-readable result.",
  "To discover the available web APIs, run a program that prints docs with console.log(docs), then use that documentation in the next turn.",
].join(" ");

export const WEB_TOOL: Tool = {
  name: TOOL_NAME_WEB,
  description: WEB_DESCRIPTION,
  parameters: Type.Object(
    {
      code: Type.String({
        description: "JavaScript source to execute. Use console output to return information.",
      }),
    },
    { additionalProperties: false },
  ),
};

const webArgsSchema = z
  .object({
    code: z.string().trim().min(1),
  })
  .strict();

type WebArgs = z.infer<typeof webArgsSchema>;

type WebRuntime = {
  runnerPath: string;
};

type WebRuntimeAsset = {
  path: string;
  content: string;
};

function readRuntimeAsset(path: string): string {
  return readFileSync(new URL(`../static/code_mode/web/${path}`, import.meta.url), "utf8");
}

const WEB_RUNTIME_ASSETS: WebRuntimeAsset[] = [
  { path: "package.json", content: readRuntimeAsset("package.json") },
  { path: "package-lock.json", content: readRuntimeAsset("package-lock.json") },
  { path: "runner.mjs", content: readRuntimeAsset("runner.mjs") },
  { path: "documentation.md", content: readRuntimeAsset("documentation.md") },
];

const WEB_RUNTIME_HASH = createHash("sha256")
  .update(
    WEB_RUNTIME_ASSETS.map(
      (asset) => `${asset.path}\0${asset.content.length}\0${asset.content}`,
    ).join("\0"),
  )
  .digest("hex");

const PREPARE_WEB_RUNTIME_SCRIPT = String.raw`
(() => {
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const home = process.env.HOME;
if (!home) throw new Error("execution environment HOME is not set");

const parent = join(home, ".cache", "tau", "code-mode", input.name);
const runtime = join(parent, input.hash);
const ready = join(runtime, ".ready");
const runnerPath = join(runtime, "runner.mjs");
if (existsSync(ready)) {
  process.stdout.write(JSON.stringify({ runnerPath }));
  return;
}

mkdirSync(parent, { recursive: true });
const temporary = join(parent, "." + input.hash + ".tmp-" + process.pid + "-" + randomUUID());
mkdirSync(temporary, { recursive: true });
try {
  for (const asset of input.assets) {
    writeFileSync(join(temporary, asset.path), asset.content, "utf8");
  }
  const install = spawnSync(
    "npm",
    ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"],
    {
      cwd: temporary,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (install.error) throw install.error;
  if (install.status !== 0) {
    const detail = (install.stderr || install.stdout || "npm ci failed").trim();
    throw new Error(detail);
  }
  writeFileSync(join(temporary, ".ready"), input.hash + "\n", "utf8");
  try {
    renameSync(temporary, runtime);
  } catch (error) {
    if (!existsSync(ready)) throw error;
    rmSync(temporary, { recursive: true, force: true });
  }
} catch (error) {
  rmSync(temporary, { recursive: true, force: true });
  throw error;
}

process.stdout.write(JSON.stringify({ runnerPath }));
})();
`.trim();

function parseWebArguments(raw: unknown): ParsedCodeModeArguments<WebArgs> {
  const rawCode =
    typeof raw === "object" && raw !== null && typeof (raw as { code?: unknown }).code === "string"
      ? (raw as { code: string }).code
      : "";
  const displayTarget =
    rawCode
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "(invalid code)";
  const parsed = webArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: formatZodError(parsed.error),
      code: rawCode,
      displayTarget,
    };
  }
  return {
    ok: true,
    args: parsed.data,
    code: parsed.data.code,
    displayTarget,
  };
}

async function prepareWebRuntime(backend: ToolExecutionBackend): Promise<WebRuntime> {
  const result = await backend.runNodeScript(PREPARE_WEB_RUNTIME_SCRIPT, [], {
    timeoutMs: WEB_CODE_MODE_PREPARE_TIMEOUT_MS,
    stdin: Buffer.from(
      JSON.stringify({
        name: "web",
        hash: WEB_RUNTIME_HASH,
        assets: WEB_RUNTIME_ASSETS,
      }),
      "utf8",
    ),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to prepare web code runtime: ${result.output.trim() || "unknown error"}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Failed to prepare web code runtime: invalid preparation result");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { runnerPath?: unknown }).runnerPath !== "string" ||
    !(parsed as { runnerPath: string }).runnerPath.trim()
  ) {
    throw new Error("Failed to prepare web code runtime: runner path is missing");
  }
  return { runnerPath: (parsed as { runnerPath: string }).runnerPath };
}

function executeWebProgram(
  backend: ToolExecutionBackend,
  runtime: WebRuntime,
  code: string,
  apiKey: string,
  context: ToolDispatchContext,
  signal: AbortSignal,
): Promise<BashExecutionResult> {
  return backend.runBash('exec "$0" "$@"', {
    args: ["node", runtime.runnerPath],
    cwd: context.cwd,
    signal,
    timeoutMs: WEB_CODE_MODE_TIMEOUT_MS,
    stdin: Buffer.from(
      JSON.stringify({
        apiKey,
        code,
        cwd: context.cwd,
      }),
      "utf8",
    ),
  });
}

export function createWebToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
  let preparedRuntime: Promise<WebRuntime> | undefined;

  const implementation: CodeModeToolImplementation<WebArgs, WebRuntime> = {
    schema: WEB_TOOL,
    label: "web",
    outputPolicy: { maxTokens: WEB_CODE_MODE_OUTPUT_TOKENS },
    parseArguments: parseWebArguments,
    prepare: async ({ context }) => {
      if (!getExaApiKey(context.config)) {
        throw new Error("Missing Exa API key.");
      }
      if (!preparedRuntime) {
        preparedRuntime = prepareWebRuntime(backend).catch((error) => {
          preparedRuntime = undefined;
          throw error;
        });
      }
      return preparedRuntime;
    },
    execute: async ({ code, runtime, context, signal }) => {
      const apiKey = getExaApiKey(context.config);
      if (!apiKey) {
        throw new Error("Missing Exa API key.");
      }
      return executeWebProgram(backend, runtime, code, apiKey, context, signal);
    },
  };

  return createCodeModeToolDefinition(backend, implementation);
}
