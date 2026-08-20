# Telegram

Tau's Telegram runner turns one or more bots into clients of local, in-process Tau sessions. It owns Telegram polling, chat routing, attachments, project selection, and workspace preparation on the runner machine. Each prepared workspace then becomes an ordinary local execution environment with normal Tau configuration, personas, tools, project context, session snapshots, and history.

Bot access can lead to model calls, filesystem changes, and repository mutations. Configure chat, user, and project boundaries before inviting a bot into a group.

## Start the runner

Run the standalone process with one dedicated JSON file:

```sh
tau telegram --config-file /etc/tau/telegram.json
```

The process stays in the foreground until `SIGINT` or `SIGTERM`. Relative `--config-file` paths resolve from the process working directory. Paths inside that file resolve as described below, usually from the config file's directory.

The Telegram file is **not** a Tau `config.json` level. It controls runner concerns such as bot tokens, project definitions, workspace roots, and routing. Tau still loads normal configuration from the runner's startup working directory and from each prepared session workspace. See [configuration](configuration.md) and [ownership and scope](ownership-and-scope.md).

Run at most one Telegram runner for a given configuration and workspace root. Concurrent runners are unsupported and can race Telegram updates, persisted runner state, and workspace cleanup.

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
      "persona": "gpt-5.6-sol-coder:high"
    }
  }
}
```

The bot token is a required literal string; Telegram config has no token environment indirection. Protect the file, never commit it, and rotate an exposed token through BotFather. Do not print the config into a session or shared log.

Unknown object fields are stripped, so a misspelled field can have no effect without making the JSON invalid.

## Top-level contract

| Field | Required | Behavior |
| --- | --- | --- |
| `bots` | Yes | Non-empty object keyed by operator-chosen bot ID. |
| `projects` | Yes | Object keyed by project ID. Bots select from these definitions. |
| `workspaceRoot` | No | Base for managed workspaces; defaults to `.tau/telegram-workspaces` beside the Telegram config file. |
| `maxSessions` | No | Positive integer cap on active sessions across the whole runner. |
| `systemMessage` | No | Non-empty model-facing instruction prepended to every Telegram turn. |

A relative top-level `workspaceRoot` resolves from the Telegram config file's directory. Tau persists runner session records at `<workspaceRoot>-sessions.json` and per-chat preferences at `<workspaceRoot>-project-preferences.json`. These are runner-owned state files, not operator editing surfaces. Session snapshots remain in the normal host store under the runner user's Tau home.

`maxSessions` counts queued, preparing, running, and waiting sessions across all configured bots. Failed records do not consume the active cap, but they remain visible to their owning chat until replaced or closed.

## Bot contract and access control

Each `bots.<id>` object supports:

| Field | Required | Behavior |
| --- | --- | --- |
| `botToken` | Yes | Telegram Bot API token. |
| `allowedProjectIds` | No | Non-empty unique subset of configured project IDs; omission exposes all projects. |
| `allowedUserIds` | No | Integer user IDs allowed to trigger turns, commands, and callbacks. |
| `allowedChatIds` | No | Integer chat IDs allowed to interact with the bot; also opts groups in. |
| `defaultProjectId` | No | Initial project preference, and must be allowed for this bot. |
| `systemMessage` | No | Additional instruction for turns from this bot. |
| `pollIntervalMs` | No | Positive polling retry interval, default 1,000 ms. |
| `requestTimeoutSeconds` | No | Positive Telegram long-poll timeout, default 30 seconds. |

An absent or empty `allowedUserIds` means no user restriction. An absent or empty `allowedChatIds` allows DMs but allows no groups. When `allowedChatIds` is non-empty, it restricts DMs to listed chat IDs and enables only listed groups. Group IDs are usually negative integers.

Use both lists for a private bot. `allowedUserIds` controls who can trigger work, but messages from other users in an allowed group can still enter the sender-attributed pending group context. Only add the bot to groups whose conversation is suitable for model input.

A bot sees only `allowedProjectIds`. If that field is omitted, it sees every configured project. A sole allowed project is selected automatically; otherwise a chat needs `defaultProjectId` or an explicit `/use_<project>` preference before `/new`.

Tau registers ten built-in commands plus one `/use_<projectId>` command per visible project. A bot may expose at most 90 projects under Telegram's 100-command limit.

## Project IDs and common fields

Project IDs become Telegram command suffixes. They must contain only lowercase letters, digits, and underscores, and may be at most 28 characters:

```text
ledger
platform_api
release2026
```

Every project can have an optional non-empty `description`. Repository and persistent-directory projects can select `persona` as `<id>` or `<id>:<reasoning>`, and can set `noAgentContextFiles` to disable `AGENTS.md` injection for that session. Composite projects require their own persona and do not support `noAgentContextFiles`.

Each project must define exactly one workspace source: `repo`, `directory`, or `projectIds`.

## Repository projects

A repository project clones one GitHub repository into a session-specific managed workspace:

```json
{
  "projects": {
    "ledger": {
      "repo": "acme/ledger",
      "ref": "main",
      "workingDirectory": "packages/api",
      "workspaceRoot": "/var/lib/tau/ledger-workspaces",
      "persona": "gpt-5.6-sol-coder",
      "noAgentContextFiles": false
    }
  }
}
```

`repo` must use GitHub `owner/repo` syntax. Arbitrary Git URLs are not accepted. The runner needs `gh` and `git` on its login-shell `PATH`, and `gh` must already be authenticated for the repository.

A relative project `workspaceRoot` resolves from the Telegram config file's directory and replaces the top-level root for that project's managed workspaces. A session workspace is:

```text
<effective-workspace-root>/<project-id>/<telegram-session-id>
```

`workingDirectory` is optional and must be a relative directory inside the clone. Tau validates that it exists and does not escape the repository, then uses it as the session `cwd`. Without it, the repository root is the `cwd`.

`ref` is optional and is passed to `git checkout` after cloning. Without it, the clone's default branch remains checked out. Configure a ref when sessions must begin from a predictable branch or commit.

### Repository caches

Tau keeps a persistent bare cache at:

```text
<effective-workspace-root>-repo-cache/<project-id>.git
```

The first preparation uses `gh repo clone <owner/repo> <cache> -- --bare`. Later preparations fetch and prune the cache, then create the session workspace with a shared local clone. If the repository configured for the same project ID changes, Tau discards and recreates that cache.

Caches are not session workspaces. Tau does not commit, push, or preserve uncommitted changes automatically. Managed workspaces survive a normal restart, but `/new` removes the active session's workspace.

## Persistent-directory projects

A persistent-directory project reuses one existing directory instead of creating a managed clone:

```json
{
  "projects": {
    "notes": {
      "directory": "/srv/tau/notes",
      "persona": "gpt-5.6-sol-coder"
    }
  }
}
```

Relative `directory` paths resolve from the Telegram config file's directory. JSON does not expand `~`, so use an absolute path when referring to a home directory.

The directory must already exist. Tau never creates, replaces, provisions, or removes it. `/new`, session close, runner shutdown, and startup cleanup all preserve it.

Every session for this project uses the same directory as its execution-environment `cwd`, including sessions owned by different chats or bots. Tau does not serialize their filesystem work. Use `maxSessions`, bot project scoping, and access allowlists to prevent unsafe concurrent edits when the directory is not designed for them.

Persistent-directory sessions omit the conventional history `repository` attribute. On recovery, Tau requires the configured directory to match the directory stored in the Tau session snapshot. Changing `directory` does not migrate existing sessions and causes those recoveries to fail.

## Composite projects

A composite project creates a root containing multiple repositories:

```json
{
  "projects": {
    "web": { "repo": "acme/web", "ref": "main" },
    "api": { "repo": "acme/api", "workingDirectory": "services/http" },
    "platform": {
      "projectIds": ["web", "api"],
      "persona": "gpt-5.6-sol-coder:high",
      "instructions": "Keep shared contracts synchronized.",
      "subagents": {
        "defaultLaunchModels": ["openai/gpt-5.6-sol:high"]
      }
    }
  }
}
```

`projectIds` requires at least two unique repository projects; directories and composites are invalid members. Order controls workspace context and history `repository`.

Members live at `<composite-root>/<member-project-id>` and use each repository's cache, ref, and working directory. The root is the session `cwd`. Its generated `AGENTS.md` lists members and optional `instructions`, and requires reading relevant member root instructions before work.

`subagents.defaultLaunchModels` sets the built-in `default` launch override allowlist. Tau writes it to root `.tau/config.json`; without `subagents`, the file is `{}`. Runtime config resolves and enforces entries. See [subagents](subagents.md) for model syntax and custom policy.

The composite owns the parent persona, subagents, model catalog, config, settings, and tools. Child `.tau/config.json` files are not merged. A subagent in a member directory rebuilds only target context: environment and repository metadata, applicable `AGENTS.md` and `agentContextFiles`, and skills filtered by the parent persona.

Composite preparation is all-or-nothing. If one member cannot be prepared, Tau removes the generated composite workspace. The composite's optional `workspaceRoot` controls the generated root; member repository caches continue to use each member's configured root or the top-level default.

## Managed workspace safety

**Important:** runner startup removes entries under configured managed workspace roots when they are not referenced by persisted sessions. Dedicate these roots to Tau Telegram workspaces. Do not point `workspaceRoot` at a home directory, repository collection, or any directory containing unrelated files.

Tau preserves managed workspaces referenced by active or failed persisted records and always preserves configured persistent directories. It also preserves repository caches, which live beside the workspace root under the `-repo-cache` suffix rather than inside the pruned root.

`/new` closes the chat's current active session before creating its replacement. For repository and composite projects, closing interrupts work and recursively removes that session's managed workspace. Uncommitted changes are lost unless the agent or operator saved them elsewhere. For persistent-directory projects, the shared directory remains untouched.

## Provision hooks

A repository may provide an optional setup script at its repository root:

```text
.tau/scripts/provision
```

Tau runs it through `session.exec` with the project's configured working directory as `cwd`. The path must be a regular executable file, not a symlink, and must begin with a shebang. A missing hook is a successful no-op.

Provisioning starts after the session becomes available and does not block chat input. A failure is reported to linked chats, but the session remains usable. Composite sessions run each member hook in member order and continue after a member failure. Persistent-directory projects are never provisioned.

A newly created workspace runs its hook. A preserved workspace skips it during normal restart recovery. If recovery must reconstruct a missing repository or composite workspace from cache, the reconstructed repositories run provisioning again. Keep hooks repeatable and non-interactive.

## Normal Tau configuration inside workspaces

After preparation, Tau creates an ordinary local session at the workspace `cwd`. Runtime discovery reads normal `~/.config/tau` and ancestor `.tau` content visible from that path: models, personas, prompts, skills, project context, host tools, and other session settings work as they do in the TUI.

A project `persona` overrides the normal default for that session. `noAgentContextFiles: true` suppresses `AGENTS.md` injection for repository or persistent-directory sessions. Composite root context is generated deliberately and uses its required persona.

The top-level and per-bot `systemMessage` values are different from project context. Tau prepends them as a hidden `<system>` block to every Telegram-submitted turn, with the top-level message first and the bot message second. They are persisted as part of the user turn and can appear in history, so never put credentials in them.

The runner's speech-to-text provider is loaded from normal Tau config at runner startup, based on the runner process's startup `cwd`. Restart the runner after changing that provider or its environment.

## Chat commands

| Command | Behavior |
| --- | --- |
| `/use_<projectId>` | Saves the project preference for future `/new` sessions; does not change the active session. |
| `/new` | Closes the current active session, then creates one from the current project preference. |
| `/status` | Reports session state, project, model, reasoning, context usage, cost, and goal state when available. |
| `/effort_low` | Selects low reasoning for later independent turns. |
| `/effort_medium` | Selects medium reasoning for later independent turns. |
| `/effort_high` | Selects high reasoning for later independent turns. |
| `/effort_xhigh` | Selects xhigh reasoning for later independent turns. |
| `/compact` | Runs summary-only manual compaction while the session is idle. |
| `/interrupt` | Interrupts the active Tau turn. |
| `/tts_on` | Enables a Gemini-generated voice note after each final assistant response. |
| `/tts_off` | Disables voice responses. |

Preferences are scoped to one bot and chat and survive restarts, projects, and sessions. A new project choice does not switch the active session; `/status` reports the difference.

In groups, commands must explicitly mention the bot. Accepted forms include:

```text
/status@tau_engineering_bot
/status @tau_engineering_bot
@tau_engineering_bot /status
```

A command addressed to another bot does not trigger this one.

## DMs, groups, and active work

In a DM, ordinary text goes to the active session. If no session is selected but the chat owns exactly one session, Tau selects it automatically. Otherwise the bot asks for `/new`.

In an allowed group, ordinary messages trigger Tau only when they explicitly mention the bot username. Non-triggering text and captions are buffered as sender-attributed background context. On the next valid mention, Tau includes up to the most recent 50 buffered messages since the previous bot-triggering turn, then clears that buffer after successful submission.

Pending group context can include attachment paths, audio transcripts, and processing errors. It is untrusted model input. `allowedUserIds` prevents an unlisted sender from triggering work, but their message can still become context in an allowed group.

Telegram text and transcribed audio use automatic submit-or-steer behavior. When the session is idle, the input starts a normal turn. When Tau is already working, it becomes steering input that stops the active turn at its next safe boundary and continues with the new message. Additional steering follows Tau's normal batching behavior. Telegram does not expose a separate queued-turn command. Use `/interrupt` when the desired action is to stop rather than steer.

Tau keeps tool and lifecycle chatter quiet. It sends committed assistant text, including multiple messages from one run, and refreshes the typing indicator during work. Oversized replies are split into bounded chunks. Durable failed, blocked, and confirmed-unaccepted turn notifications remain pending until Telegram acknowledges delivery.

## Attachments and audio

Telegram accepts photos and documents identified as images, PDF, `.txt`, `.md`, `.json`, `.csv`, `.yaml`, or `.yml`. It downloads supported attachments immediately to a runner temporary directory and gives the agent the local path, MIME type, byte size, and caption.

Limits are:

- at most 32 attachments per turn
- at most 20 MiB per file
- at most 100 MiB total per turn

An attachment-only DM queues files for the next text or voice/audio turn; it does not run the agent by itself. Unsupported, oversized, or failed downloads are skipped with a warning. Treat every attachment as untrusted input even though its path is local.

The local execution environment can access these runner temporary paths. Pending attachments and group context are not snapshot data. Shutdown clears their queues, and startup removes stale `tau-telegram-attachments-*` directories.

Telegram `voice` and `audio` messages are downloaded and transcribed. Direct DM turns and bot-triggering group turns echo the transcript to the chat before submission so the sender can verify it.

OpenAI is the default. Select another provider with `speechToText.provider`. Runner credentials are:

- Mistral: `MISTRAL_API_KEY`, then `apiKeys.mistral`
- Gemini: `GEMINI_API_KEY`, then `apiKeys.google`
- OpenAI: `OPENAI_API_KEY`, then `apiKeys.openai`

OpenAI normalizes downloaded audio with runner-side `ffmpeg` and uploads it to `gpt-transcribe`. Missing keys reject the audio. See [credentials](credentials.md).

`/tts_on` uses `gemini-3.7-flash`, `gemini-3.1-flash-tts-preview`, Despina, the Google key, and runner `ffmpeg` with Opus. Source and rewritten text each allow 10,000 Unicode characters; audio allows 32 MiB. Rewrite and job timeouts are one and five minutes. Jobs are ephemeral. Failure sends `voice response failed. please try again.` without affecting text; details stay in logs.

## Command client tools

Each Telegram session advertises the configured command client tools selected by normal Tau configuration for its prepared workspace. Global `clientTools` definitions provide executable behavior, while the workspace's most-specific `enabledClientTools` value selects an exact subset. An empty list disables all configured client tools for that workspace.

These command processes run on the Telegram runner machine with the runner process environment. They can reach the session workspace only through their explicit execution-environment facade, despite physical co-location. Telegram does not advertise TUI-only `diff_review` or `prefill_input` tools.

Tool selection occurs when the session client is created or reconnected. `/reload` does not rebuild the Telegram client advertisement. Restart the runner or create a new session client after changing command client-tool selection. See [client tools](client-tools.md).

## Persistence and restart behavior

Normal shutdown interrupts live work, waits for active work to settle, disconnects sessions, and preserves repository and composite workspaces rather than deleting them. Sessions that finished creation reconnect on restart and retain their conversation. A session interrupted while its workspace or Tau session was still being prepared starts preparation again.

If a referenced repository workspace is missing, Tau reconstructs it from the cache and reconnects the same session. A persistent-directory workspace is never reconstructed; its configured directory must still exist at the original path.

If the connection is lost after Telegram submits a message, startup checks whether Tau accepted and completed it. Running work remains interruptible until it settles. A confirmed unaccepted message prompts the user to resend it; failed or blocked outcomes remain queued until delivery succeeds.

Restart does not replay responses. It clears voice jobs and short-lived retries, but pending notifications remain.

If a failed session still has unresolved submitted work, Tau can reconnect to determine the outcome. Other failed sessions remain visible with their original diagnostic until the owning chat replaces or closes them. Do not edit runner state files to force recovery.

## Verify a runner safely

1. Validate that the Telegram file is parseable JSON without displaying it in a shared terminal transcript.
2. Confirm the runner user can execute `tau`, `git`, and `gh`, and that `gh` can access each repository.
3. Start the runner and watch for config, polling, command-sync, cache, checkout, and recovery errors. Successful startup prints `tau telegram running`.
4. In an allowed DM, run `/status`, select a project if needed, then run `/new`.
5. Submit a small nonsensitive prompt and confirm an assistant response.
6. If groups are enabled, verify that an unmentioned message stays quiet and an explicitly mentioned command works.
7. If a provision hook exists, confirm its completion or reported failure before relying on its dependencies.
8. Restart the runner normally and use `/status` to confirm the session recovered without replaying old replies.

Do not verify bot tokens, provider keys, Access secrets, transcript contents, or runner state by printing them.

## Common failures

**The runner rejects its config.** Check required `bots` and `projects` objects, exact project IDs, positive numeric fields, known allowed projects, and that each project defines exactly one of `repo`, `directory`, or `projectIds`.

**The bot ignores a DM.** If `allowedChatIds` is set, the DM chat ID must be listed. If `allowedUserIds` is set, the sender's user ID must also be listed.

**The bot ignores a group.** Groups require an explicit `allowedChatIds` entry and a direct `@botusername` mention. Commands also need the mention in one of the accepted command forms.

**`/new` asks for a project.** Configure `defaultProjectId`, expose only one project, or run the matching `/use_<projectId>` command first.

**Repository preparation fails.** Verify runner-side `gh` authentication, `git` availability, repository access, configured `ref`, and that `workingDirectory` exists in the checked-out tree. A changed repository under an existing project ID causes cache reinitialization.

**Startup removed unexpected files.** The configured workspace root was not dedicated to Tau. Stop the runner and move `workspaceRoot` to an isolated directory before restarting. Recovery data does not make unrelated deleted files restorable.

**Provisioning fails but chat still works.** This is expected isolation. Fix the executable bit, shebang, script behavior, or dependencies, then create a new managed workspace if the hook needs to run again.

**A persistent-directory session fails recovery.** Restore the configured directory and its original path, or return the project config to the snapshot's durable `cwd`. Tau does not migrate an existing session to a new persistent directory.

**Audio reports a missing key.** Set the credential for the configured speech provider in the runner process and restart it. A workspace-only environment change does not update the runner's startup speech configuration.

**A message sent during active work changes direction.** Telegram uses steering, not ordinary queueing, while a turn is running. Wait for completion before sending an independent next task, or use `/interrupt` to stop the current run first.

**A command client tool is absent.** Check global `clientTools`, the prepared workspace's `enabledClientTools`, and whether the session client was created after the change. Telegram never provides TUI-only tools.
