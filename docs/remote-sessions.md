# Remote sessions

In a remote session, the terminal stays on your machine while the session host and execution environment run elsewhere. `tau attach` is the same TUI, connected over WebSocket. What changes is which machine holds credentials and saved sessions, and where the agent's commands run.

## Choose the connection shape

Choose the simplest setup that matches how long the host should live.

| Setup | Best for | Lifetime and ownership |
| --- | --- | --- |
| `tau serve` plus WebSocket attach | Long-running hosts, reconnects, and multiple observers | The server owns the host independently of any one TUI. |
| Node SDK with its default client | Applications that want an in-process host | The SDK client owns the host and closes it with the client. |
| Node SDK over WebSocket | Applications sharing a long-running `tau serve` host | The server owns sessions; the SDK observes them remotely. |

Use `tau serve` for remote TUI and SDK connections. To rely on SSH for security, keep it on loopback and connect through an SSH tunnel. The [session protocol](session-protocol.md) and [Node SDK](node-sdk.md) cover the developer APIs and wire format; this page covers operation.

## Host sessions over WebSocket

Start a server on the host:

```sh
tau serve
```

By default the server listens on `127.0.0.1:8787`, which suits local clients or a reverse proxy on the same machine. To listen on another interface, set it explicitly and require a strong token:

```sh
export TAU_WS_AUTH_TOKEN="$(openssl rand -hex 32)"
tau serve --host 0.0.0.0 --port 8787 --auth-token "$TAU_WS_AUTH_TOKEN"
```

From the client machine:

```sh
export TAU_WS_AUTH_TOKEN='the-same-token'
tau attach ws://buildbox.example:8787
```

`tau attach` uses `TAU_WS_AUTH_TOKEN` when `--auth-token` is not given. You can also pass the token explicitly:

```sh
tau attach --auth-token "$TAU_WS_AUTH_TOKEN" ws://buildbox.example:8787
```

The token gives full access to all hosted sessions. Without `--auth-token` or `TAU_WS_AUTH_TOKEN`, the server has no authentication. Tau serves plain WebSocket and has no TLS settings. On an untrusted network, put it behind a trusted TLS reverse proxy and attach with `wss://`, or keep it on loopback and use an SSH tunnel. The token is sent when the connection is set up, so treat proxy logs and WebSocket handshake data as sensitive.

A typical tunnel, with Tau on loopback:

```sh
ssh -N -L 8787:127.0.0.1:8787 dev@buildbox.example
```

Then attach locally:

```sh
tau attach ws://127.0.0.1:8787
```

## List, select, create, or attach

Without `--session` or `--new`, `tau attach` asks the host for its session list and opens an interactive selector:

```sh
tau attach ws://127.0.0.1:8787
```

The selector shows each session ID and whether it is idle or running, and can also create a session. It needs a terminal: if stdin or stdout is not a TTY, pass `--session` or `--new`.

If you know the session ID, attach directly:

```sh
tau attach \
  --session 0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3 \
  ws://127.0.0.1:8787
```

To create a new session, give an absolute `--cwd` in the chosen execution environment:

```sh
tau attach \
  --new \
  --cwd /srv/workspaces/tau \
  ws://127.0.0.1:8787
```

With the default `local` execution kind, this path is on the host machine, not the attaching machine. The directory must already exist and contain the repository or workspace you want. Tau creates only the session, not the directory or repository.

A remote `--new` sets the creation attribute `source: "tui"`. It does not look at the remote directory to fill in repository information. Clients that need it should create sessions through the SDK or protocol and send complete attributes. See [sessions](sessions.md).

`tau attach` does not accept the persona flags of local startup. Set the server's default when starting the host, for example `tau serve --persona opus-5.5-coder`, or switch the new session with `/persona:<id>` after attaching.

## Select an execution environment

A session can use a directory on the host or an existing Fly Sprite. Either way, the working directory is an absolute path inside that environment.

### Host-local directory

`local` is the default:

```sh
tau attach --new --cwd /srv/workspaces/tau ws://host.example:8787
```

The agent's file operations and commands run on the host machine. Tau does not clone, pull, or set up a repository.

### Fly Sprite

The host must have a `flySprites` connection configured, and the Sprite must already exist:

```sh
tau attach \
  --new \
  --execution-kind fly-sprite \
  --fly-sprite tau-build-7 \
  --cwd /home/sprite/tau \
  wss://tau.example.com
```

`--fly-sprite` names an existing Sprite. Tau does not provision it or prepare its repository.

The Sprite API URL, home path, and token are host [configuration](configuration.md). When the session is created, Tau reads project configuration and content from the working directory inside the Sprite.

## Keep the ownership boundaries clear

An attached session involves three separate parts, even when two of them run on the same machine.

### The attaching client owns

- terminal rendering, editor drafts, clipboard operations, and local notifications
- loaded themes and `defaultTheme`
- `/listen`, `/speak`, and their local credentials and OS commands
- the built-in or configured diff-tool process
- configured command-backed client-tool processes
- the client’s Tau binary and TUI behavior

### The session host owns

- session orchestration, persistence, and recovery
- provider credential resolution and model execution
- WebSocket authentication and listener lifetime
- hosted execution environment settings and credentials
- pending input while the session remains live
- the host’s Tau binary and built-in agent documentation

### The execution environment owns

- the agent-visible cwd, home, files, and repository
- project `.tau` content, prompts, skills, and AGENTS.md files
- command execution, platform, PATH, and runtime dependencies
- automatic-compaction archives and other target-side temporary files

That is why a host's theme setting does not affect a remote TUI, why `!git status` runs in the execution environment, and why the built-in diff review tool opens on the attaching machine. [Ownership and scope](ownership-and-scope.md) applies the same model across Tau.

## Reload or restart the correct process

Each kind of change belongs to a different process:

| Change | Action |
| --- | --- |
| Project config, personas, prompts, skills, or AGENTS.md in the execution environment | Wait for idle, then run `/reload`. |
| Global model `apiKeys` on the host | Restart the host. |
| Codex auth changed with `tau auth` | No restart needed; every new request reads auth storage again. |
| Attaching themes, speech config, or configured client tools | Restart `tau attach`. |
| Host environment variables, history target, WebSocket listener, Fly Sprite connection, or host startup flags | Restart `tau serve`. |
| Host Tau package, built-in tools, protocol, session recovery code, or built-in documentation | Upgrade and restart the host. |
| TUI package, keybindings, rendering, local speech, or client-tool implementation | Upgrade and restart the attaching client. |

`/reload` acts on the session. The host reads session content again from the execution environment. It does not reload either process's code or environment. For a long-running WebSocket host, restarting only the client does not update the host's tools or the documentation its agent reads. For an old client attached to a new host, restarting only the host does not update the TUI. See [credentials](credentials.md) for complete precedence and apply boundaries.

## Reconnect and observe safely

A WebSocket connection observes a hosted session. It does not own the saved session and cannot delete it. After the last client disconnects, the host unloads an idle session from memory and keeps it saved. If a client disconnects while work is running, the host keeps working and unloads the session only after the work finishes. Reattach with the same session ID to get the current state and continue receiving updates.

A clean `tau serve` shutdown interrupts running work, saves live sessions, and closes clients. After a restart, the host lists the sessions whose execution environments it can reconnect. Recovered sessions come back idle, without queued or steering messages, and without subagents.

## Use multiple observers carefully

Several WebSocket clients can observe the same live session and receive the same updates and pending messages. Every one of them can also submit, queue, steer, interrupt, or change the session. None is read-only, so agree on who, or which automation, is in charge.

Each TUI offers its `diff_review` and `prefill_input` tools plus its enabled configured client tools. Only one client may offer a given tool name in a session. Start additional clients with:

```sh
tau attach --no-client-tools --session 0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3 ws://host.example:8787
```

A turn keeps the client tools that were available when it started. If the owning client detaches, its tools become unavailable and its running calls are cancelled. After a host restart, client tools return only when a client that offers them attaches again. See [client tools](client-tools.md).

## Troubleshoot connection and recovery

### The client reports an unsupported protocol version

Client and host must use exactly the same protocol version; there is no negotiation. Upgrade both to the same Tau release, restart both, and reconnect. The agent's tools and documentation come from the host's installation, and TUI behavior comes from the client's.

Do not downgrade a host that has already saved sessions in a newer format. Newer Tau versions upgrade supported older sessions when recovering them, but older versions cannot read newer sessions.

### A session is missing from the selector

The host lists only saved sessions whose execution environment it can reconnect. Confirm that:

- the connection uses the same host user and home directory as the original process
- the Fly Sprite connection is still configured on the host
- host credentials are available to the restarted process
- the target Sprite or local directory still exists
- the session was created on this host rather than another machine with a different store

Do not edit the session files to change the environment. Restore the configuration or the target instead.

### WebSocket attachment is unauthorized

Check that server and client use the same token, and that any reverse proxy passes through the WebSocket request path and query string. `TAU_WS_AUTH_TOKEN` can supply the token on either side without you noticing, so check the environment as well as the flags. Do not print the token into shared logs.

### A reconnect shows an interrupted turn

A client disconnecting does not stop a turn on a WebSocket host, but a server shutdown does. Look at the last assistant message and tool results, check the execution environment with `!!pwd` and `!!git status --short`, then retry if you mean to. [Sessions](sessions.md) explains recovery and how to check a recovered session.
