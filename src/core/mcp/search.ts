import { rankBm25 } from "../utils/bm25.js";
import type { McpManager } from "./manager.js";

function schemaText(schema: unknown, parts: string[]): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return;
  const value = schema as Record<string, unknown>;
  if (typeof value.description === "string") parts.push(value.description);
  if (typeof value.properties === "object" && value.properties !== null) {
    for (const [name, property] of Object.entries(value.properties)) {
      parts.push(name);
      schemaText(property, parts);
    }
  }
  schemaText(value.items, parts);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const variants = value[key];
    if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
  }
}

export async function searchMcpTools(
  manager: McpManager,
  query: string,
  options: { server?: string; limit: number },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const servers =
    options.server === undefined
      ? manager.listServers().map((server) => server.name)
      : [options.server];
  const catalogs = new Array<Awaited<ReturnType<McpManager["listTools"]>> | undefined>(
    servers.length,
  );
  const failures = new Array<{ server: string; error: string } | undefined>(servers.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, servers.length) }, async () => {
      while (next < servers.length) {
        signal.throwIfAborted();
        const index = next++;
        const server = servers[index]!;
        try {
          catalogs[index] = await manager.listTools(server, signal);
        } catch {
          signal.throwIfAborted();
          failures[index] = { server, error: "failed to discover tools" };
        }
      }
    }),
  );
  signal.throwIfAborted();
  const tools: { server: string; name: string; description?: string }[] = [];
  const documents = catalogs.flatMap((catalog, index) => {
    if (!catalog) return [];
    const server = servers[index]!;
    return catalog.tools.map((tool) => {
      const id = String(tools.length);
      tools.push({
        server,
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
      });
      // Repeated name tokens give exact tool-name matches more influence.
      const parts = [
        tool.name,
        tool.name,
        tool.description ?? "",
        server,
        catalog.instructions ?? "",
      ];
      schemaText(tool.inputSchema, parts);
      return { id, text: parts.join(" ") };
    });
  });
  return {
    tools: rankBm25(query, documents, options.limit).map((match) => ({
      ...tools[Number(match.id)]!,
      score: match.score,
    })),
    errors: failures.filter((failure) => failure !== undefined),
  };
}
