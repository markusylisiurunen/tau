import { resolve } from "node:path";
import { z } from "zod";
import type { ConfigLevel } from "./paths.js";

const stringMap = z.record(z.string().min(1), z.string());
const common = {
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
};

const serverSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...common,
      type: z.literal("stdio"),
      command: z.string().trim().min(1),
      args: z.array(z.string()).optional(),
      cwd: z.string().trim().min(1).optional(),
      env: stringMap.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("http"),
      url: z.url().refine((value) => {
        const url = new URL(value);
        return (
          (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
        );
      }, "must be an HTTP(S) URL without embedded credentials"),
      headers: stringMap.optional(),
    })
    .strict(),
]);

export type McpServerConfig = z.infer<typeof serverSchema>;
export type McpServersConfig = Record<string, McpServerConfig>;

export function parseMcpServersConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: McpServersConfig; errors: string[] } {
  if (raw === undefined) return { errors: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { errors: [`${sourceLabel}: 'mcpServers' must be an object.`] };
  }
  const config: McpServersConfig = {};
  const errors: string[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      errors.push(`${sourceLabel}: invalid MCP server name; use letters, digits, '_' or '-'.`);
      continue;
    }
    const parsed = serverSchema.safeParse(value);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join(".") || "entry";
      errors.push(`${sourceLabel}: mcpServers.${name}.${field} is invalid.`);
      continue;
    }
    Object.defineProperty(config, name, { value: parsed.data, enumerable: true });
  }
  return { config, errors };
}

export function resolveMcpServersConfig(
  level: ConfigLevel,
  servers: McpServersConfig,
): McpServersConfig {
  const resolvePath = (path: string) =>
    resolve(level.levelRoot, path.startsWith("~/") ? path.slice(2) : path);
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      server.type === "stdio"
        ? {
            ...server,
            command: server.command.includes("/") ? resolvePath(server.command) : server.command,
            cwd: server.cwd ? resolvePath(server.cwd) : level.levelRoot,
          }
        : server,
    ]),
  );
}
