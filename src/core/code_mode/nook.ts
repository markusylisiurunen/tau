import { readFileSync } from "node:fs";
import { z } from "zod";
import type { TauCodeModeHandler } from "../../code_mode/runtime.js";
import type { Config } from "../config/index.js";
import { createNookClientFromConfig } from "../nook/client.js";
import {
  buildNookDeployManifestFromBackend,
  buildNookTemplateManifestFromBackend,
} from "../nook/deploy.js";
import { validateNookSiteSlug, validateNookTemplateName } from "../nook/validation.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import { formatZodError } from "../utils/zod.js";
import type { CodeModeCapability } from "./capability.js";

const MAX_KV_KEY_LENGTH = 256;
const MAX_KV_VALUE_BYTES = 64 * 1024;

const description = [
  "Publish static apps and artifacts, inspect hosted sites, and manage their JSON KV on Nook.",
  "Use tau.nook only when the user asks for deployment, hosting, or Nook management. Nook is the usual target for static mini-app publishing.",
].join(" ");

type NookClient = ReturnType<typeof createNookClientFromConfig>;

type NookToolDeps = {
  createClient(args: { config: Config; signal: AbortSignal }): NookClient;
};

const nonEmptyStringSchema = z.string().trim().min(1);
const directorySchema = nonEmptyStringSchema;
const fileSchema = nonEmptyStringSchema;
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

function parseMethodArguments<T>(method: string, args: unknown, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid tau.nook.${method} arguments: ${formatZodError(parsed.error)}`);
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

async function writeKvToFile(
  client: NookClient,
  backend: ToolExecutionBackend,
  site: string,
  key: string,
  file: string,
  signal: AbortSignal,
): Promise<unknown> {
  const value = await client.getKv(site, key);
  signal.throwIfAborted();
  const content = JSON.stringify(value);
  if (content === undefined) {
    throw new Error(`tau.nook.kv.getToFile received a non-JSON value for ${site}/${key}`);
  }
  const result = await backend.writeFile(file, content);
  signal.throwIfAborted();
  return { site, key, file: result.path, bytes: result.bytes };
}

async function readKvFromFile(
  client: NookClient,
  backend: ToolExecutionBackend,
  site: string,
  key: string,
  file: string,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const result = await backend.readFileBinary(file, { maxBytes: MAX_KV_VALUE_BYTES });
  signal.throwIfAborted();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.content));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in KV file '${file}': ${message}`);
  }
  const stored = await client.putKv(site, key, value);
  return { ...stored, file: result.path };
}

async function handleNookRequest(
  method: string,
  args: unknown[],
  deps: NookToolDeps,
  config: Config,
  backend: ToolExecutionBackend,
  signal: AbortSignal,
): Promise<unknown> {
  const createClient = (): NookClient => deps.createClient({ config, signal });

  switch (method) {
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
    case "kv.getToFile": {
      const [site, key, file] = parseMethodArguments(
        "kv.getToFile",
        args,
        z.tuple([siteSchema, keySchema, fileSchema]),
      );
      return writeKvToFile(createClient(), backend, site, key, file, signal);
    }
    case "kv.put": {
      const [site, key, value] = parseMethodArguments(
        "kv.put",
        args,
        z.tuple([siteSchema, keySchema, z.json()]),
      );
      return createClient().putKv(site, key, value);
    }
    case "kv.putFromFile": {
      const [site, key, file] = parseMethodArguments(
        "kv.putFromFile",
        args,
        z.tuple([siteSchema, keySchema, fileSchema]),
      );
      return readKvFromFile(createClient(), backend, site, key, file, signal);
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
      throw new Error(`unsupported nook method '${method}'`);
  }
}

const defaultDeps: NookToolDeps = { createClient: createNookClientFromConfig };

export function createNookCapability(
  backend: ToolExecutionBackend,
  config: Config,
  deps: NookToolDeps = defaultDeps,
): CodeModeCapability {
  if (!config.nook) throw new Error("nook is not configured");
  const method =
    (name: string): TauCodeModeHandler =>
    async (args, context) =>
      await handleNookRequest(name, args, deps, config, backend, context.signal);
  return {
    name: "nook",
    description,
    documentation,
    api: {
      skill: method("skill"),
      sites: {
        list: method("sites.list"),
        copy: method("sites.copy"),
        deploy: method("sites.deploy"),
        delete: method("sites.delete"),
      },
      templates: {
        list: method("templates.list"),
        copy: method("templates.copy"),
        save: method("templates.save"),
        delete: method("templates.delete"),
      },
      kv: {
        get: method("kv.get"),
        getToFile: method("kv.getToFile"),
        put: method("kv.put"),
        putFromFile: method("kv.putFromFile"),
        delete: method("kv.delete"),
        list: method("kv.list"),
      },
    },
  };
}
