# Telegram

The Telegram runner connects Telegram bots to Tau sessions on the runner machine. Each session is an ordinary local session in a project workspace, with normal Tau configuration, personas, skills, and tools.

Anyone who can use a bot can cause model calls, file changes, and repository changes. Set up the access lists before adding a bot to a group.

## Start the runner

Create a config file. It is separate from `config.json`:

```json
{
  "workspaceRoot": "/var/lib/tau/telegram-workspaces",
  "bots": {
    "engineering": {
      "botToken": "<telegram-bot-token>",
      "startup": { "source": "workspace" },
      "allowedUserIds": [18422031],
      "allowedChatIds": [18422031],
      "defaultProjectId": "ledger"
    }
  },
  "projects": {
    "ledger": { "repo": "acme/ledger", "ref": "main" }
  }
}
```

```sh
tau telegram --config-file /etc/tau/telegram.json --check-config
tau telegram --config-file /etc/tau/telegram.json
```

`--check-config` validates the file without checking tokens or repository access. The file holds bot tokens, so protect it and never commit it. The runner stays in the foreground and refuses unknown fields. Run one runner per configuration and workspace root, and restart it after changing the file.

The runner needs `tau`, `git`, and a signed-in `gh` on its login-shell `PATH`, and model credentials like any [host](models-and-credentials.md). To check that it works, send `/status` and then `/new` in an allowed DM.

**Give the runner a dedicated `workspaceRoot`.** At startup, it deletes everything under that root that no saved session uses, so never point it at a home directory or a directory with other content.

## Configuration

```ts
type TelegramConfig = {
  bots: Record<string, Bot>;
  projects: Record<string, Project>; // IDs: lowercase, digits, "_", at most 28 characters
  workspaceRoot?: string; // default .tau/telegram-workspaces beside this file
  maxSessions?: number; // active sessions across all bots
};

type Bot = {
  botToken: string;
  startup: { source: "workspace" } | { source: "preset"; preset: string };
  presets?: Record<string, Preset>; // what /persona offers, {} hides it
  allowedUserIds?: number[]; // empty or missing: every user
  allowedChatIds?: number[]; // empty or missing: all DMs and no groups
  allowedProjectIds?: string[]; // missing: all projects
  defaultProjectId?: string;
  systemMessage?: string; // added to each turn from this bot
  speechCleanupStyle?: "off" | "default"; // clean up voice transcripts, default "off"
  autoCompactThresholdTokens?: number;
  env?: Record<string, string>; // see Bot environments
};

type Preset =
  | { source: "workspace"; label: string }
  | {
      source: "persona";
      label: string;
      persona: string;
      reasoning?: Reasoning;
      autoCompactThresholdTokens?: number;
    };

type Project = { description?: string } & (
  | { repo: string; ref?: string; workingDirectory?: string } // repo is GitHub "owner/name"
  | { directory: string }
  | {
      projectIds: string[];
      instructions?: string;
      subagents?: { launchModels?: string[] };
    }
);
```

`startup` selects how a new session starts. `{ "source": "workspace" }` uses the workspace's `defaultPersona`, and a preset applies its persona and settings:

```json
{
  "startup": { "source": "preset", "preset": "astra" },
  "presets": {
    "workspace": { "source": "workspace", "label": "Workspace default" },
    "astra": {
      "source": "persona",
      "label": "Astra",
      "persona": "gpt-6-astra-chat",
      "reasoning": "low"
    }
  }
}
```

If you omit `presets`, `/persona` offers every persona in the workspace. A preset changes model, tools, and reasoning together and keeps the conversation. `/new` returns to `startup`.

## Access

For a private bot, use both lists. `allowedUserIds` decides who can start work, and `allowedChatIds` decides which DMs and groups the bot talks in. Group IDs are usually negative. Telegram display names do not grant anything.

In an allowed group, a message starts a turn only when it mentions the bot. The last 50 other messages are kept as context for the next turn, labeled with their sender, so add the bot only to groups whose conversation can be sent to the model.

## Projects

Each session works in a project:

- A **repository project** clones one GitHub repository into a new workspace for each session. `workingDirectory` sets a subdirectory as the session's working directory.
- A **directory project** reuses one existing directory for all its sessions, so sessions from different chats can edit the same files at once. Tau never creates or removes the directory. Use an absolute path, because `~` is not expanded. Changing `directory` makes recovery of existing sessions fail.
- A **composite project** places two or more repository projects in one workspace, under a directory per project ID. Tau writes an `AGENTS.md` listing the members and any `instructions`. Configuration comes from the workspace root, and members' `.tau/config.json` files are not merged.

```json
{
  "projects": {
    "web": { "repo": "acme/web", "ref": "main" },
    "api": { "repo": "acme/api" },
    "notes": { "directory": "/srv/tau/notes" },
    "platform": {
      "projectIds": ["web", "api"],
      "instructions": "Keep shared contracts synchronized."
    }
  }
}
```

If a bot allows one project, Tau selects it automatically. Otherwise the chat picks one with `/use_<projectId>` or gets `defaultProjectId`. Telegram allows 100 commands per bot, which leaves room for 90 project commands. Relative `workspaceRoot` and `directory` paths resolve from the config file's directory.

Sessions read `~/.config/tau` and the `.tau` directories above the workspace as usual. A project's `.tau/config.json` can start [MCP servers](mcp.md) on the runner machine, so review what you add as a project.

### Workspace lifecycle

Tau prepares a repository or composite workspace once per session, using a bare cache in `<workspaceRoot>-repo-cache`. Restarting the runner reuses the workspace as it is, so configuration changes apply only to workspaces prepared later. `/new` and closing a session delete the workspace, and Tau does not commit or push anything first. If a workspace is missing at recovery, Tau rebuilds it from the current configuration.

### Provision hooks

A repository can include an executable `.tau/scripts/provision` with a shebang. Tau runs it in the session's working directory in new and rebuilt workspaces, without blocking chat. A failure is reported to the chat and leaves the session usable. Directory projects do not run hooks.

## Chat commands

| Command | Behavior |
| --- | --- |
| `/new` | Replace the active session using the preferred project. |
| `/use_<projectId>` | Select the project for future `/new` sessions. |
| `/status` | Show session state, project, model, reasoning, context use, and cost. |
| `/persona [key]` | Apply a persona or preset while idle, keeping the conversation. |
| `/effort [level]` | Set reasoning for future turns, also during a turn. |
| `/prompt [id]` | Add a saved prompt to the conversation without starting a turn. |
| `/auto_compact [tokens\|default]` | Show or set the compaction threshold. |
| `/compact` | Compact while idle. |
| `/interrupt` | Interrupt the running turn. |
| `/tts_on`, `/tts_off` | Turn voice replies on or off. |

`/persona`, `/effort`, and `/prompt` show buttons when sent alone. With a value they apply it directly, as in `/persona astra`, `/effort low`, or `/prompt release-summary`. A persona value is the preset key when the bot has `presets`, and otherwise the persona ID, never the button label. Values are case-sensitive.

In groups, commands must mention the bot, as in `/status@tau_engineering_bot`.

A message sent while Tau is working steers the running turn. Telegram has no way to queue a separate turn, so wait or use `/interrupt` before starting something unrelated. Users do not see tool activity, and only the agent's text is sent. Tau tells the agent this at the start of each turn.

## Files and voice

The bot accepts documents, photos, videos, and audio, up to 20 MiB per file, 100 MiB per turn, and 32 files per turn. Sending a file only queues it, and the next text or voice message starts a turn with the file paths. Files go to the temporary directory of the execution environment, where system cleanup can remove them.

Voice notes up to 20 minutes are transcribed with `ELEVENLABS_API_KEY`. With `speechCleanupStyle: "default"`, the transcript is also cleaned up as in the [TUI](tui.md#speech), which needs OpenAI credentials, and the raw transcript is used if cleanup fails. `/tts_on` needs OpenAI and ElevenLabs keys and `ffmpeg` with Opus on the runner. See [models and credentials](models-and-credentials.md).

The agent can send files back with these tools, which take `{ path, caption? }`:

| Tool                        | Delivery        | Files     | Maximum size |
| --------------------------- | --------------- | --------- | ------------ |
| `send_photo_to_telegram`    | In-chat photo   | JPEG, PNG | 10 MB        |
| `send_video_to_telegram`    | Playable video  | MPEG4     | 50 MB        |
| `send_audio_to_telegram`    | Audio player    | MP3, M4A  | 50 MB        |
| `send_document_to_telegram` | File attachment | Any       | 50 MB        |

Calls are not retried, because an interrupted upload may already have arrived. Tau does not convert files, so send unsupported media as a document. The workspace's `enabledClientTools` selects any configured [command tools](client-tools.md), and these run on the runner machine.

## Bot environments

Bots in one runner can use different environment variables, for example to give each bot its own GitHub account:

```json
{
  "env": {
    "GH_CONFIG_DIR": "/var/lib/assistant-github/gh",
    "GIT_CONFIG_GLOBAL": "/var/lib/assistant-github/gitconfig",
    "GH_TOKEN": "",
    "GITHUB_TOKEN": ""
  }
}
```

Sign in with `GH_CONFIG_DIR=/var/lib/assistant-github/gh gh auth login`. The Git config needs a commit identity and the credential helper:

```ini
[credential "https://github.com"]
  helper =
  helper = !gh auth git-credential
[user]
  name = Assistant
  email = assistant@example.com
```

The empty tokens stop `gh` from using a token in the runner's environment. The map applies to the bot's repository commands and to new sessions, and values are used literally, so use absolute paths. Tau saves the map in each session, so keep secrets out of it. It does not isolate bots from each other, because they share one OS user. Use separate runners under separate accounts when bots must be isolated.

A saved session whose map differs from the bot's current `env` fails recovery. Restore the old `env`, or start over with `/new`, which deletes a repository workspace, so save unfinished work first.

## Restarts

A normal shutdown interrupts running work and disconnects sessions. After a restart, sessions reconnect with their conversation, and unsent failure notices are delivered. A message that Tau never accepted is reported so you can resend it. Do not edit the runner's state files, `<workspaceRoot>-sessions.json` and `<workspaceRoot>-project-preferences.json`.

## When the bot ignores you

- **In a DM:** check that the chat and the sender are in the allowlists that are set.
- **In a group:** the group must be in `allowedChatIds`, the message must mention the bot, and the sender must be in `allowedUserIds` when that is set.
- **`/new` asks for a project:** set `defaultProjectId` or run `/use_<projectId>`.

The runner log names the failing step for repository preparation, attachments, and delivery.
