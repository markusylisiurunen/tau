import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import { createNookClientFromConfig } from "../nook/client.js";
import { buildNookDeployManifestFromBackend } from "../nook/deploy.js";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolSuccess } from "../utils/messages.js";
import { formatZodError } from "../utils/zod.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type {
  ToolDefinition,
  ToolDispatchContext,
  ToolDispatchResult,
  ToolUiEvent,
} from "./registry.js";
import { TOOL_NAME_NOOK } from "./tool_names.js";

const NOOK_DESCRIPTION = [
  "Operate the configured Nook static mini-app platform.",
  "All operations require read-write risk.",
  "Use read_skill to learn deployed platform constraints, deploy_site to publish a static directory, and KV operations for per-site JSON state.",
].join(" ");

export const NOOK_TOOL: Tool = {
  name: TOOL_NAME_NOOK,
  description: NOOK_DESCRIPTION,
  parameters: Type.Object(
    {
      operation: Type.String({
        enum: [
          "read_skill",
          "deploy_site",
          "list_sites",
          "delete_site",
          "get_kv",
          "put_kv",
          "delete_kv",
          "list_kv",
        ],
      }),
      site: Type.Optional(Type.String({ description: "Nook site slug." })),
      directory: Type.Optional(
        Type.String({ description: "Static directory to deploy from the session workspace." }),
      ),
      public: Type.Optional(
        Type.Boolean({ description: "Whether the deployed site should be public." }),
      ),
      key: Type.Optional(Type.String({ description: "KV key." })),
      value: Type.Optional(Type.Unknown({ description: "JSON-serializable KV value." })),
      prefix: Type.Optional(Type.String({ description: "KV key prefix filter." })),
    },
    { additionalProperties: false },
  ),
};

const nookArgsSchema = z
  .object({
    operation: z.enum([
      "read_skill",
      "deploy_site",
      "list_sites",
      "delete_site",
      "get_kv",
      "put_kv",
      "delete_kv",
      "list_kv",
    ]),
    site: z.string().trim().min(1).optional(),
    directory: z.string().trim().min(1).optional(),
    public: z.boolean().optional(),
    key: z.string().trim().min(1).optional(),
    value: z.unknown().optional(),
    prefix: z.string().optional(),
  })
  .strict();

type NookToolArgs = z.infer<typeof nookArgsSchema>;

function requireArg(args: NookToolArgs, key: "site" | "directory" | "key"): string {
  const value = args[key];
  if (!value) {
    throw new Error(`${args.operation} requires ${key}`);
  }
  return value;
}

function stringifyResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
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
    uiText: {
      previewLines: [{ text: message }],
      fullLines: [{ text: message }],
    },
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
              args.value,
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
          uiEvent: buildUiEvent(toolCall, "success", text.split("\n")[0] ?? "nook completed"),
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
