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
tau async <prompt...>
tau async -- <prompt...>
tau async list
tau async status <sessionId>
tau async logs <sessionId>
tau async send <sessionId> <text...>
tau async interrupt <sessionId>
tau async cron list
tau async cron runs [jobId]
tau async cron run <jobId>
```

Client target options:

- `--target <id>`: select a configured target from `config.async.client.targets`
- `--url <url>`: override target base URL
- `--token <token>`: override bearer token

Project id for `tau async <prompt...>` resolves in this order:

- `--project <id>`
- `async.client.defaultProjectId` from config

Use `--` when prompt text starts with a reserved command word.

## client config (`~/.config/tau/config.json` or `.tau/config.json`)

Client-side async config stays in the regular tau config:

```json
{
  "async": {
    "client": {
      "defaultTarget": "local",
      "defaultProjectId": "tau",
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
  "systemMessage": "follow project conventions and keep diffs minimal",
  "cron": {
    "systemMessage": "you are running from a scheduled cron job, prioritize deterministic output",
    "jobsDir": "cron-jobs"
  },
  "telegram": {
    "ops": {
      "botToken": "123456:telegram-token",
      "allowedProjectIds": ["tau"],
      "allowedUserIds": [123456789],
      "allowedChatIds": [123456789],
      "defaultProjectId": "tau",
      "systemMessage": "you are operating via Telegram, keep replies concise",
      "pollIntervalMs": 1000,
      "requestTimeoutSeconds": 30
    }
  },
  "projects": {
    "tau": {
      "repo": "markusylisiurunen/tau",
      "ref": "main",
      "workspaceRoot": "projects/tau",
      "workingDirectory": "packages/core",
      "description": "core runtime workspace",
      "bootstrapCommands": ["npm ci"],
      "backgroundBootstrapCommands": ["npm run build"],
      "persona": "gpt-5.2-coder",
      "riskLevel": "read-only",
      "sandbox": false,
      "noAgentContextFiles": false
    }
  }
}
```

Cron jobs are loaded from markdown files under `cron.jobsDir`.

Example `cron-jobs/docs-drift-nightly.md`:

```md
---
id: docs-drift-nightly
projectId: tau
schedule: "0 2 * * *"
---

check for documentation drift and fix/update mismatches
```

Notes:

- `projects.<id>.repo` must be GitHub `owner/repo` format.
- Relative `workspaceRoot` values resolve from the daemon config file directory.
- `projects.<id>.workingDirectory` must be a relative path inside the cloned repository.
- Tau starts each async session from `workingDirectory` when configured, otherwise from the repo root.
- `bootstrapCommands` run from the same session working directory and block readiness.
- `backgroundBootstrapCommands` run from the same session working directory after the session is ready and do not block readiness.
- failing `backgroundBootstrapCommands` are logged as warnings, but the session remains available.
- `projects.<id>.ref` is optional, but recommended (for example `"main"`) when every session should start from the same branch.
- `projects.<id>.description` is optional metadata used by Telegram `/projects` output.
- Clone uses `gh repo clone <owner/repo> <path>` (daemon host must have authenticated `gh`).
- On daemon startup, Tau removes existing entries under all configured workspace roots (`workspaceRoot` plus any `projects.<id>.workspaceRoot` overrides) before starting adapters.
- On Telegram adapter startup, Tau also prunes stale `tau-telegram-attachments-*` directories under the system temp directory.
- `cron.jobsDir` is optional and points to a directory of `*.md` cron job files.
- each cron job markdown file requires frontmatter fields `id`, `projectId`, and `schedule`; the markdown body is used as the prompt.
- frontmatter `id` must match the markdown file name.
- optional frontmatter `enabled: false` disables a cron job file without deleting it.
- `schedule` uses 5-field cron syntax (`minute hour day-of-month month day-of-week`) in daemon local time.
- cron jobs create a new async session and submit the markdown body as the initial message when the schedule matches.
- `cron.systemMessage` is appended after `systemMessage` for cron-originated runs only, within the same `<system>...</system>` block.
- `TAU_ASYNC_AUTH_TOKEN` overrides daemon-file `authToken`.
- `systemMessage` is prepended to every submitted prompt inside a `<system>...</system>` block.
- `telegram.<botId>.systemMessage` is appended after `systemMessage` for Telegram-originated messages only, within the same `<system>...</system>` block.
- legacy single-bot config is still supported with `telegram.botToken` (or other bot fields directly under `telegram`). It is normalized as bot id `default`.

## http api

Base URL: `http://<host>:<port>`

- `GET /healthz` (no auth)
- `POST /v1/sessions`
- `GET /v1/sessions`
- `GET /v1/sessions/:sessionId`
- `GET /v1/sessions/:sessionId/logs`
- `POST /v1/sessions/:sessionId/messages`
- `POST /v1/sessions/:sessionId/interrupt`
- `GET /v1/cron/jobs`
- `GET /v1/cron/runs?jobId=<id>&limit=<n>`
- `POST /v1/cron/jobs/:jobId/run`

Requests under `/v1/*` require:

```http
Authorization: Bearer <token>
```

Bearer tokens are checked with constant-time comparison. Missing/invalid tokens return `401`.

## telegram dm adapter

Enable Telegram by setting at least one bot token in daemon config and running the daemon.

Use either format:

- single bot (legacy): `telegram.botToken`
- multiple bots: `telegram.<botId>.botToken`

The adapter uses long-polling and only handles private DM messages (`chat.type=private`).

Supported DM commands:

- `/help` (shows command usage and examples)
- `/new [projectId]`
  - starts a new empty session (does not accept inline prompt text)
  - if `projectId` is omitted, it uses `defaultProjectId` when set
  - otherwise it auto-selects when exactly one async project exists
  - use `/projects` to discover available `projectId` values
- `/projects` (lists configured async projects with optional descriptions)
- `/use <sessionId|prefix|index>`
  - accepts exact IDs, unique session ID prefixes, and 1-based indexes from `/sessions`
- `/sessions` (lists sessions with active marker, state, project, and recent previews)
  - includes inline session picker buttons
  - includes quick-action buttons (`/new`, `/sessions`, `/status`, `/interrupt`, `/close`, `/quiet`, `/verbose`)
- `/status`
- `/interrupt` (interrupts the active run, keeps the session available for new messages)
- `/close` (closes the selected session and deletes its workspace from disk)
- `/close <sessionId>` (closes a specific session and deletes its workspace from disk)
- `/close all` (closes sessions in `waiting-input` or `failed`, and deletes their workspaces)
- `/verbose` (for the selected session, streams run lifecycle + progress updates)
- `/quiet` (for the selected session, default mode, send only the run's final assistant message)
- plain text sends to the selected session (if no active session is selected and exactly one session exists, it is auto-selected)
- Telegram `voice` and `audio` messages are downloaded, transcribed with Mistral, and then sent to the selected session
- attachments (`image/*`, PDF, `.txt`, `.md`, `.json`, `.csv`, `.yaml`, `.yml`) are downloaded to local temp files immediately, queued per session, and prepended to the next text/voice turn as local temp paths with mime, size, and caption metadata
  - attachment-only messages do not trigger a turn
  - captions are non-triggering and are preserved in the attachment metadata block
  - unsupported attachments and over-limit attachments are skipped with an immediate Telegram warning
  - limits: 10 attachments/turn, 20 MB/file, 50 MB/turn

Telegram audio transcription requires `MISTRAL_API_KEY` (or `apiKeys.mistral` in regular tau config).

When a plain-text or audio message is accepted for a session, the adapter tries to add a 👀 reaction to that user message (best effort).

The adapter registers these commands via Telegram's command list so clients can autocomplete them.

Optional per-bot allowlists:

- `allowedProjectIds` (limits the projects and sessions visible to that bot)
- `allowedUserIds`
- `allowedChatIds`

If `allowedProjectIds` is omitted, the bot can access all async projects.
Sessions are bot-scoped: each bot can only see and control sessions it created, even for the same project.
If `allowedUserIds` and `allowedChatIds` are provided, both must match for a DM to be processed.

Telegram keeps one selected session per chat for command and plain-text input routing, but it continues
streaming events for every session that has been selected in that chat.

Lifecycle notifications are sent back to associated chats:

- `session is being prepared` (after `/new`)
- `session is ready` (when workspace + client are ready)
- `run failed`

In `/verbose` mode, run updates also include:

- `run started`
- `run finished`
- each bash command (`bash command`)
- each successful edit call (`edited file`)
- each successful write call (`wrote file`)
- each assistant final message for the current run (`assistant message`)

In `/quiet` mode, these streamed updates are suppressed and only the run's final assistant message is sent when the run completes. The immediate `(sessionId) message queued` acknowledgement is also suppressed in quiet mode.

## persistence model

Async daemon state is in-memory only:

- session records
- session logs
- Telegram chat routing (selected session per chat)
- Telegram chat-to-session associations for multiplexed event streaming
- Telegram per-session state (verbosity mode, last command, last assistant message)

Restarting the daemon clears this state. Existing cloned workspaces on disk are not reused as daemon session state.
