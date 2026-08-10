# Remote sessions

Remote sessions let the terminal stay close to the user while the session host and execution environment run elsewhere. Tau does not turn remote work into a second product mode: `tau attach` uses the same TUI over a WebSocket or stdio transport. The important choice is which process should stay alive, who owns credentials and persistence, and where agent-visible commands run.

## Choose the connection shape

Use the smallest shape that matches the lifecycle you need.

| Shape | Best for | Lifetime and ownership |
| --- | --- | --- |
| `tau serve` plus WebSocket attach | Long-running hosts, reconnects, and multiple observers | The server owns the host independently of any one TUI. |
| `tau attach -- ssh … tau rpc` | Ad hoc access through SSH without exposing a listener | The attachment owns one remote RPC process. Closing it shuts that host down. |
| `tau rpc` directly | Editors, automation, and custom protocol clients over NDJSON | The parent process owns the RPC host and its stdin/stdout. |
| Node SDK with its default client | Applications that want an in-process host | The SDK client owns the host and closes it with the client. |
| Node SDK over WebSocket | Applications sharing a long-running `tau serve` host | The server owns sessions; the SDK observes them remotely. |

Use `tau serve` when a turn should continue after a laptop disconnects. Use stdio/SSH when SSH is already the desired security and process boundary and it is acceptable for closing the TUI to stop remote work. The [RPC protocol reference](https://github.com/markusylisiurunen/tau/blob/main/docs/rpc.md?plain=1) and [Node SDK reference](https://github.com/markusylisiurunen/tau/blob/main/docs/sdk.md?plain=1) cover developer APIs and wire details; this page stays at the operational level.

## Host sessions over WebSocket

Start a server on the host:

```sh
tau serve
```

The default listener is `127.0.0.1:8787`. This is suitable for local clients or a reverse proxy on the same machine. To listen on another interface, set it explicitly and require a strong token:

```sh
export TAU_WS_AUTH_TOKEN="$(openssl rand -hex 32)"
tau serve --host 0.0.0.0 --port 8787 --auth-token "$TAU_WS_AUTH_TOKEN"
```

From the client machine:

```sh
export TAU_WS_AUTH_TOKEN='the-same-token'
tau attach ws://buildbox.example:8787
```

`tau attach` uses `TAU_WS_AUTH_TOKEN` when `--auth-token` is absent. An explicit form is also valid:

```sh
tau attach --auth-token "$TAU_WS_AUTH_TOKEN" ws://buildbox.example:8787
```

A server token authorizes full access to hosted sessions. Without `--auth-token` or `TAU_WS_AUTH_TOKEN`, the listener is unauthenticated. Tau’s server terminates plain WebSocket traffic and does not accept certificate options. On an untrusted network, put it behind a trusted TLS reverse proxy and attach with `wss://`, or keep it bound to loopback and use an SSH tunnel. Treat proxy logs and WebSocket handshake metadata as sensitive because the authentication token is carried during connection setup.

A typical tunnel keeps Tau bound to loopback:

```sh
ssh -N -L 8787:127.0.0.1:8787 dev@buildbox.example
```

Then attach locally:

```sh
tau attach ws://127.0.0.1:8787
```

## Attach through stdio and SSH

Anything after `--` is launched as a local child process and must speak Tau’s session protocol over stdin and stdout. SSH makes that child a remote `tau rpc` process:

```sh
tau attach -- ssh dev@buildbox.example tau rpc
```

A login shell or project-specific host configuration can be selected in the remote command:

```sh
tau attach -- ssh dev@buildbox.example 'cd /srv/tau-host && tau rpc'
```

The remote process’s stdin and stdout are protocol traffic. Shell startup files and wrapper scripts must not print banners to stdout. Put diagnostics on stderr.

This is a one-shot host. When the TUI exits or the transport fails, the local child is terminated, `tau rpc` shuts down its host, active work is interrupted, and durable state is recovered on the next process. Do not use this shape when work must continue through client disconnects; run `tau serve` instead.

## List, select, create, or attach

Without `--session` or `--new`, `tau attach` asks the host for its session list and opens an interactive selector:

```sh
tau attach ws://127.0.0.1:8787
```

The selector shows each session id and whether it is currently idle or running. It can also create a session. If stdin or stdout is not a TTY, selection is unavailable, so specify `--session` or `--new`.

Attach directly when the session id is known:

```sh
tau attach \
  --session 0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3 \
  ws://127.0.0.1:8787
```

The equivalent SSH form is:

```sh
tau attach \
  --session 0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3 \
  -- ssh dev@buildbox.example tau rpc
```

Create a new session with an absolute cwd in the selected execution environment:

```sh
tau attach \
  --new \
  --cwd /srv/workspaces/tau \
  ws://127.0.0.1:8787
```

For stdio/SSH:

```sh
tau attach \
  --new \
  --cwd /srv/workspaces/tau \
  -- ssh dev@buildbox.example tau rpc
```

For the default `local` execution kind, this path is on the host machine, not the attaching machine. It must already be a usable directory with the desired repository or workspace. Tau creates the session, not the directory or repository.

Remote `--new` supplies the conventional creation attribute `source: "tui"`. It does not infer repository metadata by inspecting the remote cwd. Clients that need repository provenance should create through the SDK or protocol and provide complete immutable attributes. See [sessions](sessions.md).

`tau attach` does not accept the normal local startup persona flags. Select the server’s default at host startup, for example `tau serve --persona opus-5-coder`, or switch the newly created session with `/persona:<id>` after attaching.

## Select an execution environment

A session can use a local host directory, an already-provisioned Cloudflare Sandbox, or an already-provisioned Fly Sprite. In all cases, the execution cwd is an absolute path inside that environment.

### Host-local directory

`local` is the default:

```sh
tau attach --new --cwd /srv/workspaces/tau ws://host.example:8787
```

The host process executes agent-visible filesystem and command operations on its own machine. Tau does not clone, pull, or provision a repository.

### Cloudflare Sandbox

The host must already have a named bridge in `cloudflareSandbox.bridges`, and the sandbox must already exist:

```sh
tau attach \
  --new \
  --execution-kind cloudflare-sandbox \
  --cloudflare-bridge production \
  --cloudflare-sandbox sandbox-42 \
  --cwd /workspace/tau \
  wss://tau.example.com
```

`--cloudflare-bridge` identifies host configuration. `--cloudflare-sandbox` identifies an existing sandbox reachable through that bridge. Tau does not create the sandbox or copy a repository into it.

### Fly Sprite

The host must already have a named API target in `flySprites.apis`, and the Sprite must already exist:

```sh
tau attach \
  --new \
  --execution-kind fly-sprite \
  --fly-api production \
  --fly-sprite tau-build-7 \
  --cwd /home/sprite/tau \
  wss://tau.example.com
```

`--fly-api` identifies host configuration. `--fly-sprite` names an existing Sprite. Tau does not provision it or prepare its repository.

Bridge URLs, API targets, home paths, and credential environment variables are host-owned [configuration](configuration.md). Session creation resolves Tau project configuration and content from the execution cwd through the selected environment. The execution environment itself remains a generic filesystem and process target; it does not own Tau’s configuration precedence or session policy.

## Keep the ownership boundaries clear

An attached session spans three logical machines even when two happen to share one operating system.

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
- execution-environment resolver definitions and credentials
- pending input while the session remains live
- the host’s Tau binary and built-in agent documentation

### The execution environment owns

- the agent-visible cwd, home, files, and repository
- project `.tau` content, model overlays, prompts, skills, and AGENTS.md files
- command execution, platform, PATH, and runtime dependencies
- automatic-compaction archives and other target-side temporary files

This is why changing a host theme does not affect a remote TUI, why `!git status` runs against the execution environment, and why a custom diff application opens on the attaching machine. [Ownership and scope](ownership-and-scope.md) applies the same model across Tau.

## Reload or restart the correct process

Different changes have different owners:

| Change | Action |
| --- | --- |
| Project config, model overlays, personas, prompts, skills, or AGENTS.md in the execution environment | Wait for idle, then run `/reload`. |
| Effective model `apiKeys` in execution-environment or session configuration | Wait for idle, then run `/reload`; new sessions also resolve the current values. |
| Managed Codex auth changed with `tau auth` | No host restart; auth storage is read again on later credential resolutions. |
| Attaching themes, diff launcher, speech config, or configured client tools | Restart `tau attach`. |
| Host process environment variables, history target, WebSocket listener, Cloudflare bridge, Fly API target, or host startup flags | Restart `tau serve` or the `tau rpc` process. |
| Host Tau package, built-in tools, protocol, session recovery code, or built-in documentation | Upgrade and restart the host. |
| TUI package, keybindings, rendering, local speech, or client-tool implementation | Upgrade and restart the attaching client. |

`/reload` is a session operation. It asks the host to resolve session-owned content, including configured model `apiKeys`, from the execution environment and does not reload either process’s executable code or environment. Managed Codex auth storage is separate and is read again on later credential resolutions. For a long-running WebSocket host, restarting only the client cannot update the model-facing built-in docs or host tools. For an old client against a new host, restarting only the host cannot update local TUI behavior. See [credentials](credentials.md) for complete precedence and apply boundaries.

## Reconnect and observe safely

A WebSocket connection observes a hosted session; it does not own or delete it. If a TUI disconnects while a turn runs, the host keeps working. Reattach with the same session id to obtain the current persisted state and continue receiving updates.

A clean `tau serve` shutdown interrupts active work, persists live sessions, and closes clients. On restart, the host lists sessions whose execution environments it can restore. Recovery returns sessions idle, drops pending queued and steering messages, discards live subagents, and changes an active persistent goal to blocked. Use `/goal resume` only after checking why the host stopped.

A stdio/SSH connection is different because its RPC process is the host. Closing the connection ends that process. The session remains stored under the remote host user’s `~/.config/tau/sessions` and can be observed by a later `tau rpc` process using the same home and compatible resolver configuration.

## Use multiple observers carefully

Multiple WebSocket clients can observe the same live session and receive the same committed updates and pending-message state. They can also submit, queue, steer, interrupt, or mutate that session, so coordinate human or automation ownership rather than treating observers as read-only.

Each ordinary TUI advertises client-owned `diff_review` and `prefill_input` tools plus enabled configured client tools. Only one observing client may advertise a given client-tool name for a session. Start additional observers with:

```sh
tau attach --no-client-tools --session 0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3 ws://host.example:8787
```

The host captures the available client-tool set when a turn starts. If the owning client detaches before a delegated call, that tool becomes unavailable; an active delegated call is cancelled. Client tools are not recovered after host restart until a client advertising them attaches again. See [client tools](client-tools.md).

## Troubleshoot connection and recovery

### The client reports an unsupported protocol version

Tau’s current session protocol uses an exact version, not a compatibility negotiation. Upgrade the host and attaching client to the same Tau release, restart both processes, and reconnect. The host-facing agent uses tools and documentation from the host installation, while TUI behavior comes from the client installation.

Avoid downgrading a host that has already written sessions with a newer storage format. Newer Tau versions migrate supported older session documents during normal recovery; older versions are not expected to understand newer documents.

### A session is missing from the selector

The host lists only stored sessions whose execution-environment kind it can currently restore. Confirm that:

- the connection uses the same host user and home directory as the original process
- the Cloudflare bridge id or Fly API id still exists in host configuration
- host credentials are available to the restarted process
- the target sandbox, Sprite, or local directory still exists
- the session was created on this host rather than another machine with a different store

Do not edit the session JSON to change environment identity. Restore the owning configuration or target instead.

### WebSocket attachment is unauthorized

Verify that server and client use the same token and that a reverse proxy preserves the WebSocket request path and query string. `TAU_WS_AUTH_TOKEN` can silently supply either side, so inspect the environment as well as command-line flags. Do not print the token in shared logs.

### SSH attachment fails before the TUI opens

Run the remote command directly and confirm that `tau rpc` is installed and can start. Protocol stdout must contain only NDJSON. Login banners, shell startup output, or wrapper diagnostics on stdout corrupt the transport; redirect them to stderr or remove them.

### A reconnect shows an interrupted turn

A client disconnect alone does not stop a WebSocket-hosted turn, but server shutdown does. Stdio/SSH attachment shutdown also ends its host. Review the last assistant and tool states, verify the execution environment with `!!pwd` and `!!git status --short`, then retry or resume a blocked goal intentionally. [Sessions](sessions.md) explains recovery and safe verification.
