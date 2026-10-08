# Telegram

Tau's Telegram runner connects one or more Telegram bots to Tau sessions that run in the same process. On the runner machine, it polls Telegram, routes chats, handles attachments, and prepares project workspaces. Each workspace is an ordinary local execution environment, with normal Tau configuration, personas, tools, project context, saved sessions, and history.

Anyone who can use a bot can cause model calls, file changes, and repository changes. Set up chat, user, and project limits before adding a bot to a group.

## Start the runner

Run the standalone process with one dedicated JSON file:

```sh
tau telegram --config-file /etc/tau/telegram.json
```

The process stays in the foreground until `SIGINT` or `SIGTERM`. Relative `--config-file` paths resolve from the process working directory. Paths inside that file resolve as described below, usually from the config file's directory.

The Telegram file is **not** one of Tau's `config.json` levels. It configures the runner: bot tokens, projects, workspace roots, and routing. Tau still loads normal configuration from the runner's startup directory and from each session's workspace. See [configuration](configuration.md) and [ownership and scope](ownership-and-scope.md).

Run at most one runner per configuration and workspace root. Two runners would compete for Telegram updates, runner state, and workspace cleanup.

## Minimal configuration

A useful configuration defines at least one bot and one project:

```json
{
  "workspaceRoot": "/var/lib/tau/telegram-workspaces",
  "bots": {
    "engineering": {
      "botToken": "<telegram-bot-token>",
      "allowedProjectIds": ["ledger"],
      "allowedUserIds": [18422031],
      "allowedChatIds": [18422031],
      "defaultProjectId": "ledger"
    }
  },
  "projects": {
    "ledger": {
      "repo": "acme/ledger",
      "ref": "main",
      "persona": "gpt-6.1-sol-coder:high"
    }
  }
}
```

The bot token must be written in the file; it cannot come from an environment variable. Protect the file, never commit it, and rotate an exposed token through BotFather. Never print the config into a session or shared log.

Unknown fields are removed, so a misspelled field silently has no effect.

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
| `allowedProjectIds` | No | Non-empty unique subset of configured project IDs; omission exposes all projects. |
| `allowedUserIds` | No | Integer user IDs allowed to trigger turns, commands, and callbacks. |
| `allowedChatIds` | No | Integer chat IDs allowed to interact with the bot; also opts groups in. |
| `defaultProjectId` | No | Initial project preference, and must be allowed for this bot. |
| `systemMessage` | No | Additional instruction for turns from this bot. |

The runner retries failed polling after 1,000 ms and uses a 30-second Telegram long-poll timeout.

A missing or empty `allowedUserIds` allows every user. A missing or empty `allowedChatIds` allows all DMs and no groups. A non-empty `allowedChatIds` allows only the listed DMs and groups. Group IDs are usually negative.

Use both lists for a private bot. `allowedUserIds` decides who can start work, but in an allowed group, messages from other users can still become context, labeled with their sender. Add the bot only to groups whose conversation is fine to send to the model.

A bot sees only its `allowedProjectIds`, or every project if the field is missing. If only one project is allowed, it is selected automatically. Otherwise a chat needs `defaultProjectId` or a `/use_<project>` choice before `/new`.

Telegram allows 100 commands per bot: twelve built-ins and up to 88 `/use_<projectId>` commands.

## Projects

Each project tells the runner where a session works. There are three kinds:

- A **repository project** clones one GitHub repository into a new workspace for each session.
- A **persistent-directory project** reuses one existing directory for all of its sessions.
- A **composite project** combines several repository projects in one workspace.

Project IDs become `/use_<projectId>` commands, so they may contain only lowercase letters, digits, and underscores, and be at most 28 characters. Every project can have a `description`, and must define exactly one of `repo`, `directory`, or `projectIds`. [Telegram projects and workspaces](telegram-projects.md) describes each kind, where workspaces live, provision hooks, and what happens to workspaces on restart.

**Important:** at startup, the runner deletes everything under its managed workspace roots that no saved session uses. Give Tau a dedicated `workspaceRoot`; never use a home directory, a collection of repositories, or any directory with other content.

## Normal Tau configuration inside workspaces

After preparation, Tau creates an ordinary local session in the workspace. It reads `~/.config/tau` and the `.tau` directories above the workspace as usual, so personas, prompts, skills, project context, host tools, and other settings work as in the TUI.

A project's `persona` replaces the default for its sessions. Composite sessions use the generated root files and their required persona.

Every Telegram turn starts with a hidden `<system>` block saying the message comes from Telegram and the reply goes there. It asks for direct answers to simple questions, and for short acknowledgements or useful progress updates during longer work, because users cannot see tool activity.

A per-bot `systemMessage` goes in a second hidden block. Audio transcripts get another block warning that they may contain noise or errors. Hidden blocks are saved with the user's message and can appear in history, so never put credentials in configured messages.

The runner loads its speech credentials and `speech.voiceId` at startup, from its environment and from the Tau config for its startup directory. Restart the runner after changing them.

## Chat commands

| Command | Behavior |
| --- | --- |
| `/use_<projectId>` | Selects the project for future `/new` sessions. |
| `/new` | Replaces the active session using the preferred project. |
| `/status` | Reports session state, project, model, reasoning, context usage, and cost. |
| `/persona` | Switches persona while idle without losing history or starting a turn. |
| `/effort_low` | Selects low reasoning for future turns. |
| `/effort_medium` | Selects medium reasoning for future turns. |
| `/effort_high` | Selects high reasoning for future turns. |
| `/effort_xhigh` | Selects xhigh reasoning for future turns. |
| `/prompt` | [Records a saved prompt](prompts-and-project-context.md#telegram-prompt-picker) while idle, without starting a turn. |
| `/auto_compact [tokens\|default]` | Shows the automatic-compaction threshold. Pass `50k` or `50000` to set it (minimum 50,000 tokens), or `default` to restore the model-based threshold. |
| `/compact` | Runs summary-only compaction while idle. |
| `/interrupt` | Interrupts the active Tau turn. |
| `/tts_on` | Sends a voice note after each final assistant response. |
| `/tts_off` | Disables voice responses. |

Changes to the auto-compaction threshold apply from the next turn and survive session recovery. `/status` shows context usage as a percentage of the full model window. When an override is set, it also shows the effective threshold in parentheses. See [automatic compaction](sessions.md#automatic-compaction) for limits and costs.

A [persona](personas.md) choice applies to the current session only; `/new` uses the project's default.

Preferences are saved per bot and chat, and survive restarts and new sessions. A project change applies at the next `/new`, not to the current session.

In groups, commands must explicitly mention the bot. Accepted forms include:

```text
/status@tau_engineering_bot
/status @tau_engineering_bot
@tau_engineering_bot /status
```

Commands addressed to other bots are ignored.

## DMs, groups, and active work

In a DM, ordinary text goes to the active session. If none is selected but the chat has exactly one session, Tau selects it. Otherwise the bot asks for `/new`.

In an allowed group, a message starts a turn only when it mentions the bot's username. Other text and captions are kept as background context, labeled with their sender. At the next mention, Tau includes up to the 50 most recent kept messages since the last turn, and clears them once the turn is submitted.

Group context can include attachment paths, audio transcripts, and processing errors. The model receives it as untrusted input. `allowedUserIds` stops an unlisted sender from starting work, but their messages can still become context in an allowed group.

Text and transcribed audio either start or steer a turn. When the session is idle, the message starts a normal turn. When Tau is working, the message steers the running turn: the turn stops at its next safe point and continues with the new message. Further steering is batched as usual. Telegram has no command to queue a separate turn. Use `/interrupt` to stop instead of steering.

Tau does not report tool activity or lifecycle events. It sends assistant text, including several messages from one run, and keeps the typing indicator on during work. Long replies are split into parts. Notifications about failed, blocked, and unaccepted turns are kept until Telegram confirms delivery.

## Attachments and audio

The bot accepts any documents, photos, videos, animations, video notes, audio files, and voice notes. The agent receives the file paths in the execution environment, cleaned-up filenames, MIME types, sizes, and captions. Files are never run on receipt.

Limits are 32 attachments per turn, 20 MiB per file, and 100 MiB per turn. Downloads are limited even when Telegram does not report a size. Files that are too large or fail to download are skipped with a warning.

Sending a file only queues it, and its caption is kept as metadata. The next text or voice message starts or steers a turn, with one hidden `<system>` block per attachment. Only voice notes are transcribed, up to 20 minutes long. Audio files and audio documents arrive without a transcript. The original voice file stays available even if transcription fails. Transcripts of DMs, and of group messages that mention the bot, are echoed before submission.

Files are stored in the execution environment's temporary directory, so system cleanup can remove them. Queued files and group context are cleared on shutdown. Treat file contents and metadata as untrusted.

Voice transcription uses Gemini with `GEMINI_API_KEY`, or else `apiKeys.google`. Optional spelling hints use GPT-6 Luna (reasoning disabled) with OpenAI credentials. Gemini transcribes verbatim with `gemini-3.5-transcribe`, using English (`en-US`) and Finnish (`fi-FI`) hints, and Tau tries to delete the uploaded file afterward. Receiving files needs no Google key. See [credentials](credentials.md).

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

1. Check that the Telegram file is valid JSON, without showing it in a shared terminal.
2. Confirm the runner user can execute `tau`, `git`, and `gh`, and that `gh` can access each repository.
3. Start the runner and watch for config, polling, command-sync, cache, checkout, and recovery errors. Successful startup prints `tau telegram running`.
4. In an allowed DM, run `/status`, select a project if needed, then run `/new`.
5. Send a small, non-sensitive prompt and confirm the reply.
6. If groups are enabled, check that a message without a mention gets no reply and a command with a mention works.
7. If there is a provision hook, wait for it to finish or report a failure before relying on what it installs.
8. Restart the runner normally and use `/status` to confirm the session recovered without resending old replies.

Do not verify bot tokens, provider keys, Access secrets, transcript contents, or runner state by printing them.

## Troubleshooting

**The runner rejects its config.** Startup errors name every invalid bot or project field. Check the required `bots` and `projects` objects, exact project IDs, positive numbers, allowed project IDs, persona suffixes, and that each project defines exactly one of `repo`, `directory`, or `projectIds`. Check the JSON syntax without printing the file, which contains bot tokens, and restart the runner after fixing it. Relative paths in the file resolve from its directory.

**The bot ignores a DM.** If `allowedChatIds` is set, the DM's chat ID must be listed. If `allowedUserIds` is set, the sender's user ID must be listed too.

**The bot ignores a group.** The group must be in `allowedChatIds`, the message must mention the bot (commands in one of the accepted forms), and the sender must be in `allowedUserIds` when that list is set. Messages that do not mention the bot can still become context for the next turn, so make sure that is acceptable before allowing more groups.

**`/new` asks for a project, or uses the wrong one.** Set `defaultProjectId`, allow only one project, or run `/use_<projectId>` first. `/use_<projectId>` affects only future `/new` sessions; `/status` shows the current session's project and the saved choice separately.

**A message sent during work changes direction.** While a turn is running, a new message steers it instead of waiting in a queue. Wait for the turn to finish before sending an unrelated task, or use `/interrupt` first.

**Audio or an attachment fails.** The reply or runner log names the step that failed: download, saving, format, or transcription. Check that Telegram can deliver the file to the bot, the type is supported, the runner can write to its temporary directory, and Gemini accepts the media type. Transcription needs `GEMINI_API_KEY` or `apiKeys.google` for the runner process; restart the runner after setting it. Changing a workspace's environment does not affect the runner. Do not log media or transcripts to debug this.

**Voice replies fail.** `/tts_on` needs OpenAI and ElevenLabs credentials and `ffmpeg` with Opus on the runner. Check [`speech.voiceId`](config-reference.md#speech) if a configured voice is unavailable. The bot replies `voice response failed. please try again.` and logs the details; the text reply is still delivered.

**Replies or notifications arrive late or not at all.** Each outgoing message part has a deadline and is retried twice on retryable errors. Tau honors Telegram's `retry_after`, and later notifications in a chat wait for earlier ones. Long replies are split, so only a later part may have failed. The runner log shows the method, status, retry class, attempt, chat, session, and message. Fix network, rate-limit, token, or chat permission problems on the runner. Before resending by hand, check which parts arrived. A delivery failure is not a failed turn, and notifications about failed or blocked turns are sent again after a restart. Never fix delivery by editing runner state.

**A command client tool is missing.** Check global `clientTools`, the workspace's `enabledClientTools`, and whether the session's client was created after the change. Telegram never offers the TUI's tools.

For workspace preparation, provisioning, and recovery problems, see [Telegram projects and workspaces](telegram-projects.md#troubleshooting).
