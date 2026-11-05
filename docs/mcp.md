# MCP

Tau connects to MCP servers defined in `config.json`. The agent reaches them through [`tau.mcp`](code-mode.md), and the persona needs `mcp` in its `tools`, which built-in personas have.

## Configure a server

```json
{
  "mcpServers": {
    "issues": {
      "type": "stdio",
      "command": "uvx",
      "args": ["example-mcp-server"],
      "env": { "API_TOKEN": "${ISSUES_TOKEN}" },
      "description": "Search and update engineering issues."
    },
    "docs": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
    }
  }
}
```

```ts
type McpServer = {
  enabled?: boolean; // default true, false turns off an inherited server
  description?: string; // shown to the model, at most 512 characters
  timeoutMs?: number; // tool calls and resource reads, default 300000
  discoveryTimeoutMs?: number; // connection and discovery, default 30000
} & (
  | {
      type: "stdio";
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    }
  | { type: "http"; url: string; headers?: Record<string, string> } // streamable HTTP
);
```

`${NAME}` in `env` and `headers` reads a host environment variable, and a missing variable makes the connection fail. Stdio commands run directly without a shell. Relative commands and `cwd` resolve from the directory of the config level that defines the server.

## Where servers run

Servers come from the global and project configuration of the session's working directory, and server names add up across levels. Stdio servers run on the host with the host's full environment and permissions, so a project's `.tau/config.json` can start commands there. See [security](security.md).

Sessions on a remote execution environment, such as a Fly Sprite, have no MCP servers. Subagents use the servers of their parent session.

## Applying changes

The host reads definitions when it loads a session. `/reload` warns if they changed but does not apply them, so start a new session, or reopen the session after the host has unloaded it. Restart the host after changing environment variables that servers use.

## Sign in with OAuth

An HTTP server can use browser sign-in in place of a token. Leave out the `Authorization` header and run this on the host, from the session's working directory:

```sh
tau mcp login docs
tau mcp login docs --scope dns.write
tau mcp login docs --all
tau mcp logout docs
```

Login prints a URL to open in your browser, and the callback listens on loopback for five minutes. On a remote host, forward the printed port first:

```sh
ssh -N -L <port>:127.0.0.1:<port> <host>
```

Credentials are stored per server URL, so every session on that host shares them, and running sessions pick them up without a restart. `--scope` adds to the existing grant, and `--all` requests every advertised scope. When a call needs more permissions, it fails with the login command to run, and you tell the agent to continue afterwards. Logout does not revoke the grant at the service.

## Limits

Calls have no confirmation step. Tau does not support MCP prompts, subscriptions, elicitation, or sampling. Connections open on first use, and calls that change data are never retried.
