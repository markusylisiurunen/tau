import { randomUUID } from "node:crypto";
import {
  authorizeMcp,
  discoverOAuthServerInfo,
  McpOAuthProvider,
  MemoryOAuthStateStore,
  OAuthCallbackServer,
  OAuthError,
  OAuthRegistrationError,
  parseWwwAuthenticate,
} from "@earendil-works/pi-mcp/oauth";
import type { McpServersConfig } from "../config/mcp.js";
import { McpOAuthStorage, mcpOAuthFetch, parseScopes, validateMcpOAuthUrl } from "./oauth.js";

export type McpCliCommand =
  | { type: "help" }
  | { type: "logout"; server: string }
  | { type: "login"; server: string; scopes: string[]; all: boolean };

export function parseMcpCliArgs(args: string[]): McpCliCommand {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]!)))
    return { type: "help" };
  const [type, server, ...flags] = args;
  if (type !== "login" && type !== "logout") throw new Error("expected tau mcp login or logout");
  if (!server || !/^[A-Za-z0-9_-]+$/.test(server))
    throw new Error("expected a configured MCP server name");
  if (type === "logout") {
    if (flags.length) throw new Error("tau mcp logout does not accept flags");
    return { type, server };
  }
  let all = false;
  const scopes: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--all" && !all) all = true;
    else if (flag === "--scope") {
      const scope = flags[++i];
      if (
        !scope ||
        scope.startsWith("--") ||
        parseScopes(scope).length !== 1 ||
        scope.includes(" ")
      ) {
        throw new Error("--scope requires one OAuth scope; repeat the flag for additional scopes");
      }
      scopes.push(scope);
    } else throw new Error(`unknown MCP login option '${flag}'`);
  }
  if (all && scopes.length) throw new Error("--all and --scope cannot be combined");
  return { type, server, all, scopes: [...new Set(scopes)] };
}

export const mcpHelp = [
  "usage:",
  "  tau mcp login <server> [--scope <scope> ... | --all]",
  "  tau mcp logout <server>",
  "",
  "Run on the host, from its launch directory, to use the same MCP configuration.",
  "Login prints an authorization URL to open manually. --scope adds to the existing grant.",
  "--all requests every scope advertised by the authorization server.",
  "Logout removes local OAuth credentials; it does not revoke the grant at the service.",
  "See credentials.md in the Tau documentation for remote-host login.",
].join("\n");

export async function runMcpCommand(options: {
  command: Exclude<McpCliCommand, { type: "help" }>;
  servers: McpServersConfig;
  authPath: string;
  signal: AbortSignal;
  log: (message: string) => void;
}): Promise<void> {
  const { command, servers, signal, log } = options;
  const server = servers[command.server];
  if (server?.type !== "http" || server.enabled === false) {
    throw new Error(`'${command.server}' must be an enabled HTTP MCP server`);
  }
  const url = validateMcpOAuthUrl(server.url).href;
  const storage = new McpOAuthStorage(options.authPath);
  if (command.type === "logout") {
    await storage.lock(url, async () => storage.save(url, undefined), signal);
    log(`removed local MCP authorization for '${command.server}'`);
    return;
  }
  if (Object.keys(server.headers ?? {}).some((key) => key.toLowerCase() === "authorization")) {
    throw new Error("remove the configured Authorization header before using MCP OAuth login");
  }
  const previous = storage.read(url);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const response = await mcpOAuthFetch(url, { signal: deadline });
  const { resourceMetadataUrl, scope } = parseWwwAuthenticate(
    response.headers.get("www-authenticate"),
  );
  await response.body?.cancel();
  const discovered = await discoverOAuthServerInfo(url, {
    resourceMetadataUrl,
    fetch: mcpOAuthFetch,
    signal: deadline,
  });
  const challengedScopes = parseScopes(scope);
  const advertised = discovered.authorizationServerMetadata?.scopes_supported;
  if (command.all && !advertised?.length)
    throw new Error("the authorization server does not advertise scopes; --all is unavailable");
  const scopes = parseScopes(
    [
      previous?.tokens.scope,
      ...(command.all
        ? advertised!
        : command.scopes.length
          ? command.scopes
          : challengedScopes.length
            ? challengedScopes
            : (discovered.resourceMetadata?.scopes_supported ?? [])),
    ]
      .filter(Boolean)
      .join(" "),
  );
  const registeredScopes = parseScopes(
    previous && "scope" in previous.clientInformation
      ? previous.clientInformation.scope
      : undefined,
  );
  const redirect = previous ? new URL(previous.redirectUrl) : undefined;
  const callback = await OAuthCallbackServer.listen(
    redirect ? { port: Number(redirect.port), path: redirect.pathname } : {},
  );
  const onAbort = () => {
    void callback.close().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const store = new MemoryOAuthStateStore();
    store.save({
      serverUrl: url,
      clientInformation:
        previous?.authorizationServerUrl === discovered.authorizationServerUrl &&
        scopes.every((scope) => registeredScopes.includes(scope))
          ? previous.clientInformation
          : undefined,
    });
    let authorizationUrl: URL | undefined;
    const provider = new McpOAuthProvider({
      serverUrl: url,
      redirectUrl: callback.redirectUrl,
      clientMetadata: { client_name: "Tau", token_endpoint_auth_method: "none" },
      store,
      onRedirect: (value) => {
        authorizationUrl = validateMcpOAuthUrl(value);
      },
    });
    await provider.saveDiscoveryState(discovered);
    const flow = {
      serverUrl: url,
      scope: scopes.join(" ") || undefined,
      skipRefresh: true,
      fetch: mcpOAuthFetch,
    };
    await authorizeMcp(provider, {
      ...flow,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!authorizationUrl) throw new Error("the server did not provide an authorization URL");
    const pending = callback.waitForCallback(await provider.state());
    log(`open this URL in your browser:\n${authorizationUrl.href}`);
    log(`callback: ${callback.redirectUrl}`);
    const response = await pending;
    signal.throwIfAborted();
    await authorizeMcp(provider, {
      ...flow,
      authorizationCode: response.code,
      iss: response.iss,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    const state = store.load();
    if (!state?.clientInformation || !state.tokens)
      throw new Error("authorization did not return credentials");
    const credentials = {
      grantId: randomUUID(),
      ...(resourceMetadataUrl ? { resourceMetadataUrl: resourceMetadataUrl.href } : {}),
      authorizationServerUrl: discovered.authorizationServerUrl,
      redirectUrl: callback.redirectUrl,
      clientInformation: state.clientInformation,
      tokens: state.tokens,
      tokensExpireAt: state.tokensExpireAt,
    };
    await storage.lock(
      url,
      async () => {
        if (storage.read(url)?.grantId !== previous?.grantId) {
          throw new Error("MCP credentials changed during login; run login again");
        }
        storage.save(url, credentials);
      },
      signal,
    );
    log(`authorized MCP server '${command.server}'`);
  } catch (error) {
    if (error instanceof OAuthRegistrationError) {
      throw new Error(`MCP OAuth client registration failed (HTTP ${error.status})`);
    }
    if (error instanceof OAuthError) {
      const code = /^[a-z_]+$/.test(error.code) ? error.code : "server_error";
      throw new Error(`MCP OAuth authorization failed (${code})`);
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await callback.close().catch(() => {});
  }
}
