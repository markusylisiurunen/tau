# Telegram runner

Tau includes a Telegram runner for driving local in-process Tau SDK sessions from Telegram messages.

## command

Start the runner with a dedicated config file:

```sh
tau telegram --config-file /etc/tau/telegram.json
```

The process runs in the foreground until interrupted.

## config file

Telegram runner settings are loaded from the JSON file passed to `--config-file`.

```json
{
  "workspaceRoot": "/var/lib/tau/telegram-workspaces",
  "systemMessage": "follow project conventions and keep replies concise",
  "bots": {
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
      "persona": "gpt-5.5-coder",
      "riskLevel": "read-only",
      "noAgentContextFiles": false
    }
  }
}
```

for `projects.<id>.persona`, use `<id>` or `<id>:<reasoning>`.

Notes:

- `projects.<id>.repo` must be GitHub `owner/repo` format.
- Relative `workspaceRoot` values resolve from the Telegram config file directory.
- `projects.<id>.workingDirectory` must be a relative path inside the cloned repository.
- Tau starts each Telegram session from `workingDirectory` when configured, otherwise from the repo root.
- `bootstrapCommands` run from the same session working directory and block readiness.
- `backgroundBootstrapCommands` run from the same session working directory after a new or reconstructed workspace is ready and do not block readiness.
- Preserved workspaces skip both bootstrap command lists during runner restart recovery.
- failing `backgroundBootstrapCommands` are logged as warnings, but the session remains available.
- `projects.<id>.ref` is optional, but recommended when every session should start from the same branch.
- Repositories use an automatic persistent bare cache at `<workspaceRoot>-repo-cache/<projectId>.git`: the first session initializes it with `gh repo clone <owner/repo> <cache> -- --bare`, later sessions run `git fetch --prune origin`, then each session workspace is cloned from the local cache with `git clone --shared`.
- Tau persists Telegram session records at `<workspaceRoot>-sessions.json`. Runner startup removes workspace-root entries that are not referenced by persisted sessions, reconnects recoverable records to their Tau snapshots, reuses preserved session workspaces, and reconstructs a missing workspace from the repository cache before reconnecting.
- On Telegram adapter startup, Tau also prunes stale `tau-telegram-attachments-*` directories under the system temp directory.
- `systemMessage` is prepended to every submitted Telegram message inside a `<system>...</system>` block.
- `bots.<botId>.systemMessage` is appended after `systemMessage` for Telegram-originated messages only, within the same `<system>...</system>` block.

## Telegram behavior

Supported slash commands:

- `/new` creates a new session for the chat. If the chat already has an active session, the old session is closed and its workspace is cleaned up. `/new` uses `bots.<botId>.defaultProjectId` when set, otherwise it auto-selects when exactly one project is available to that bot.
- `/status` returns a short natural-language paragraph about the active session, including model, reasoning effort, context usage, and cumulative cost when session details are available.
- `/interrupt` interrupts the active run.

The runner uses quiet mode for tool and lifecycle progress: it does not send tool or lifecycle progress messages to Telegram. It does send assistant messages as they are committed, so one active run can send multiple assistant progress updates before it finishes. While a run is active, it refreshes Telegram's typing indicator in DMs and groups. Assistant messages are sent as Telegram rich markdown.

DM and group behavior matches the previous Telegram adapter:

- in DMs, plain text sends to the active session. If no active session exists and exactly one session exists for the chat, it is auto-selected; otherwise the bot asks the user to run `/new`.
- in allowed groups, only messages that explicitly mention the bot username (`@botusername`) trigger a turn.
- non-triggering group text/caption messages, attachments, audio transcripts, and processing errors are buffered as sender-attributed context and the last 50 pending messages since the previous bot-triggering turn are included with the triggering turn.
- group commands must mention the bot, for example `/status@botusername`, `/status @botusername`, or `@botusername /status`.
- Telegram-originated text and transcribed audio use explicit steering mode: if the selected session is idle the message behaves like a normal user turn, and if the agent is already working the message is accepted and run at the next safe boundary.
- Telegram `voice` and `audio` messages are downloaded and transcribed with the configured speech-to-text provider. For direct DM turns and bot-triggering group turns, the transcript is echoed to the chat before being sent to the selected session.
- attachments (`image/*`, PDF, `.txt`, `.md`, `.json`, `.csv`, `.yaml`, `.yml`) are downloaded to local temp files immediately, queued per session, and prepended to the next text/voice turn as local temp paths with mime, size, and caption metadata.
- attachment-only messages do not trigger a turn.
- unsupported attachments and over-limit attachments are skipped with a Telegram warning.
- limits: 10 attachments/turn, 20 MB/file, 50 MB/turn.
- oversized Telegram replies are split into chunks capped at 95% of each Telegram API method's byte limit and sent 1 second apart.

Telegram audio transcription uses Mistral by default and requires `MISTRAL_API_KEY` or `apiKeys.mistral` in normal Tau config. Set `speechToText.provider` to `gemini` to use Gemini 3.5 Flash instead, with `GEMINI_API_KEY` or `apiKeys.google`.

Optional per-bot allowlists:

- `allowedProjectIds` limits the projects visible to that bot.
- `allowedUserIds` limits who can trigger turns, run commands, and use callbacks; group messages from other users can still be included as pending context.
- `allowedChatIds` enables opt-in group chats and can restrict DMs.

Sessions survive normal runner restarts and host reboots. Shutdown interrupts live work, persists running sessions as waiting for input, disconnects SDK clients, and preserves their workspaces. `/new` still closes the previous chat session and removes its workspace.
