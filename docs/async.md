# async daemon and client

Tau includes an async daemon for queueing long-running sessions over HTTP, plus a CLI client.

## commands

Start the daemon with a dedicated daemon config file:

```sh
tau async daemon --config-file /etc/tau/async-daemon.json
```

Client commands:

```sh
tau async --project <projectId> <prompt...>
tau async -- <prompt...>
tau async list
tau async status <sessionId>
tau async logs <sessionId>
tau async send <sessionId> <text...>
tau async cancel <sessionId>
```

Client target options:

- `--target <id>`: select a configured target from `config.async.client.targets`
- `--url <url>`: override target base URL
- `--token <token>`: override bearer token

Use `--` when prompt text starts with a reserved command word.

## client config (`~/.config/tau/config.json` or `.tau/config.json`)

Client-side async config stays in the regular tau config:

```json
{
  "async": {
    "client": {
      "defaultTarget": "local",
      "targets": {
        "local": {
          "url": "http://127.0.0.1:7788",
          "token": "replace-me",
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

## daemon config file (`--config-file`)

Daemon-side settings are loaded from a separate JSON file.

```json
{
  "host": "127.0.0.1",
  "port": 7788,
  "authToken": "replace-me",
  "maxSessions": 4,
  "workspaceRoot": "/var/lib/tau/async-workspaces",
  "telegram": {
    "botToken": "123456:telegram-token",
    "allowedUserIds": [123456789],
    "allowedChatIds": [123456789],
    "defaultProjectId": "tau",
    "pollIntervalMs": 1000,
    "requestTimeoutSeconds": 30
  },
  "projects": {
    "tau": {
      "repo": "markusylisiurunen/tau",
      "ref": "main",
      "workspaceRoot": "projects/tau",
      "bootstrapCommands": ["npm ci", "npm run build"],
      "persona": "gpt-5.2-coder",
      "riskLevel": "read-only",
      "sandbox": false,
      "noAgentContextFiles": false
    }
  }
}
```

Notes:

- `projects.<id>.repo` must be GitHub `owner/repo` format.
- Relative `workspaceRoot` values resolve from the daemon config file directory.
- Clone uses `gh repo clone <owner/repo> <path>` (daemon host must have authenticated `gh`).
- `TAU_ASYNC_AUTH_TOKEN` overrides daemon-file `authToken`.

## http api

Base URL: `http://<host>:<port>`

- `GET /healthz` (no auth)
- `POST /v1/sessions`
- `GET /v1/sessions`
- `GET /v1/sessions/:sessionId`
- `GET /v1/sessions/:sessionId/logs`
- `POST /v1/sessions/:sessionId/messages`
- `POST /v1/sessions/:sessionId/cancel`

Requests under `/v1/*` require:

```http
Authorization: Bearer <token>
```

Bearer tokens are checked with constant-time comparison. Missing/invalid tokens return `401`.

## telegram dm adapter

Enable Telegram by setting `telegram.botToken` in daemon config and running the daemon.

The adapter uses long-polling and only handles private DM messages (`chat.type=private`).

Supported DM commands:

- `/new <projectId> <prompt...>`
  - if `projectId` is omitted, it uses `defaultProjectId` when set
  - otherwise it auto-selects when exactly one async project exists
- `/use <sessionId>`
- `/list`
- `/status`
- `/cancel`
- plain text sends to the active session

Optional allowlists:

- `allowedUserIds`
- `allowedChatIds`

If provided, both must match for a DM to be processed.

Lifecycle notifications are sent back to associated chats:

- `accepted`
- `started`
- `finished`
- `failed`
- `canceled`

## persistence model

Async daemon state is in-memory only:

- session records
- session logs
- Telegram chat routing (`chatId -> activeSessionId`)

Restarting the daemon clears this state. Existing cloned workspaces on disk are not reused as daemon session state.
