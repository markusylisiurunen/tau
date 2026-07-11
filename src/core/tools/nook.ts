import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import { createNookClientFromConfig } from "../nook/client.js";
import {
  buildNookDeployManifestFromBackend,
  buildNookTemplateManifestFromBackend,
} from "../nook/deploy.js";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolSuccess } from "../utils/messages.js";
import { buildHeadTailPreviewLines } from "../utils/tool_preview.js";
import { formatZodError } from "../utils/zod.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type {
  ToolDefinition,
  ToolDispatchContext,
  ToolDispatchResult,
  ToolUiEvent,
  ToolUiLine,
  ToolUiText,
} from "./registry.js";
import { TOOL_NAME_NOOK } from "./tool_names.js";

const NOOK_DESCRIPTION = [
  "Operate the configured Nook platform: Tau's Cloudflare-backed static mini-app host for publishing built front-end artifacts to https://<nook-domain>/<site>/ with optional per-site same-origin JSON KV.",
  "Do not use this tool autonomously; use it only when the user asks to manage Nook, deploy/publish/host an app or artifact, inspect Nook state, or manage Nook KV.",
  "If the user asks to deploy a static artifact or mini-app, this is usually the right deployment target.",
  "When preparing site files for deployment, write the complete site directory under a fresh mktemp directory and deploy that directory; do not scatter generated site files into the project tree.",
  "Sites and templates can be copied to an existing empty destination directory. Edit/build copied files normally, then deploy a built static directory separately.",
  "All operations require read-write risk.",
  "Input keys by operation: read_skill, list_sites, and list_templates need only operation; deploy_site and copy_site need site and directory, with public optional only for deploy_site; delete_site needs site; template copy/save/delete operations need template, and copy/save also need directory; get_kv and delete_kv need site and key; put_kv needs site, key, and value; list_kv needs site, with prefix optional.",
].join(" ");

export const NOOK_TOOL: Tool = {
  name: TOOL_NAME_NOOK,
  description: NOOK_DESCRIPTION,
  parameters: Type.Object(
    {
      operation: Type.String({
        description:
          "Operation to run. Required keys: read_skill/list_sites/list_templates only operation; deploy_site/copy_site site+directory; delete_site site; copy_template/save_template template+directory; delete_template template; get_kv/delete_kv site+key; put_kv site+key+value; list_kv site.",
        enum: [
          "read_skill",
          "deploy_site",
          "copy_site",
          "list_sites",
          "delete_site",
          "list_templates",
          "copy_template",
          "save_template",
          "delete_template",
          "get_kv",
          "put_kv",
          "delete_kv",
          "list_kv",
        ],
      }),
      site: Type.Optional(
        Type.String({
          description:
            "Nook site slug. Required for deploy_site, copy_site, delete_site, get_kv, put_kv, delete_kv, and list_kv.",
        }),
      ),
      directory: Type.Optional(
        Type.String({
          description:
            "Directory in the session workspace. Required for deploy_site, copy_site, copy_template, and save_template. Copy operations require the directory to exist and be empty.",
        }),
      ),
      public: Type.Optional(
        Type.Boolean({
          description: "Whether deploy_site should make the active deployment public.",
        }),
      ),
      template: Type.Optional(
        Type.String({
          description:
            "Template name. Required for copy_template, save_template, and delete_template.",
        }),
      ),
      key: Type.Optional(
        Type.String({ description: "KV key. Required for get_kv, put_kv, and delete_kv." }),
      ),
      value: Type.Optional(
        Type.Unknown({ description: "JSON-serializable KV value. Required for put_kv." }),
      ),
      prefix: Type.Optional(
        Type.String({ description: "Optional KV key prefix filter for list_kv." }),
      ),
    },
    { additionalProperties: false },
  ),
};

const nookArgsSchema = z
  .object({
    operation: z.enum([
      "read_skill",
      "deploy_site",
      "copy_site",
      "list_sites",
      "delete_site",
      "list_templates",
      "copy_template",
      "save_template",
      "delete_template",
      "get_kv",
      "put_kv",
      "delete_kv",
      "list_kv",
    ]),
    site: z.string().trim().min(1).optional(),
    template: z.string().trim().min(1).optional(),
    directory: z.string().trim().min(1).optional(),
    public: z.boolean().optional(),
    key: z.string().trim().min(1).optional(),
    value: z.unknown().optional(),
    prefix: z.string().optional(),
  })
  .strict();

type NookToolArgs = z.infer<typeof nookArgsSchema>;

const NOOK_UI_PREVIEW_HEAD_LINES = 3;
const NOOK_UI_PREVIEW_TAIL_LINES = 3;

function requireArg(args: NookToolArgs, key: "site" | "template" | "directory" | "key"): string {
  const value = args[key];
  if (!value) {
    throw new Error(`${args.operation} requires ${key}`);
  }
  return value;
}

function requireValue(args: NookToolArgs): unknown {
  if (args.value === undefined) {
    throw new Error(`${args.operation} requires value`);
  }
  return args.value;
}

function stringifyResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function joinBackendPath(dir: string, relativePath: string): string {
  const trimmedDir = dir.replace(/\/+$/, "");
  const trimmedPath = relativePath.replace(/^\/+/, "");
  return trimmedDir ? `${trimmedDir}/${trimmedPath}` : trimmedPath;
}

function buildNookUiText(message: string): ToolUiText {
  const trimmed = message.trimEnd();
  const fallback = trimmed || "nook completed";
  const previewLines = buildHeadTailPreviewLines(fallback, {
    headLines: NOOK_UI_PREVIEW_HEAD_LINES,
    tailLines: NOOK_UI_PREVIEW_TAIL_LINES,
  }).map((text): ToolUiLine => ({ text }));
  const fullLines = fallback.split("\n").map((text): ToolUiLine => ({ text }));

  return { previewLines, fullLines };
}

function buildUiEvent(
  toolCall: ToolCall,
  status: "success" | "error",
  message: string,
): ToolUiEvent {
  return {
    type: "client_tool_finished",
    toolCallId: toolCall.id,
    toolName: TOOL_NAME_NOOK,
    headerTarget: TOOL_NAME_NOOK,
    status,
    uiText: buildNookUiText(message),
  };
}

export function createNookToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
  return {
    schema: NOOK_TOOL,
    async dispatch(
      toolCall: ToolCall,
      riskLevel: RiskLevel,
      _signal: AbortSignal,
      context: ToolDispatchContext,
    ): Promise<ToolDispatchResult> {
      const parsed = nookArgsSchema.safeParse(toolCall.arguments);
      if (!parsed.success) {
        const message = `Invalid arguments: ${formatZodError(parsed.error)}`;
        return {
          kind: "single",
          toolResult: createToolError(toolCall, message),
          uiEvent: buildUiEvent(toolCall, "error", message),
        };
      }

      if (riskLevel !== "read-write") {
        const message = `Requires risk level 'read-write', but the current level is '${riskLevel}'. Ask the user to run /risk:read-write.`;
        return {
          kind: "single",
          toolResult: createToolError(toolCall, message),
          uiEvent: buildUiEvent(toolCall, "error", message),
        };
      }

      try {
        const args = parsed.data;
        const client = createNookClientFromConfig({ config: context.config });
        let result: unknown;

        switch (args.operation) {
          case "read_skill":
            result = await client.readSkill();
            break;
          case "list_sites":
            result = { sites: await client.listSites() };
            break;
          case "delete_site":
            result = await client.deleteSite(requireArg(args, "site"));
            break;
          case "copy_site": {
            const site = requireArg(args, "site");
            const directory = requireArg(args, "directory");
            const destination = await backend.listDir(directory);
            if (destination.entries.length > 0) {
              throw new Error(`site copy destination is not empty: ${directory}`);
            }
            const manifest = await client.getSiteManifest(site);
            const files = await client.downloadSiteFiles(site, manifest);
            for (const file of files) {
              await backend.writeFileBinary(joinBackendPath(directory, file.path), file.content);
            }
            result = {
              site,
              directory,
              deploymentId: manifest.deploymentId,
              fileCount: files.length,
              byteCount: files.reduce((total, file) => total + file.sizeBytes, 0),
            };
            break;
          }
          case "list_templates":
            result = { templates: await client.listTemplates() };
            break;
          case "copy_template": {
            const template = requireArg(args, "template");
            const directory = requireArg(args, "directory");
            const destination = await backend.listDir(directory);
            if (destination.entries.length > 0) {
              throw new Error(`template copy destination is not empty: ${directory}`);
            }
            const manifest = await client.getTemplateManifest(template);
            const files = await client.downloadTemplateFiles(template, manifest);
            for (const file of files) {
              await backend.writeFileBinary(joinBackendPath(directory, file.path), file.content);
            }
            result = {
              template,
              directory,
              fileCount: files.length,
              byteCount: files.reduce((total, file) => total + file.sizeBytes, 0),
            };
            break;
          }
          case "save_template": {
            const files = await buildNookTemplateManifestFromBackend(
              backend,
              requireArg(args, "directory"),
            );
            result = await client.saveTemplate({
              name: requireArg(args, "template"),
              files,
            });
            break;
          }
          case "delete_template":
            result = await client.deleteTemplate(requireArg(args, "template"));
            break;
          case "deploy_site": {
            const directory = requireArg(args, "directory");
            const files = await buildNookDeployManifestFromBackend(backend, directory);
            result = await client.deploySite({
              site: requireArg(args, "site"),
              files,
              visibility: args.public ? "public" : "private",
            });
            break;
          }
          case "get_kv":
            result = {
              site: requireArg(args, "site"),
              key: requireArg(args, "key"),
              value: await client.getKv(requireArg(args, "site"), requireArg(args, "key")),
            };
            break;
          case "put_kv":
            result = await client.putKv(
              requireArg(args, "site"),
              requireArg(args, "key"),
              requireValue(args),
            );
            break;
          case "delete_kv":
            result = await client.deleteKv(requireArg(args, "site"), requireArg(args, "key"));
            break;
          case "list_kv":
            result = await client.listKv(requireArg(args, "site"), args.prefix);
            break;
        }

        const text = typeof result === "string" ? result : stringifyResult(result);
        return {
          kind: "single",
          toolResult: createToolSuccess(toolCall, text),
          uiEvent: buildUiEvent(toolCall, "success", text),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          kind: "single",
          toolResult: createToolError(toolCall, message),
          uiEvent: buildUiEvent(toolCall, "error", message),
        };
      }
    },
  };
}
