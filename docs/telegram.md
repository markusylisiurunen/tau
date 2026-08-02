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
      "allowedProjectIds": ["tau", "cowork", "tau_cowork"],
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
      "description": "Tau terminal client",
      "persona": "gpt-5.5-coder",
      "noAgentContextFiles": false
    },
    "cowork": {
      "repo": "markusylisiurunen/cowork",
      "ref": "main",
      "description": "Cowork application"
    },
    "tau_cowork": {
      "projectIds": ["tau", "cowork"],
      "persona": "gpt-5.6-sol-coder:high",
      "description": "coordinated Tau and Cowork work",
      "instructions": "Keep changes in the two repositories coordinated."
    }
  }
}
```

Project ids must contain only lowercase letters, digits, and underscores and may be at most 28 characters, so Tau can register `/use_<projectId>` with Telegram. For `projects.<id>.persona`, use `<id>` or `<id>:<reasoning>`.

Each project is exactly one of:

- A repository project with a GitHub `owner/repo` value and optional `ref`, `workspaceRoot`, `workingDirectory`, `description`, `persona`, and `noAgentContextFiles`.
- A composite project with at least two unique repository `projectIds`, required `persona`, and optional `workspaceRoot`, `description`, and `instructions`. Composite projects cannot reference other composites.

Repository project behavior:

- Relative `workspaceRoot` values resolve from the Telegram config file directory.
- `workingDirectory` must be a relative path inside the cloned repository. Tau starts the session there when configured, otherwise at the repository root.
- An optional `.tau/scripts/provision` file must be a regular executable with a shebang. Telegram starts it through `session.exec` from the configured working directory after the session becomes ready. Provisioning is a finite setup task, but it does not block chat access; failures are reported to every linked chat while the session remains usable.
- New workspaces run provisioning once. Reconstructed missing workspaces run it again, while preserved workspaces skip it on runner restart.
- `ref` is optional, but recommended when every session should start from the same branch.
- Repositories use an automatic persistent bare cache at `<workspaceRoot>-repo-cache/<projectId>.git`: the first session initializes it with `gh repo clone <owner/repo> <cache> -- --bare`, later sessions run `git fetch --prune origin`, then each session workspace is cloned from the local cache with `git clone --shared`.

A composite session starts from a generated root containing each member in a directory named after its project id. Tau prepares members using their existing repository caches, writes a root `AGENTS.md` describing the workspace, and writes `.tau/config.json` with `agentContextFiles` for member AGENTS files from each repository root through its configured working directory. After the composite session becomes ready, each member repository's provision hook runs from that member's configured working directory. The generated root has no provision hook because it is not a repository.

Child `.tau` configuration is not merged into the main composite session. The composite's required persona is authoritative and must be available from the generated root. Subagents launched with a child repository as their working directory resolve that repository's own Tau configuration normally.

Preserved workspaces skip provision hooks during runner restart recovery. A failed member hook is reported without stopping the remaining member hooks or making the session unavailable. Synchronous composite workspace preparation remains all-or-nothing and removes the generated workspace if repository preparation fails.

Tau persists Telegram session records at `<workspaceRoot>-sessions.json` and project preferences at `<workspaceRoot>-project-preferences.json`. Runner startup removes workspace-root entries that are not referenced by persisted sessions, reconnects recoverable records to their Tau snapshots, reuses preserved session workspaces, and reconstructs a missing workspace from repository caches before reconnecting. On Telegram adapter startup, Tau also prunes stale `tau-telegram-attachments-*` directories under the system temp directory.

`systemMessage` is prepended to every submitted Telegram message inside a `<system>...</system>` block. `bots.<botId>.systemMessage` is appended after `systemMessage` for Telegram-originated messages only, within the same block.

## Telegram behavior

Supported slash commands:

- `/use_<projectId>` stores the project to use for future `/new` sessions in that Telegram DM or group. It does not create, close, or switch the active session. The preference survives runner restarts. `defaultProjectId` provides the initial preference, and a sole allowed project is selected automatically.
- `/new` closes the active session, if any, cleans its workspace, and creates its replacement using the stored project preference.
- `/status` reports the active session's project, including composite members, plus model, reasoning effort, context usage, and cumulative cost when available. If the next-session preference differs, it reports both. With no active session, it reports the current preference.
- `/compact` summarizes older conversation context to reduce context usage.
- `/interrupt` interrupts the active run.

Programmatic replies and notifications use natural-language sentences. Project and session identifiers are included in the prose rather than shown as metadata-style fields such as `project: tau`, and internal state identifiers are translated before display.

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

Telegram audio transcription uses Mistral by default and requires `MISTRAL_API_KEY` or `apiKeys.mistral` in normal Tau config. Set `speechToText.provider` to `gemini` to use Gemini 3.6 Flash instead, with `GEMINI_API_KEY` or `apiKeys.google`.

Optional per-bot allowlists:

- `allowedProjectIds` limits the projects visible to that bot.
- `allowedUserIds` limits who can trigger turns, run commands, and use callbacks; group messages from other users can still be included as pending context.
- `allowedChatIds` enables opt-in group chats and can restrict DMs.

Sessions survive normal runner restarts and host reboots. Shutdown interrupts live work, persists running sessions as waiting for input, disconnects SDK clients, and preserves their workspaces. `/new` still closes the previous chat session and removes its workspace.
