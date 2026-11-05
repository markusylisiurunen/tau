# How Tau works

A Tau session has three parts. They can share one machine, but each can also run on a different one:

- The **client** is what you interact with: the TUI, an SDK program, or the Telegram runner. It owns drafts, themes, speech, the diff review interface, and client tools.
- The **host** runs the session. It makes model calls, holds credentials, and saves sessions and history in its user's home.
- The **execution environment** is the machine the agent acts on. It holds the working directory, files, commands, project configuration, `AGENTS.md`, personas, and skills.

Each session has one execution environment, fixed when the session is created. Paths in prompts and tool calls are paths on that environment.

## Where each mode runs

| Mode | Client | Host | Execution environment |
| --- | --- | --- | --- |
| `tau` | Local TUI | Same process | Current directory |
| `tau attach` | Attaching machine | Machine running `tau serve` | Directory on the host, or a Fly Sprite |
| Node SDK, default client | Your program | Same process | Usually a local directory |
| Node SDK over WebSocket | Your program | Machine running `tau serve` | Directory on the host, or a Fly Sprite |
| `tau telegram` | Telegram runner | Same process | Project workspace on the runner machine |

## Where to put a setting

| You want to change | Change it on | Then |
| --- | --- | --- |
| Project config, personas, prompts, skills, `AGENTS.md` | Execution environment | `/reload` while idle |
| MCP servers | Execution environment, for local sessions (they run on the host) | New session |
| Theme, voice, recording shortcut, client tools | Client | Restart the client |
| API keys and service credentials used by the agent | Host | Restart the host |
| `tau auth` accounts | Host | Nothing, later requests use them |
| Fly Sprite connection, remote history | Host | Restart the host |
| Telegram bots, projects, and routing | Runner's `--config-file` | Restart the runner |

Suppose a laptop runs this:

```sh
tau attach --new --cwd /srv/ledger ws://devbox.example:8787
```

Project configuration comes from `/srv/ledger` on `devbox.example`, and `!pwd` prints `/srv/ledger`. Model calls run on `devbox.example`, so a key exported only on the laptop has no effect. The theme comes from the laptop, and `/diff` opens its browser tool there.

## What a session keeps

The host saves each session under `~/.config/tau/sessions` and recovers it after a restart. Running processes and subagents do not survive a restart. See [sessions](sessions.md).

Never edit Tau's own state by hand: `~/.config/tau/auth.json`, `models-store.json`, `sessions/`, `history.sqlite`, or Telegram runner state files. Use Tau's commands instead.

## Global configuration and home

Tau reads global configuration (`~/.config/tau`) only when the working directory is the home directory or below it, on that same machine. A project outside home therefore gets project levels only.

## What the agent's documentation covers

`tau_docs` reads the manual installed with the host. It cannot see effective configuration, environment variables, or anything on the client. An attached client can run a different Tau version, but the protocol version must match, so upgrade client and host together.
