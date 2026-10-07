# Ownership and scope

Tau splits a session into three parts: the terminal or other interface you use, the host that runs the session, and the machine the agent works on. They stay separate even when all three run in one process. Know which part owns a path or setting before you change it. In an attached session, “local” can mean any of three machines.

## The four operating roles

### Client

The **client** is the interface attached to a session host. The terminal client owns the TUI, editor state, terminal colors, active theme, local speech commands, the diff-review process, and configured command client tools. An SDK program or Telegram adapter can also be a client.

Client tools run on the client machine, which may differ from the machine where the agent's Bash tool runs. Client configuration is found from the client's startup working directory and home.

### Host

The **host** creates, observes, persists, and recovers sessions. It owns model calls, credentials, session orchestration, tool binding, history storage, and execution-environment lifecycle. Local `tau` creates an in-process host. `tau serve` is the standalone host entry point.

Session snapshots, authentication storage, usage logs, and the local history database live in the host user's home. Manage them with Tau commands and session operations. Do not edit their files directly.

MCP connections belong to the host. Configure servers on the host. Stdio servers run there, with the host's credentials and access to the host's resources. They do not run in the session's execution environment.

The built-in `tau_docs` tool also belongs to the host. It reads the documentation installed with the host's Tau version.

### Execution environment

The **execution environment** is the machine the agent can act on. It owns the agent-visible working directory (`cwd`), home, platform, environment, filesystem, processes, project repository, project configuration and content, `AGENTS.md` files, skills, and command resolution.

Tau reads files and runs commands through the execution environment, even when it is on the same machine as the host. Each session has exactly one execution environment. Paths shown to the agent and paths passed to its tools are always paths on that environment.

### Telegram runner

The **Telegram runner** owns Telegram polling, chat routing, attachments, outbound messages, project selection, and Telegram-specific persisted runner state. It is a client of in-process Tau sessions and starts their host on the runner machine.

For repository and composite projects it prepares managed workspaces. A persistent-directory project reuses the configured directory. Each workspace becomes the local execution environment of its session. The file passed to `tau telegram --config-file` is runner configuration. It is not one of Tau's `config.json` levels.

## Where each mode runs

| Mode | Client | Host | Execution environment |
| --- | --- | --- | --- |
| `tau` | Local TUI process | In-process on the same machine | Local `cwd` where Tau started |
| `tau attach … ws://…` | Machine running `tau attach` | Machine running `tau serve` | Environment selected or restored by that host |
| `tau serve` | A separate protocol client | The server process | Local or configured hosted environment chosen by the client |
| Default Node SDK client | SDK caller | In-process with the SDK caller | Usually a local environment supplied at session creation |
| SDK over WebSocket | SDK caller | Remote server | Environment selected or restored by that host |
| `tau telegram` | Telegram runner | In-process on the runner machine | Prepared project workspace or persistent directory |

A Fly Sprite puts the execution environment on another machine while the host stays on its own. The host keeps the provider credentials and runs the session. The Sprite owns its paths and commands.

## Who owns common paths and behavior

| Resource or behavior | Owner | Consequence |
| --- | --- | --- |
| Agent `cwd`, home, repository, files, and commands | Execution environment | Use target paths in prompts, `session.create`, and agent tool calls. |
| `.tau/config.json`, personas, prompts, skills, and `AGENTS.md` used by a session | Execution environment | Edit them on the target and relative to the session `cwd`. |
| Global runtime content for a session | Execution-environment home | `~/.config/tau` is the target user's home when runtime content is collected. |
| Model and host-tool credentials | Host | Set environment secrets where the host process runs. API keys come from the host environment or private global host configuration. |
| Codex OAuth accounts | Host home | Run `tau auth …` on the host machine. Do not edit auth storage. |
| Session snapshots | Host home | Local defaults live under the host's Tau config directory. Do not edit session files. |
| Local transcript history and remote history outbox | Host home | History follows the host, not an attached TUI or execution target. |
| Terminal theme and `/theme` | TUI client | An attached client selects from Tau’s built-in themes. Themes are not session state. |
| `/diff` process | TUI client | Tau’s built-in browser tool runs on the client machine. Repository capture still runs through the session execution environment. |
| Configured command client tools | Owning client | Commands and their environment are on the client. File access they make on behalf of the session goes to the execution environment. |
| `/listen` and `/speak` capture or playback | TUI client | Required programs, devices, and media credentials belong on the client machine. |
| Host execution-environment targets | Host startup | Fly Sprite connection settings must be in the host's configuration before it accepts sessions that use them. |
| Telegram bot token, routing, workspaces, and generated runner state | Telegram runner | Manage these through the Telegram config and runner commands, not project `config.json`. |

## Decide where to edit configuration

Start from the behavior that consumes the setting:

1. If it changes what the agent sees or can do in the project, edit configuration or content in the execution environment's discovery path.
2. If it changes the TUI's theme, speech, or command client tools, edit the TUI client's configuration and restart that client.
3. If it changes credentials, session storage, remote history, or hosted execution environment connections, set it for the host process and restart the host when required.
4. If it changes Telegram routing or workspace preparation, edit the runner's `--config-file` on the runner machine.

For a local `tau` session these locations are often the same home and repository. Following the ownership rule anyway means the configuration still works when the session becomes remote.

## A remote configuration example

Suppose a laptop runs:

```sh
tau attach --new --cwd /srv/ledger ws://devbox.example:8787
```

The host and its local execution environment resolve `/srv/ledger`. Project personas and `.tau/config.json` are read from `/srv/ledger` and its parent directories on `devbox.example`. The laptop's current directory has no effect on the session.

The laptop still loads its own theme and command client tools before attaching. `/diff` launches Tau’s built-in browser tool on the laptop. Git snapshot commands for the review run through the session and therefore see `/srv/ledger` on the execution environment.

The host on `devbox.example` makes the model calls, so it needs the provider credential. Export the provider's environment variable for `tau serve` there, or put the key in that host's global configuration. Setting it only in the laptop shell does not reach the remote host.

## Home has a boundary too

Tau includes global configuration only when the relevant `cwd` is the home directory or inside it. For session configuration, both the `cwd` and the home are on the execution environment. For client startup configuration, both are on the client.

This matters when a remote or hosted environment uses a project outside its home. Tau then reads project levels up to the filesystem root but does not add `~/.config/tau`, from that machine or any other.

## What `tau_docs` can and cannot tell you

`tau_docs` reads the documentation installed with the host. It can explain valid fields, paths, precedence, and supported behavior for that host's Tau version.

It cannot see effective configuration, environment variables, loaded client tools, the active TUI theme, the versions of attached clients, or files on a client machine. An attached client can run a different Tau version from the host. For client questions, use client commands and look on the client machine. For questions about the running session, use the warnings the session reports or inspect the host.

See [configuration](configuration.md) for level discovery and change boundaries, [remote sessions](remote-sessions.md) for attach and server operation, and [security](security.md) for trust implications.
