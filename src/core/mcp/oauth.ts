import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
import {
  discoverOAuthServerInfo,
  OAuthError,
  parseWwwAuthenticate,
  refreshAuthorization,
  selectResource,
} from "@earendil-works/pi-mcp/oauth";
import { AuthStorage } from "../auth/auth_storage.js";
import type { StoredMcpOAuth } from "../auth/types.js";

export function validateMcpOAuthUrl(value: string | URL): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  ) {
    // Discovery propagates TypeError instead of treating it as missing metadata.
    throw new TypeError("MCP OAuth requires HTTPS except on loopback");
  }
  return url;
}

export const mcpOAuthFetch: McpFetch = async (input, init) => {
  let url = validateMcpOAuthUrl(input);
  for (let redirects = 0; ; redirects++) {
    const response = await fetch(url, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    await response.body?.cancel();
    url = validateMcpOAuthUrl(new URL(location, url));
    if (redirects >= 20 || (init?.method && !["GET", "HEAD"].includes(init.method))) {
      throw new TypeError("MCP OAuth request redirect is not allowed");
    }
  }
};

export function parseScopes(scope: string | undefined): string[] {
  if (!scope) return [];
  const scopes = [...new Set(scope.split(" ").filter(Boolean))];
  if (
    scopes.length > 512 ||
    scopes.some((value) => !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(value))
  ) {
    throw new Error("Invalid OAuth scopes");
  }
  return scopes;
}

export class McpAuthorizationError extends Error {
  readonly code = "mcp_authorization_required";
  readonly command: string;

  constructor(
    readonly server: string,
    readonly scopes: string[] = [],
  ) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = `tau mcp login ${server}${scopes.map((scope) => ` --scope ${quote(scope)}`).join("")}`;
    super(JSON.stringify({ code: "mcp_authorization_required", server, scopes, command }));
    this.name = "McpAuthorizationError";
    this.command = command;
  }
}

export class McpOAuthStorage {
  private readonly storage: AuthStorage;

  constructor(path: string) {
    this.storage = new AuthStorage(path);
  }

  read(url: string): StoredMcpOAuth | undefined {
    this.storage.reload();
    const error = this.storage.getInvalidReason();
    if (error) throw new Error(error);
    return this.storage.getData().mcp?.[url];
  }

  save(url: string, value: StoredMcpOAuth | undefined): void {
    this.read(url);
    this.storage.update((data) => {
      if (value) {
        data.mcp ??= {};
        data.mcp[url] = value;
      } else if (data.mcp) delete data.mcp[url];
    });
  }

  async lock<T>(url: string, run: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return await this.storage.withAccountLock("mcp", url, run, signal);
  }
}

export function createMcpAuthProvider(
  server: string,
  url: string,
  storage: McpOAuthStorage,
  signal: AbortSignal,
  staticAuthorization: boolean,
): AuthProvider {
  const refresh = async (
    rejectedToken: string | undefined,
    force: boolean,
    resourceMetadataUrl?: URL,
  ) => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    return await storage.lock(
      url,
      async () => {
        const current = storage.read(url);
        if (!current) throw new McpAuthorizationError(server);
        if (force && current.tokens.access_token !== rejectedToken)
          return current.tokens.access_token;
        if (
          !force &&
          (current.tokensExpireAt === undefined || current.tokensExpireAt > Date.now() + 30_000)
        ) {
          return current.tokens.access_token;
        }
        if (!current.tokens.refresh_token) throw new McpAuthorizationError(server);
        try {
          const metadataUrl =
            resourceMetadataUrl ??
            (current.resourceMetadataUrl ? new URL(current.resourceMetadataUrl) : undefined);
          const discovered = await discoverOAuthServerInfo(url, {
            resourceMetadataUrl: metadataUrl,
            fetch: mcpOAuthFetch,
            signal: deadline,
          });
          if (discovered.authorizationServerUrl !== current.authorizationServerUrl) {
            throw new McpAuthorizationError(server);
          }
          const tokens = await refreshAuthorization(discovered.authorizationServerUrl, {
            metadata: discovered.authorizationServerMetadata,
            clientInformation: current.clientInformation,
            resource: selectResource(url, discovered.resourceMetadata),
            refreshToken: current.tokens.refresh_token,
            fetch: mcpOAuthFetch,
            signal: deadline,
          });
          storage.save(url, {
            grantId: current.grantId,
            ...(metadataUrl ? { resourceMetadataUrl: metadataUrl.href } : {}),
            authorizationServerUrl: current.authorizationServerUrl,
            redirectUrl: current.redirectUrl,
            clientInformation: current.clientInformation,
            tokens: {
              ...tokens,
              scope: tokens.scope ?? current.tokens.scope,
              refresh_token: tokens.refresh_token ?? current.tokens.refresh_token,
            },
            ...(tokens.expires_in === undefined
              ? {}
              : { tokensExpireAt: Date.now() + tokens.expires_in * 1000 }),
          });
          return tokens.access_token;
        } catch (error) {
          deadline.throwIfAborted();
          if (error instanceof McpAuthorizationError) throw error;
          if (
            error instanceof OAuthError &&
            ["invalid_grant", "invalid_client", "unauthorized_client"].includes(error.code)
          ) {
            throw new McpAuthorizationError(server);
          }
          throw new Error(`failed to refresh MCP authorization for '${server}'`);
        }
      },
      deadline,
    );
  };
  return {
    async token() {
      signal.throwIfAborted();
      if (staticAuthorization) return undefined;
      const current = storage.read(url);
      if (!current) return undefined;
      if (current.tokensExpireAt !== undefined && current.tokensExpireAt <= Date.now() + 30_000) {
        return await refresh(current.tokens.access_token, false);
      }
      return current.tokens.access_token;
    },
    async onUnauthorized(context) {
      const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
      if (staticAuthorization)
        throw new Error(
          `MCP server '${server}' rejected its configured Authorization header; update or remove that header before using OAuth login.`,
        );
      if (challenge.error === "insufficient_scope") {
        throw new McpAuthorizationError(server, parseScopes(challenge.scope));
      }
      await refresh(context.token, true, challenge.resourceMetadataUrl);
    },
  };
}
