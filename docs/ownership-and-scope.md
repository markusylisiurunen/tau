# Ownership and scope

Tau separates terminal interaction, session orchestration, and agent-visible execution even when all three happen in one process. This is the most important fact to establish before changing a path or configuration file. In an attached session, “local” can refer to three different machines.

## The four operating roles

### Client

The **client** is the interface attached to a session host. The terminal client owns the TUI, editor state, terminal colors, active theme, local speech commands, the diff-review process, and configured command client tools. An SDK program or Telegram adapter can also be a client.

Client tools execute on the client machine, not wherever the agent's Bash tool runs. Client-local configuration is discovered from the client's startup working directory and home.

### Host

The **host** creates, observes, persists, and recovers sessions. It owns model calls, credentials, session orchestration, tool binding, history storage, and execution-environment lifecycle. Local `tau` creates an in-process host. `tau serve` is the standalone host entry point.

The host's home owns data such as session snapshots, authentication storage, usage logs, and the local history database. Use Tau commands and session operations to manage these stores rather than editing their files directly.

The intrinsic `tau_docs` tool is also host-owned. It reads documentation packaged with the installed host version.

### Execution environment

The **execution environment** is the machine the agent can act on. It owns the agent-visible working directory (`cwd`), home, platform, environment, filesystem, processes, project repository, project configuration and content, `AGENTS.md` files, model overlays, skills, and command resolution.

Tau asks the execution environment to read or execute against those resources. The host must not treat its own filesystem as a shortcut, even when a local execution environment happens to share it.

A session has one authoritative execution-environment snapshot. Paths shown to the agent and paths passed to agent tools are execution-environment paths.

### Telegram runner

The **Telegram runner** owns Telegram polling, chat routing, attachments, outbound messages, project selection, and Telegram-specific persisted runner state. It is a client of local in-process Tau sessions and also starts their host on the runner machine.

For repository and composite projects it prepares managed workspaces. A configured persistent directory project reuses the specified directory. Those workspaces become local execution environments for their sessions. The separate file passed to `tau telegram --config-file` is runner configuration, not a Tau `config.json` level.

## Where each mode runs

| Mode | Client | Host | Execution environment |
| --- | --- | --- | --- |
| `tau` | Local TUI process | In-process on the same machine | Local `cwd` where Tau started |
| `tau attach … ws://…` | Machine running `tau attach` | Machine running `tau serve` | Environment selected or restored by that host |
| `tau attach … -- <command>` | Machine running `tau attach` | Machine running the protocol command, often reached through SSH | Environment selected or restored by that host |
| `tau serve` | A separate protocol client | The server process | Local or configured hosted environment chosen by the client |
| Default Node SDK client | SDK caller | In-process with the SDK caller | Usually a local environment supplied at session creation |
| SDK over WebSocket | SDK caller | Remote server | Environment selected or restored by that host |
| `tau telegram` | Telegram runner | In-process on the runner machine | Prepared project workspace or persistent directory |

A Cloudflare Sandbox or Fly Sprite can place the execution environment on another target while the host stays on its own machine. The host keeps provider credentials and orchestration authority; the target owns its paths and commands.

## Who owns common paths and behavior

| Resource or behavior | Canonical owner | Consequence |
| --- | --- | --- |
| Agent `cwd`, home, repository, files, and commands | Execution environment | Use target paths in prompts, `session.create`, and agent tool calls. |
| `.tau/config.json`, `.tau/models.json`, personas, prompts, skills, and `AGENTS.md` used by a session | Execution environment | Edit them on the target and relative to the session `cwd`. |
| Global runtime content for a session | Execution-environment home | `~/.config/tau` is the target user's home when runtime content is collected. |
| Model and host-tool credentials | Host | Set environment secrets where the host process runs. Runtime `apiKeys` may be loaded from execution-environment config and consumed by the host. |
| Codex OAuth accounts | Host home | Run `tau auth …` on the host machine. Do not edit auth storage. |
| Session snapshots | Host home | Local defaults live under the host's Tau config directory. Do not edit session files. |
| Local transcript history and remote history outbox | Host home | History follows the host, not an attached TUI or execution target. |
| Terminal theme and `/theme` | TUI client | An attached client uses themes loaded on the client machine. Themes are not session state. |
| `/diff` process | TUI client | `diffTool.command` must exist on the client machine. Repository capture still runs through the session execution environment. |
| Configured command client tools | Owning client | Commands and their environment are client-local; their execution-environment facade reaches the session target explicitly. |
| `/listen` and `/speak` capture or playback | TUI client | Required programs, devices, and media credentials belong on the client machine. |
| Host execution-environment targets | Host startup | Cloudflare bridge and Fly Sprite API definitions must be available to the host before it accepts sessions using them. |
| Telegram bot token, routing, workspaces, and generated runner state | Telegram runner | Manage these through the Telegram config and runner commands, not project `config.json`. |

## Decide where to edit configuration

Start from the behavior that consumes the setting:

1. If it changes what the agent sees or can do in the project, edit configuration or content in the execution environment's discovery path.
2. If it changes terminal rendering, `/diff`, `/listen`, or a command client tool, edit the TUI client's configuration and restart that client.
3. If it changes credentials, session persistence, remote history, or available hosted-environment resolvers, edit or export it for the host process and restart the host when required.
4. If it changes Telegram routing or workspace preparation, edit the runner's `--config-file` on the runner machine.

For a local `tau` session these locations often collapse to one home and repository. The ownership rule still predicts remote behavior and prevents configuration from being placed on the wrong machine.

## A remote configuration example

Suppose a laptop runs:

```sh
tau attach --new --cwd /srv/ledger ws://devbox.example:8787
```

The path `/srv/ledger` is interpreted by the host and its local execution environment. Project personas and `.tau/config.json` are read from `/srv/ledger` and its ancestors on `devbox.example`. The laptop's current directory does not influence that session runtime.

The laptop still loads its own theme, `diffTool`, and command client tools before attaching. If `/diff` launches `review-ui`, that executable must exist on the laptop. Git snapshot commands for the review run through the session and therefore see `/srv/ledger` on the execution environment.

If the selected persona needs a provider credential, the host on `devbox.example` makes the model call. Export the provider environment variable for `tau serve` there, or make the appropriate runtime configuration available to that host. Setting it only in the laptop shell does not authenticate the remote host.

## Home has a boundary too

Tau includes global configuration only when the relevant `cwd` is equal to or below that component's home. For execution runtime discovery, both values belong to the execution environment. For client-local startup discovery, they belong to the client.

This matters when a remote or hosted environment uses a project outside its configured home. In that case Tau walks project levels to the filesystem root but does not inject `~/.config/tau` from some other machine or home.

## What `tau_docs` can and cannot tell you

`tau_docs` documents contracts shipped with the host. It can explain valid fields, paths, precedence, and supported behavior for that installed host version.

It cannot inspect effective configuration, current environment variables, loaded client tools, the active TUI theme, attached-client versions, or files on a client machine. An attached client can be a different Tau version from the host. Use client commands and direct inspection on the owning machine for client-local questions, and use session-visible warnings or host-side inspection for effective runtime questions.

See [configuration](configuration.md) for level discovery and change boundaries, [remote sessions](remote-sessions.md) for attach and server operation, and [security](security.md) for trust implications.
