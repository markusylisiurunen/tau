import { readFileSync } from "node:fs";
import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { McpManager } from "../mcp/manager.js";
import { searchMcpTools } from "../mcp/search.js";
import { formatZodError } from "../utils/zod.js";
import {
  buildCodeModeToolDescription,
  createCodeModeToolDefinition,
  executeInternalCodeMode,
} from "./code_mode.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type { AgentTool } from "./registry.js";
import { TOOL_NAME_MCP } from "./tool_names.js";

export const MCP_TOOL: Tool = {
  name: TOOL_NAME_MCP,
  description: buildCodeModeToolDescription({
    sdkGlobal: "mcp",
    introduction: [
      "Run a one-shot JavaScript program to discover and call tools and read resources offered by configured MCP servers.",
      "Use this for connected services relevant to the user's task.",
      "Read a tool's description and input schema before calling it; do not guess names or arguments.",
      "Tool calls can have side effects and are not undone if the program fails or is interrupted.",
    ],
  }),
  parameters: Type.Object(
    {
      code: Type.String({
        description:
          "JavaScript source to execute. Use console output for text and await image(block) to return images.",
      }),
    },
    { additionalProperties: false },
  ),
};

const argsSchema = z.object({ code: z.string().trim().min(1) }).strict();
const nameSchema = z.string().trim().min(1).max(256);
const listOptionsSchema = z
  .object({
    query: z.string().trim().min(1).max(1_000).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().nonnegative().default(0),
  })
  .strict();
const documentation = readFileSync(
  new URL("../static/code_mode/mcp/documentation.md", import.meta.url),
  "utf8",
);

function parseMethodArgs<T>(method: string, args: unknown[], schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success)
    throw new Error(`Invalid mcp.${method} arguments: ${formatZodError(parsed.error)}`);
  return parsed.data;
}

export function createMcpToolDefinition(
  backend: ToolExecutionBackend,
  manager: McpManager,
): AgentTool {
  return createCodeModeToolDefinition(backend, {
    schema: MCP_TOOL,
    timeoutMs: 900_000,
    parseArguments(raw) {
      const code =
        typeof raw === "object" &&
        raw !== null &&
        typeof (raw as { code?: unknown }).code === "string"
          ? (raw as { code: string }).code
          : "";
      const subject =
        code
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) ?? "(invalid code)";
      const parsed = argsSchema.safeParse(raw);
      return parsed.success
        ? { ok: true, args: parsed.data, code: parsed.data.code, subject }
        : { ok: false, error: formatZodError(parsed.error), code, subject };
    },
    execute: async ({ code, agentId, signal }) =>
      await executeInternalCodeMode({
        name: "mcp",
        documentation,
        code,
        agentId,
        backend,
        signal,
        timeoutMs: 900_000,
        api: {
          listServers: async (args) => {
            parseMethodArgs("listServers", args, z.tuple([]));
            return manager.listServers();
          },
          searchTools: async (args, context) => {
            const [query, options] = parseMethodArgs(
              "searchTools",
              args,
              z.tuple([
                z.string().trim().min(1).max(1_000),
                z
                  .object({
                    server: nameSchema.optional(),
                    limit: z.number().int().min(1).max(100).default(8),
                  })
                  .strict()
                  .optional(),
              ]),
            );
            return await searchMcpTools(manager, query, options ?? { limit: 8 }, context.signal);
          },
          listTools: async (args, context) => {
            const [server, options] = parseMethodArgs(
              "listTools",
              args,
              z.tuple([nameSchema, listOptionsSchema.optional()]),
            );
            const { query, limit, offset } = options ?? listOptionsSchema.parse({});
            const catalog = await manager.listTools(server, context.signal);
            const terms = query?.toLowerCase().split(/\s+/) ?? [];
            const matching = catalog.tools.filter((tool) => {
              const text = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
              return terms.every((term) => text.includes(term));
            });
            const tools = matching.slice(offset, offset + limit).map((tool) => ({
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
            }));
            return {
              ...(catalog.instructions ? { instructions: catalog.instructions } : {}),
              tools,
              total: matching.length,
              ...(offset + tools.length < matching.length
                ? { nextOffset: offset + tools.length }
                : {}),
            };
          },
          listResources: async (args, context) => {
            const [server, options] = parseMethodArgs(
              "listResources",
              args,
              z.tuple([nameSchema, listOptionsSchema.optional()]),
            );
            const { query, limit, offset } = options ?? listOptionsSchema.parse({});
            const catalog = await manager.listResources(server, context.signal);
            const terms = query?.toLowerCase().split(/\s+/) ?? [];
            const matching = catalog.filter((resource) => {
              const text =
                `${resource.uri} ${resource.name} ${resource.title ?? ""} ${resource.description ?? ""}`.toLowerCase();
              return terms.every((term) => text.includes(term));
            });
            const resources = matching.slice(offset, offset + limit);
            return {
              resources,
              total: matching.length,
              ...(offset + resources.length < matching.length
                ? { nextOffset: offset + resources.length }
                : {}),
            };
          },
          listResourceTemplates: async (args, context) => {
            const [server, options] = parseMethodArgs(
              "listResourceTemplates",
              args,
              z.tuple([nameSchema, listOptionsSchema.optional()]),
            );
            const { query, limit, offset } = options ?? listOptionsSchema.parse({});
            const catalog = await manager.listResourceTemplates(server, context.signal);
            const terms = query?.toLowerCase().split(/\s+/) ?? [];
            const matching = catalog.filter((resource) => {
              const text =
                `${resource.uriTemplate} ${resource.name} ${resource.title ?? ""} ${resource.description ?? ""}`.toLowerCase();
              return terms.every((term) => text.includes(term));
            });
            const resourceTemplates = matching.slice(offset, offset + limit);
            return {
              resourceTemplates,
              total: matching.length,
              ...(offset + resourceTemplates.length < matching.length
                ? { nextOffset: offset + resourceTemplates.length }
                : {}),
            };
          },
          readResource: async (args, context) => {
            const [server, uri] = parseMethodArgs(
              "readResource",
              args,
              z.tuple([nameSchema, z.string().trim().min(1).max(8_192)]),
            );
            return await manager.readResource(server, uri, context.signal);
          },
          describeTool: async (args, context) => {
            const [server, name] = parseMethodArgs(
              "describeTool",
              args,
              z.tuple([nameSchema, nameSchema]),
            );
            const tool = await manager.describeTool(server, name, context.signal);
            return {
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              inputSchema: tool.inputSchema,
              ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
              ...(tool.annotations ? { annotations: tool.annotations } : {}),
            };
          },
          callTool: async (args, context) => {
            const [server, name, input] = parseMethodArgs(
              "callTool",
              args,
              z.tuple([nameSchema, nameSchema, z.record(z.string(), z.unknown())]),
            );
            return await manager.callTool(server, name, input, context.signal);
          },
        },
      }),
  });
}
