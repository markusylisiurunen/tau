# Remote sessions

In a remote session, the terminal stays on your machine while the host and the agent's work run elsewhere. Read [how Tau works](how-tau-works.md) first for which machine owns what.

## Start a host

```sh
tau serve
```

It listens on `127.0.0.1:8787` with no authentication. The simplest secure setup keeps it there and uses an SSH tunnel:

```sh
ssh -N -L 8787:127.0.0.1:8787 dev@buildbox.example
tau attach ws://127.0.0.1:8787
```

To listen on another interface, require a token:

```sh
export TAU_WS_AUTH_TOKEN="$(openssl rand -hex 32)"
tau serve --host 0.0.0.0 --port 8787
```

`tau attach` reads the same variable, or takes `--auth-token`. The token gives full access to every session. Tau has no TLS, so across an untrusted network use an SSH tunnel or a TLS reverse proxy with `wss://`. A proxy must pass the WebSocket upgrade and the query string, which carries the token as `tau_token`, so keep it out of the logs.

Set the default persona for new sessions when starting the host, with `tau serve --persona opus-5.5-coder`, or switch with `/persona:<id>` after attaching.

## Attach

```sh
tau attach ws://127.0.0.1:8787
tau attach --session 0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3 ws://127.0.0.1:8787
tau attach --new --cwd /srv/workspaces/tau ws://127.0.0.1:8787
```

The first form opens a selector and needs a terminal. `--new` needs an absolute `--cwd` that already exists in the execution environment, and for the default `local` kind that is a path on the host. Tau does not create directories or clone repositories.

## Fly Sprites

A session can work on an existing Fly Sprite while the host stays on its own machine. Configure the connection in the host's configuration before starting it:

```json
{
  "flySprites": {
    "tokenEnv": "FLY_SPRITES_TOKEN"
  }
}
```

```sh
tau attach --new \
  --execution-kind fly-sprite --fly-sprite tau-build-7 \
  --cwd /home/sprite/tau \
  wss://tau.example.com
```

Tau does not create the Sprite or prepare its repository. Project configuration comes from the working directory inside the Sprite. Sessions on a Sprite have no [MCP servers](mcp.md).

## Disconnecting and reconnecting

A client disconnecting leaves work running, and you can reattach with the same session ID. The host unloads a session from memory after the last client has left and work has finished, and keeps it saved.

Shutting down `tau serve` interrupts running work and saves sessions. They come back idle after a restart, without pending messages or subagents. See [sessions](sessions.md).

## Several clients

Several clients can observe one session and see the same updates. Each of them can also submit, steer, interrupt, or change it, so agree on who is in charge. Only one client can offer a given tool name, so start the others without client tools:

```sh
tau attach --no-client-tools --session <id> ws://host.example:8787
```

## Upgrades

Client and host must use the same protocol version, and there is no negotiation. Upgrade both to the same release and restart both. Do not downgrade a host, because older versions cannot read sessions saved by newer ones.

The agent's tools and documentation come from the host's installation, and TUI behavior comes from the client's.
