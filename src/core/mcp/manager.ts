import {
  type ContentBlock,
  McpClient,
  type McpFetch,
  McpSessionExpiredError,
  StdioTransport,
  StreamableHttpTransport,
  type Tool,
} from "@earendil-works/pi-mcp";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { McpServerConfig, McpServersConfig } from "../config/mcp.js";
import { APP_VERSION } from "../version.js";

const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 300_000;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

interface Connection {
  client: McpClient;
  ready: Promise<McpClient>;
  tools?: Tool[];
  revision: number;
}

export class McpManager {
  private readonly servers: McpServersConfig;
  private readonly connections = new Map<string, Connection>();
  private readonly startups = new Set<Promise<McpClient>>();
  private readonly cleanups = new Set<Promise<void>>();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    servers: McpServersConfig = {},
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.servers = structuredClone(servers);
  }

  get available(): boolean {
    return Object.values(this.servers).some((server) => server.enabled !== false);
  }

  listServers() {
    this.assertOpen();
    return Object.entries(this.servers)
      .filter(([, server]) => server.enabled !== false)
      .map(([name, server]) => ({ name, type: server.type }));
  }

  async listTools(
    server: string,
    signal: AbortSignal,
  ): Promise<{ instructions?: string; tools: Tool[] }> {
    signal.throwIfAborted();
    const connection = this.getConnection(server);
    const client = await waitForConnection(connection.ready, signal);
    signal.throwIfAborted();
    if (!connection.tools) {
      const revision = connection.revision;
      const tools = await this.request(client, () => client.listTools({ signal }));
      if (revision === connection.revision) connection.tools = tools;
      return { ...(client.instructions ? { instructions: client.instructions } : {}), tools };
    }
    return {
      ...(client.instructions ? { instructions: client.instructions } : {}),
      tools: connection.tools,
    };
  }

  async describeTool(server: string, name: string, signal: AbortSignal): Promise<Tool> {
    const { tools } = await this.listTools(server, signal);
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`MCP server '${server}' has no tool '${name}'.`);
    return tool;
  }

  async callTool(server: string, name: string, args: Record<string, unknown>, signal: AbortSignal) {
    const tool = await this.describeTool(server, name, signal);
    if (!Value.Check(tool.inputSchema as TSchema, args)) {
      throw new Error(`Invalid arguments for MCP tool '${server}/${name}'; read its inputSchema.`);
    }
    signal.throwIfAborted();
    const client = await waitForConnection(this.getConnection(server).ready, signal);
    const result = await this.request(client, () =>
      client.callTool(name, args, {
        signal,
        timeoutMs: this.servers[server]!.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
      }),
    );
    return {
      content: result.content.map(stripContentMetadata),
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
      isError: result.isError ?? false,
    };
  }

  async listResources(server: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const client = await waitForConnection(this.getConnection(server).ready, signal);
    const resources = await this.request(client, () => client.listResources({ signal }));
    return resources.map(({ _meta, ...resource }) => resource);
  }

  async listResourceTemplates(server: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const client = await waitForConnection(this.getConnection(server).ready, signal);
    const templates = await this.request(client, () => client.listResourceTemplates({ signal }));
    return templates.map(({ _meta, ...template }) => template);
  }

  async readResource(server: string, uri: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const client = await waitForConnection(this.getConnection(server).ready, signal);
    const result = await this.request(client, () =>
      client.readResource(uri, {
        signal,
        timeoutMs: this.servers[server]!.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
      }),
    );
    return {
      contents: result.contents.map(({ _meta, ...content }) => content),
    };
  }

  close(): Promise<void> {
    this.closed = true;
    this.closePromise ??= this.closeConnections();
    return this.closePromise;
  }

  private async closeConnections(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    const results = await Promise.allSettled(
      connections.map(async ({ client, ready }) => {
        await this.closeClient(client);
        await ready.catch(() => {});
      }),
    );
    await Promise.allSettled(this.startups);
    const cleanups = await Promise.allSettled(this.cleanups);
    if ([...results, ...cleanups].some((result) => result.status === "rejected")) {
      throw new Error("failed to close MCP connections");
    }
  }

  private async request<T>(client: McpClient, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof McpSessionExpiredError) await this.closeClient(client);
      throw error;
    }
  }

  private closeClient(client: McpClient): Promise<void> {
    const cleanup = client.close();
    this.cleanups.add(cleanup);
    void cleanup.then(
      () => this.cleanups.delete(cleanup),
      () => this.cleanups.delete(cleanup),
    );
    return cleanup;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("MCP connections are closed.");
  }

  private getConnection(name: string): Connection {
    this.assertOpen();
    const server = Object.hasOwn(this.servers, name) ? this.servers[name] : undefined;
    if (!server || server.enabled === false)
      throw new Error(`MCP server '${name}' is unavailable.`);
    const existing = this.connections.get(name);
    if (existing && existing.client.connectionState !== "closed") return existing;
    const client = new McpClient({
      name: "tau",
      version: APP_VERSION,
      requestTimeoutMs: server.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
    });
    const transport = this.createTransport(name, server);
    const connection: Connection = {
      client,
      ready: Promise.resolve(client),
      revision: 0,
    };
    this.connections.set(name, connection);
    client.onNotification("notifications/tools/list_changed", () => {
      connection.tools = undefined;
      connection.revision++;
    });
    const timer = setTimeout(() => {
      void this.closeClient(client).catch(() => {});
    }, server.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
    connection.ready = client
      .connect(transport)
      .then(
        () => {
          this.assertOpen();
          return client;
        },
        () => {
          throw new Error(
            `failed to connect MCP server '${name}'; check its configuration and authentication`,
          );
        },
      )
      .finally(() => clearTimeout(timer));
    this.startups.add(connection.ready);
    // A caller can be cancelled while the shared startup continues to its request deadline.
    void connection.ready.then(
      () => this.startups.delete(connection.ready),
      () => this.startups.delete(connection.ready),
    );
    return connection;
  }

  private createTransport(name: string, server: McpServerConfig) {
    const expand = (values: Record<string, string> = {}) =>
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable: string) => {
            const resolved = this.env[variable];
            if (resolved === undefined)
              throw new Error(`MCP server '${name}' requires environment variable '${variable}'.`);
            return resolved;
          }),
        ]),
      );
    if (server.type === "http") {
      return new StreamableHttpTransport({
        url: server.url,
        headers: expand(server.headers),
        fetch: boundedFetch(
          Math.max(
            server.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
            server.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
          ),
        ),
        maxMessageBytes: MAX_MESSAGE_BYTES,
      });
    }
    return new StdioTransport({
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      env: {
        ...Object.fromEntries(
          Object.entries(this.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        ...expand(server.env),
      },
      inheritEnv: false,
      maxMessageBytes: MAX_MESSAGE_BYTES,
    });
  }
}

function stripContentMetadata(block: ContentBlock): ContentBlock {
  const { _meta, ...content } = block;
  if (content.type !== "resource") return content;
  const { _meta: resourceMeta, ...resource } = content.resource;
  return { ...content, resource };
}

function boundedFetch(timeoutMs: number): McpFetch {
  return async (input, init) => {
    const signal =
      init?.method === "GET"
        ? init.signal
        : AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs)]);
    const response = await fetch(input, { ...init, signal });
    if (
      !response.body ||
      response.headers.get("content-type")?.split(";")[0]?.trim() === "text/event-stream"
    ) {
      return response;
    }
    let bytes = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > MAX_MESSAGE_BYTES)
            throw new Error("MCP HTTP response exceeded the 16 MiB limit.");
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function waitForConnection<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
