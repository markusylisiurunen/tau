# Telegram

Tau's Telegram runner connects one or more Telegram bots to Tau sessions that run in the same process. On the runner machine, it polls Telegram, routes chats, handles attachments, and prepares project workspaces. Each workspace is an ordinary local execution environment, with normal Tau configuration, personas, tools, project context, saved sessions, and history.

Anyone who can use a bot can cause model calls, file changes, and repository changes. Set up chat, user, and project limits before adding a bot to a group.

## Start the runner

Run the standalone process with one dedicated JSON file:

```sh
tau telegram --config-file /etc/tau/telegram.json
```

The process stays in the foreground until `SIGINT` or `SIGTERM`. Relative `--config-file` paths resolve from the process working directory. Paths inside that file resolve as described below, usually from the config file's directory.

Add `--check-config` to validate the file and exit without starting the runner. It does not check tokens, directories, or repository access.

The Telegram file is **not** one of Tau's `config.json` levels. It configures the runner: bot tokens, startup settings, presets, projects, workspace roots, and routing. Tau still loads normal configuration from the runner's startup directory and from each session's workspace. See [configuration](configuration.md) and [ownership and scope](ownership-and-scope.md).

Run at most one runner per configuration and workspace root. Two runners would compete for Telegram updates, runner state, and workspace cleanup.

## Minimal configuration

A useful configuration defines at least one bot and one project:

```json
{
  "workspaceRoot": "/var/lib/tau/telegram-workspaces",
  "bots": {
    "engineering": {
      "botToken": "<telegram-bot-token>",
      "startup": { "source": "workspace" },
      "allowedProjectIds": ["ledger"],
      "allowedUserIds": [18422031],
      "allowedChatIds": [18422031],
      "defaultProjectId": "ledger"
    }
  },
  "projects": {
    "ledger": {
      "repo": "acme/ledger",
      "ref": "main"
    }
  }
}
```

The bot token must be written in the file; it cannot come from an environment variable. Protect the file, never commit it, and rotate an exposed token through BotFather. Never print the config into a session or shared log.

The runner refuses to start if the file contains an unknown field, and the error names that field.

## Top-level fields

| Field | Required | Behavior |
| --- | --- | --- |
| `bots` | Yes | Non-empty object keyed by a bot ID you choose. |
| `projects` | Yes | Object keyed by project ID. Bots select from these definitions. |
| `workspaceRoot` | No | Base for managed workspaces; defaults to `.tau/telegram-workspaces` beside the Telegram config file. |
| `maxSessions` | No | Positive integer cap on active sessions across the whole runner. |

A relative `workspaceRoot` resolves from the config file's directory. Tau saves runner session records in `<workspaceRoot>-sessions.json` and per-chat preferences in `<workspaceRoot>-project-preferences.json`. These are the runner's own state files; do not edit them. Sessions are saved in the usual place in the runner user's Tau home.

`maxSessions` counts queued, preparing, running, and waiting sessions across all bots. Failed sessions do not count, but stay visible to their chat until replaced or closed.

## Bots and access control

Each `bots.<id>` object supports:

| Field | Required | Behavior |
| --- | --- | --- |
| `botToken` | Yes | Telegram Bot API token. |
| `env` | No | Environment variables for this bot's workspace preparation and new sessions. See [bot environments](telegram-projects.md#bot-environments). |
| `allowedProjectIds` | No | Non-empty unique subset of configured project IDs; omission exposes all projects. |
| `autoCompactThresholdTokens` | No | Default automatic-compaction threshold for this bot's sessions. See [compaction thresholds](#compaction-thresholds). |
| `startup` | Yes | `{ "source": "workspace" }` or `{ "source": "preset", "preset": "<key>" }`. See [startup and presets](#startup-and-presets). |
| `presets` | No | Named choices that `/persona` offers. Omission offers all workspace personas, and `{}` offers none. |
| `allowedUserIds` | No | Integer user IDs allowed to trigger turns, commands, and callbacks. |
| `allowedChatIds` | No | Integer chat IDs allowed to interact with the bot; also opts groups in. |
| `defaultProjectId` | No | Initial project preference, and must be allowed for this bot. |
| `systemMessage` | No | Additional instruction for turns from this bot. |
| `speechCleanupStyle` | No | `off` or `default`. Cleans up voice note transcripts for this bot with the [`default` style](tui.md#cleanup-styles). Defaults to `off`. |

The runner retries failed polling after 1,000 ms and uses a 30-second Telegram long-poll timeout.

A missing or empty `allowedUserIds` allows every user. A missing or empty `allowedChatIds` allows all DMs and no groups. A non-empty `allowedChatIds` allows only the listed DMs and groups. Group IDs are usually negative.

Use both lists for a private bot. `allowedUserIds` decides who can start work, but in an allowed group, messages from other users can still become context, labeled with their sender. Add the bot only to groups whose conversation is fine to send to the model.

A bot sees only its `allowedProjectIds`, or every project if the field is missing. If only one project is allowed, it is selected automatically and the command palette omits `/use_<project>` commands. The command still works when typed directly. Otherwise the palette includes project-switch commands, and a chat needs `defaultProjectId` or a `/use_<project>` choice before `/new`. Each startup replaces the palette, removing switch commands if the bot now has only one available project.

Telegram allows 100 commands per bot: ten built-ins and up to 90 `/use_<projectId>` commands. With `presets: {}`, `/persona` is hidden, which leaves room for one more project command.

## Projects

Each project tells the runner where a session works. There are three kinds:

- A **repository project** clones one GitHub repository into a new workspace for each session.
- A **persistent-directory project** reuses one existing directory for all of its sessions.
- A **composite project** combines several repository projects in one workspace.

[Telegram projects and workspaces](telegram-projects.md) describes project fields, workspace preparation, provision hooks, and recovery.

**Important:** at startup, the runner deletes everything under its managed workspace roots that no saved session uses. Give Tau a dedicated `workspaceRoot`; never use a home directory, a collection of repositories, or any directory with other content.

## Normal Tau configuration inside workspaces

After preparation, Tau creates an ordinary local session in the workspace. It reads `~/.config/tau` and the `.tau` directories above the workspace as usual, so personas, prompts, skills, project context, host tools, [MCP servers](config-reference.md#mcpservers), and other settings work as in the TUI.

The bot's `startup` selects a new session's settings, as described in [startup and presets](#startup-and-presets).

Every Telegram turn starts with a hidden `<system>` block saying the message comes from Telegram and the reply goes there. It asks for direct answers to simple questions, and for short acknowledgements or useful progress updates during longer work, because users cannot see tool activity.

Each message also carries its sender, as reported by Telegram. A DM turn gets a hidden block with the sender. In a group, the trigger message and each context message are labeled with their sender. Each queued attachment keeps the sender of the message that carried it. The sender is a JSON object with the numeric Telegram user ID and, when available, the display name and the username without the `@`, or `null` when Telegram does not identify one:

```json
{ "user-id": 123456789, "name": "Ada Lovelace", "username": "ada" }
```

The agent is told that names and usernames are chosen by the sender and do not prove identity or grant permission. Only `allowedChatIds` and `allowedUserIds` control who can use the bot.

A per-bot `systemMessage` goes in a second hidden block. Audio transcripts get another block warning that they may contain noise or errors. Hidden blocks are saved with the user's message and can appear in history, so never put credentials in configured messages.

The runner loads its speech credentials and `speech.voiceId` at startup, from its environment and from the Tau config for its startup directory. Restart the runner after changing them.

## Chat commands

Commands select projects and sessions and change a session's persona, effort, and other settings. [Telegram chat commands](telegram-commands.md) lists them and how they work in groups.

## Startup and presets

`startup` decides how a bot's new sessions start, and `presets` decides what `/persona` offers. `startup` does not add a menu entry.

`startup` is required. `{ "source": "workspace" }` uses the workspace's `defaultPersona`, found through the same configuration layers as the TUI, including any effort suffix. To start with a named preset instead:

```json
"startup": { "source": "preset", "preset": "astra" },
"presets": {
  "workspace": { "source": "workspace", "label": "Workspace default" },
  "astra": {
    "source": "persona",
    "label": "Astra",
    "persona": "gpt-6-astra-chat",
    "reasoning": "low",
    "autoCompactThresholdTokens": 120000
  }
}
```

`startup.preset` must name a key in `presets`. There are two kinds of preset:

- A `workspace` preset resolves the workspace's `defaultPersona` each time it is applied.
- A `persona` preset names a persona ID without an effort suffix. Its optional `reasoning` is one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, and defaults to the persona's own setting. Its optional `autoCompactThresholdTokens` is [described below](#compaction-thresholds).

Every preset needs a non-empty `label`. Keys must be non-empty, without surrounding whitespace. [`/persona <key>`](telegram-commands.md#choose-a-persona-effort-or-prompt) applies a preset by its key.

The choices that `/persona` offers depend on `presets`:

- Omitted: all personas available in the session's workspace, with their own labels and default settings.
- `{}`: nothing, and `/persona` is hidden from the command palette. Typing it replies that no presets are configured.
- With entries: exactly those entries, in the object's order. Integer-like keys sort first, so use non-numeric keys to keep the order you wrote.

Buttons show only labels, because a session does not record which preset was applied. `/status` reports the session's actual settings.

Applying a preset changes the prompt, model, tools, reasoning, and other persona settings together, and keeps the conversation. It applies them once, so `/effort` then changes only reasoning, and applying the preset again restores its settings.

An unavailable persona stays in the menu. Applying it, or a `reasoning` value the persona does not support, reports an error and changes no settings. The value must be in the persona's `allowedReasoningLevels` when that list is non-empty, and a model without reasoning accepts only `none`. A failing preset at `startup` fails the new session.

A workspace selection works as in the TUI: an unavailable `defaultPersona` falls back to the first available persona, and its effort suffix skips these checks.

Restart the runner after editing `startup` or `presets`. Recovery keeps a session's saved settings and does not reapply them. Reload keeps the session's settings if its persona still exists.

## Compaction thresholds

A bot's optional `autoCompactThresholdTokens` sets a default for its sessions. A persona preset's optional field of the same name sets a saved session override when the preset is applied, including at startup. Both take a safe integer of at least 50,000 tokens.

A session uses its saved override first, then the bot default, the persona default, and finally the model's context window minus 16,384 tokens. The effective threshold is capped at that model-based limit. `/auto_compact` changes the saved override. Applying a persona or preset clears the previous override unless the preset sets a threshold, even when the persona stays the same.

The runner reads the bot default at startup and does not save it with the session. Recovered sessions use the current bot default and keep their saved override.

Native subagents launched without a model use the session's effective threshold, as described in [subagents](subagents.md#automatic-compaction). Ephemeral threads use the persona's own default and ignore both the bot default and the session override.

## DMs, groups, and active work

In a DM, ordinary text goes to the active session. If none is selected but the chat has exactly one session, Tau selects it. Otherwise the bot asks for `/new`.

In an allowed group, a message starts a turn only when it mentions the bot's username. Other text and captions are kept as background context, labeled with their sender. At the next mention, Tau includes up to the 50 most recent kept messages since the last turn, and clears them once the turn is submitted.

Group context can include attachment paths, audio transcripts, and processing errors. The model receives it as untrusted input.

Text and transcribed audio either start or steer a turn. When the session is idle, the message starts a normal turn. When Tau is working, the message steers the running turn: the turn stops at its next safe point and continues with the new message. Further steering is batched as usual. Telegram has no command to queue a separate turn. Use `/interrupt` to stop instead of steering.

Tau does not report tool activity or lifecycle events. It sends assistant text, including several messages from one run, and keeps the typing indicator on during work. Long replies are split into parts. Notifications about failed, blocked, and unaccepted turns are kept until Telegram confirms delivery.

## Attachments and audio

The bot accepts any documents, photos, videos, animations, video notes, audio files, and voice notes. The agent receives the file paths in the execution environment, cleaned-up filenames, MIME types, sizes, and captions. Files are never run on receipt.

Limits are 32 attachments per turn, 20 MiB per file, and 100 MiB per turn. Downloads are limited even when Telegram does not report a size. Files that are too large or fail to download are skipped with a warning.

Sending a file only queues it, and its caption is kept as metadata. The next text or voice message starts or steers a turn, with one hidden `<system>` block per attachment. Only voice notes are transcribed, up to 20 minutes long. Audio files and audio documents arrive without a transcript. The original voice file stays available even if transcription fails. Transcripts of DMs, and of group messages that mention the bot, are echoed before submission.

Files are stored in the execution environment's temporary directory, so system cleanup can remove them. Queued files and group context are cleared on shutdown. Treat file contents and metadata as untrusted.

Voice transcription uses ElevenLabs Scribe v2 with `ELEVENLABS_API_KEY`, or else `apiKeys.elevenlabs`. Scribe detects the spoken language and transcribes in non-verbatim mode, which leaves out filler words and false starts. Optional spelling hints use GPT-6 Luna (reasoning disabled) with OpenAI credentials. The session's [`speech.vocabulary`](config-reference.md#speech) terms, then the runner's global terms, precede extracted hints and work without OpenAI credentials or conversation context. Without a selected session, Tau does not download or transcribe audio. Transcription fails if the session is not ready. Receiving files needs no ElevenLabs key. See [credentials](credentials.md).

When the bot's `speechCleanupStyle` is `default`, GPT-6.1 Terra (reasoning disabled) cleans up each transcript before it is echoed and submitted. Cleanup needs OpenAI credentials. If cleanup fails, the bot uses the transcript without cleanup. It also sends a warning, except for group audio being collected silently as context.

`/tts_on` rewrites text with `gpt-6-luna` (reasoning disabled) and generates speech with Eleven v4 Turbo. It requires both OpenAI and ElevenLabs credentials and runner `ffmpeg` with Opus. Voice notes use brisk delivery and 1.15× speed. See [`speech` configuration](config-reference.md#speech) for default and custom voice selection. Source and rewritten text are limited to 10,000 Unicode characters each, and audio to 32 MiB. Rewriting times out after one minute and the whole job after five. Jobs are not saved. On failure, the bot sends `voice response failed. please try again.`; the text reply is unaffected and details go to the logs.

## Command client tools

Telegram offers [photo, video, audio, and document delivery tools](tools.md#sending-files-to-telegram), plus the command tools selected by the workspace. Global `clientTools` define the commands, and the workspace's nearest `enabledClientTools` selects which ones are offered. An empty list turns off configured tools, but not the delivery tools.

Command processes run on the runner machine with the runner's environment. Even though the workspace is on the same machine, they reach it only through the execution-environment API. Telegram does not offer the TUI's `diff_review` or `prefill_input`.

Tools are selected when the runner creates or reconnects a session's client. `/reload` does not change them. Restart the runner, or start a new session, after changing which command tools are selected. See [client tools](client-tools.md).

## Persistence and restart behavior

Normal shutdown interrupts running work, waits for it to finish, and disconnects sessions. On restart, sessions reconnect with their conversation. A session interrupted while its workspace or Tau session was being created starts preparation again. A persistent-directory workspace is never reconstructed and must stay at its original path.

If the connection drops after a message was sent to Tau, startup checks whether Tau accepted and finished it. Work still running can be interrupted until it finishes. If Tau never accepted the message, the user is asked to resend it. Failed or blocked results stay queued until they are delivered.

Restart does not resend earlier replies. It clears voice jobs and pending retries, but keeps pending notifications.

If a failed session still has submitted work with an unknown result, Tau can reconnect to find out. Other failed sessions stay visible with their original error until their chat replaces or closes them. Do not edit runner state files to force recovery.

## Verify a runner safely

1. Run `--check-config`, without showing the file in a shared terminal.
2. Confirm the runner user can execute `tau`, `git`, and `gh`, and that `gh` can access each repository.
3. Start the runner and watch for config, polling, command-sync, cache, checkout, and recovery errors. Successful startup prints `tau telegram running`.
4. In an allowed DM, run `/status`, select a project if needed, then run `/new`.
5. Send a small, non-sensitive prompt and confirm the reply.
6. If groups are enabled, check that a message without a mention gets no reply and a command with a mention works.
7. If there is a provision hook, wait for it to finish or report a failure before relying on what it installs.
8. Restart the runner normally and use `/status` to confirm the session recovered without resending old replies.

Do not verify bot tokens, provider keys, Access secrets, transcript contents, or runner state by printing them.

## Troubleshooting

**The runner rejects its config.** Startup errors name every invalid bot or project field. Check the required `bots` and `projects` objects, exact project IDs, positive numbers, allowed project IDs, startup sources, preset references, and that each project defines exactly one of `repo`, `directory`, or `projectIds`. Check the JSON syntax without printing the file, which contains bot tokens, and restart the runner after fixing it. Relative paths in the file resolve from its directory.

**The bot ignores a DM.** If `allowedChatIds` is set, the DM's chat ID must be listed. If `allowedUserIds` is set, the sender's user ID must be listed too.

**The bot ignores a group.** The group must be in `allowedChatIds`, the message must mention the bot (commands in one of the accepted forms), and the sender must be in `allowedUserIds` when that list is set. Messages that do not mention the bot can still become context for the next turn, so make sure that is acceptable before allowing more groups.

**`/new` asks for a project, or uses the wrong one.** Set `defaultProjectId`, allow only one project, or run `/use_<projectId>` first. `/use_<projectId>` affects only future `/new` sessions; `/status` shows the current session's project and the saved choice separately.

**A message sent during work changes direction.** While a turn is running, a new message steers it instead of waiting in a queue. Wait for the turn to finish before sending an unrelated task, or use `/interrupt` first.

**Audio or an attachment fails.** The reply or runner log names the step that failed: download, saving, format, or transcription. Check that Telegram can deliver the file to the bot, the type is supported, the runner can write to its temporary directory, and ElevenLabs accepts the media type. Transcription needs `ELEVENLABS_API_KEY` or `apiKeys.elevenlabs` for the runner process; restart the runner after setting it. Changing a workspace's environment does not affect the runner. Do not log media or transcripts to debug this.

**Voice replies fail.** `/tts_on` needs OpenAI and ElevenLabs credentials and `ffmpeg` with Opus on the runner. Check [`speech.voiceId`](config-reference.md#speech) if a configured voice is unavailable.

**Replies or notifications arrive late or not at all.** Each outgoing message part has a deadline and is retried twice on retryable errors. Tau honors Telegram's `retry_after`, and later notifications in a chat wait for earlier ones. Long replies are split, so only a later part may have failed. The runner log shows the method, status, retry class, attempt, chat, session, and message. Fix network, rate-limit, token, or chat permission problems on the runner. Before resending by hand, check which parts arrived. A delivery failure is not a failed turn, and notifications about failed or blocked turns are sent again after a restart. Never fix delivery by editing runner state.

**A command client tool is missing.** Check global `clientTools`, the workspace's `enabledClientTools`, and whether the session's client was created after the change. Telegram never offers the TUI's tools.

For workspace preparation, provisioning, and recovery problems, see [Telegram projects and workspaces](telegram-projects.md#troubleshooting).
