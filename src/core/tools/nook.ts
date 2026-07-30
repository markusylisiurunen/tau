import { readFileSync } from "node:fs";
import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { Config } from "../config/index.js";
import { createNookClientFromConfig } from "../nook/client.js";
import {
  buildNookDeployManifestFromBackend,
  buildNookTemplateManifestFromBackend,
} from "../nook/deploy.js";
import { validateNookSiteSlug, validateNookTemplateName } from "../nook/validation.js";
import { formatZodError } from "../utils/zod.js";
import {
  type CodeModeToolImplementation,
  createCodeModeToolDefinition,
  type ParsedCodeModeArguments,
} from "./code_mode.js";
import { type CodeModeBridgeRequest, executeCodeModeWorker } from "./code_mode_worker.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type { ToolDefinition } from "./registry.js";
import { TOOL_NAME_NOOK } from "./tool_names.js";

const NOOK_CODE_MODE_TIMEOUT_MS = 60_000;
const NOOK_CODE_MODE_OUTPUT_TOKENS = 8_192;
const MAX_KV_KEY_LENGTH = 256;

const NOOK_DESCRIPTION = [
  "Run a one-shot JavaScript program to operate the configured Nook platform: Tau's Cloudflare-backed static mini-app host for publishing built front-end artifacts with optional per-site same-origin JSON KV.",
  "Do not use this tool autonomously; use it only when the user asks to manage Nook, deploy/publish/host an app or artifact, inspect Nook state, or manage Nook KV.",
  "If the user asks to deploy a static artifact or mini-app, this is usually the right deployment target.",
  "Top-level await is supported. The program receives nook, docs, and console globals.",
  "Only text written through console methods is returned; program return values are ignored.",
  "To discover the available Nook APIs, run a program that prints docs with console.log(docs), then use that documentation in the next turn.",
  "The static docs describe the agent-facing SDK. When app-authoring guidance or the browser/KV contract is needed, print await nook.skill() in a separate reconnaissance call before authoring the app.",
  "When preparing site files for deployment, write the complete site directory under a fresh mktemp directory and deploy that directory; do not scatter generated site files into the project tree.",
  "Sites and templates can be copied to an existing empty destination directory. Edit/build copied files normally, then deploy a built static directory separately.",
].join(" ");

export const NOOK_TOOL: Tool = {
  name: TOOL_NAME_NOOK,
  description: NOOK_DESCRIPTION,
  parameters: Type.Object(
    {
      code: Type.String({
        description: "JavaScript source to execute. Use console output to return information.",
      }),
    },
    { additionalProperties: false },
  ),
};

const nookArgsSchema = z
  .object({
    code: z.string().trim().min(1),
  })
  .strict();

type NookArgs = z.infer<typeof nookArgsSchema>;

type NookClient = ReturnType<typeof createNookClientFromConfig>;

type NookToolDeps = {
  createClient(args: { config: Config; signal: AbortSignal }): NookClient;
  timeoutMs?: number;
};

const nonEmptyStringSchema = z.string().trim().min(1);
const directorySchema = nonEmptyStringSchema;
const keySchema = z.string().min(1).max(MAX_KV_KEY_LENGTH);
const visibilityOptionsSchema = z
  .object({
    visibility: z.enum(["private", "public"]),
  })
  .strict();
const kvListOptionsSchema = z
  .object({
    prefix: z.string().optional(),
  })
  .strict();

function validatedPathLabel(
  validate: (value: string) => { ok: true } | { ok: false; message: string },
): z.ZodType<string> {
  return nonEmptyStringSchema.superRefine((value, context) => {
    const result = validate(value);
    if (!result.ok) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: result.message });
    }
  });
}

const siteSchema = validatedPathLabel(validateNookSiteSlug);
const templateSchema = validatedPathLabel(validateNookTemplateName);

const documentation = readFileSync(
  new URL("../static/code_mode/nook/documentation.md", import.meta.url),
  "utf8",
);
const sandboxRunnerUrl = new URL("../static/code_mode/nook/sandbox_runner.mjs", import.meta.url);

function parseNookArguments(raw: unknown): ParsedCodeModeArguments<NookArgs> {
  const rawCode =
    typeof raw === "object" && raw !== null && typeof (raw as { code?: unknown }).code === "string"
      ? (raw as { code: string }).code
      : "";
  const displayTarget =
    rawCode
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "(invalid code)";
  const parsed = nookArgsSchema.safeParse(raw);
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

function parseBridgeArguments(request: CodeModeBridgeRequest): unknown {
  try {
    return JSON.parse(request.argsJson);
  } catch {
    throw new Error("invalid nook bridge arguments");
  }
}

function parseMethodArguments<T>(method: string, args: unknown, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid nook.${method} arguments: ${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

function joinBackendPath(dir: string, relativePath: string): string {
  const trimmedDir = dir.replace(/\/+$/, "");
  const trimmedPath = relativePath.replace(/^\/+/, "");
  return trimmedDir ? `${trimmedDir}/${trimmedPath}` : trimmedPath;
}

async function requireEmptyDirectory(
  backend: ToolExecutionBackend,
  directory: string,
  artifact: "site" | "template",
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const destination = await backend.listDir(directory);
  signal.throwIfAborted();
  if (destination.entries.length > 0) {
    throw new Error(`${artifact} copy destination is not empty: ${directory}`);
  }
}

async function copySite(
  client: NookClient,
  backend: ToolExecutionBackend,
  site: string,
  directory: string,
  signal: AbortSignal,
): Promise<unknown> {
  await requireEmptyDirectory(backend, directory, "site", signal);
  const manifest = await client.getSiteManifest(site);
  signal.throwIfAborted();
  const files = await client.downloadSiteFiles(site, manifest);
  signal.throwIfAborted();
  for (const file of files) {
    signal.throwIfAborted();
    await backend.writeFileBinary(joinBackendPath(directory, file.path), file.content);
    signal.throwIfAborted();
  }
  return {
    site,
    directory,
    deploymentId: manifest.deploymentId,
    visibility: manifest.visibility,
    fileCount: files.length,
    byteCount: files.reduce((total, file) => total + file.sizeBytes, 0),
  };
}

async function copyTemplate(
  client: NookClient,
  backend: ToolExecutionBackend,
  template: string,
  directory: string,
  signal: AbortSignal,
): Promise<unknown> {
  await requireEmptyDirectory(backend, directory, "template", signal);
  const manifest = await client.getTemplateManifest(template);
  signal.throwIfAborted();
  const files = await client.downloadTemplateFiles(template, manifest);
  signal.throwIfAborted();
  for (const file of files) {
    signal.throwIfAborted();
    await backend.writeFileBinary(joinBackendPath(directory, file.path), file.content);
    signal.throwIfAborted();
  }
  return { ...manifest.template, directory };
}

async function handleNookRequest(
  request: CodeModeBridgeRequest,
  deps: NookToolDeps,
  config: Config,
  backend: ToolExecutionBackend,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseBridgeArguments(request);
  const createClient = (): NookClient => deps.createClient({ config, signal });

  switch (request.method) {
    case "skill": {
      parseMethodArguments("skill", args, z.tuple([]));
      return createClient().readSkill();
    }
    case "sites.list": {
      parseMethodArguments("sites.list", args, z.tuple([]));
      return createClient().listSites();
    }
    case "sites.copy": {
      const [site, directory] = parseMethodArguments(
        "sites.copy",
        args,
        z.tuple([siteSchema, directorySchema]),
      );
      return copySite(createClient(), backend, site, directory, signal);
    }
    case "sites.deploy": {
      const [site, directory, options] = parseMethodArguments(
        "sites.deploy",
        args,
        z.tuple([siteSchema, directorySchema, visibilityOptionsSchema]),
      );
      const files = await buildNookDeployManifestFromBackend(backend, directory, signal);
      signal.throwIfAborted();
      return createClient().deploySite({ site, files, visibility: options.visibility });
    }
    case "sites.delete": {
      const [site] = parseMethodArguments("sites.delete", args, z.tuple([siteSchema]));
      return createClient().deleteSite(site);
    }
    case "templates.list": {
      parseMethodArguments("templates.list", args, z.tuple([]));
      return createClient().listTemplates();
    }
    case "templates.copy": {
      const [template, directory] = parseMethodArguments(
        "templates.copy",
        args,
        z.tuple([templateSchema, directorySchema]),
      );
      return copyTemplate(createClient(), backend, template, directory, signal);
    }
    case "templates.save": {
      const [template, directory] = parseMethodArguments(
        "templates.save",
        args,
        z.tuple([templateSchema, directorySchema]),
      );
      const files = await buildNookTemplateManifestFromBackend(backend, directory, signal);
      signal.throwIfAborted();
      return createClient().saveTemplate({ name: template, files });
    }
    case "templates.delete": {
      const [template] = parseMethodArguments("templates.delete", args, z.tuple([templateSchema]));
      return createClient().deleteTemplate(template);
    }
    case "kv.get": {
      const [site, key] = parseMethodArguments("kv.get", args, z.tuple([siteSchema, keySchema]));
      return createClient().getKv(site, key);
    }
    case "kv.put": {
      const [site, key, value] = parseMethodArguments(
        "kv.put",
        args,
        z.tuple([siteSchema, keySchema, z.json()]),
      );
      return createClient().putKv(site, key, value);
    }
    case "kv.delete": {
      const [site, key] = parseMethodArguments("kv.delete", args, z.tuple([siteSchema, keySchema]));
      return createClient().deleteKv(site, key);
    }
    case "kv.list": {
      const [site, options] = parseMethodArguments(
        "kv.list",
        args,
        z.union([
          z.tuple([siteSchema]).transform(([site]): [string, { prefix?: string }] => [site, {}]),
          z.tuple([siteSchema, kvListOptionsSchema]),
        ]),
      );
      const result = await createClient().listKv(site, options.prefix);
      return result.keys;
    }
    default:
      throw new Error(`unsupported nook method '${request.method}'`);
  }
}

function executeNookProgram(
  code: string,
  deps: NookToolDeps,
  config: Config,
  backend: ToolExecutionBackend,
  signal: AbortSignal,
  timeoutMs: number,
) {
  return executeCodeModeWorker({
    sandboxRunnerUrl,
    workerData: { code, docs: documentation },
    signal,
    timeoutMs,
    handleRequest: (request, requestSignal) =>
      handleNookRequest(request, deps, config, backend, requestSignal),
  });
}

const defaultDeps: NookToolDeps = {
  createClient: createNookClientFromConfig,
};

export function createNookToolDefinition(
  backend: ToolExecutionBackend,
  deps: NookToolDeps = defaultDeps,
): ToolDefinition {
  const timeoutMs = deps.timeoutMs ?? NOOK_CODE_MODE_TIMEOUT_MS;
  const implementation: CodeModeToolImplementation<NookArgs> = {
    schema: NOOK_TOOL,
    outputPolicy: { maxTokens: NOOK_CODE_MODE_OUTPUT_TOKENS },
    timeoutMs,
    parseArguments: parseNookArguments,
    execute: async ({ code, context, signal, backend: executionBackend }) =>
      executeNookProgram(code, deps, context.config, executionBackend, signal, timeoutMs),
  };

  return createCodeModeToolDefinition(backend, implementation);
}
