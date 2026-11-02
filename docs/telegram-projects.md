# Telegram projects and workspaces

A Telegram runner starts every session in a project. The project decides which repository or directory the session works in, how its workspace is prepared, and what happens to the workspace when the session ends or the runner restarts. Projects are defined under `projects` in the runner's config file and offered to chats per bot, as described in [Telegram](telegram.md).

## Project IDs and common fields

Project IDs become `/use_<projectId>` command suffixes. They must contain only lowercase letters, digits, and underscores, and may be at most 28 characters:

```text
ledger
platform_api
release2026
```

Every project can have an optional non-empty `description`. Projects do not select a persona. The bot does that through [startup and presets](telegram.md#startup-and-presets). Sessions load applicable `AGENTS.md` instructions.

Each project must define exactly one workspace source: `repo`, `directory`, or `projectIds`.

## Repository projects

A repository project clones one GitHub repository into a session-specific managed workspace:

```json
{
  "projects": {
    "ledger": {
      "repo": "acme/ledger",
      "ref": "main",
      "workingDirectory": "packages/api"
    }
  }
}
```

`repo` must be a GitHub `owner/repo`; other Git URLs are not accepted. The runner needs `gh` and `git` on its login shell's `PATH`, and `gh` must already be signed in with access to the repository. A bot can use its own sign-in through its [environment](#bot-environments).

All managed projects use the top-level `workspaceRoot`. A session workspace is:

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

Sessions never work in the cache directly.

## Persistent-directory projects

A persistent-directory project reuses one existing directory instead of creating a managed clone:

```json
{
  "projects": {
    "notes": {
      "directory": "/srv/tau/notes"
    }
  }
}
```

Relative `directory` paths resolve from the Telegram config file's directory. JSON does not expand `~`, so use an absolute path when referring to a home directory.

The directory must already exist. Tau never creates, replaces, provisions, or removes it. `/new`, session close, runner shutdown, and startup cleanup all preserve it.

Every session of this project works in the same directory, including sessions from different chats or bots, and Tau does not stop them from editing at the same time. If the directory cannot handle that, use `maxSessions`, per-bot projects, and allowlists to prevent it.

Persistent-directory sessions have no `repository` attribute. On recovery, the configured directory must match the one saved in the session. Changing `directory` does not move existing sessions; their recovery fails instead.

## Composite projects

A composite project creates a root containing multiple repositories:

```json
{
  "projects": {
    "web": { "repo": "acme/web", "ref": "main" },
    "api": { "repo": "acme/api", "workingDirectory": "services/http" },
    "platform": {
      "projectIds": ["web", "api"],
      "instructions": "Keep shared contracts synchronized.",
      "subagents": {
        "launchModels": ["openai/gpt-6.1-sol:high"]
      }
    }
  }
}
```

`projectIds` requires at least two unique repository projects; directories and composites are invalid members. Order controls workspace context and history `repository`.

Members are placed at `<composite-root>/<member-project-id>` and use each repository's cache, ref, and working directory. The root is the session's `cwd`. When the workspace is created, Tau writes a root `AGENTS.md` that lists the members and any `instructions`, and a root `.tau/config.json` containing `subagents` or `{}`. These are ordinary workspace files. They do not follow later Telegram configuration changes and are not rewritten when a preserved session reconnects.

`subagents.launchModels` sets which models subagents may be started with. See [subagents](subagents.md) for the syntax and inheritance.

Configuration resolved at the composite root applies to the whole session, including the workspace's `defaultPersona`, subagents, model catalog, tools, MCP servers, and speech vocabulary. Members' `.tau/config.json` files are not merged. A subagent started in a member directory rebuilds only the context that depends on the directory: environment and repository details, the applicable `AGENTS.md`, and the skills found there.

If any member cannot be prepared, Tau removes the whole composite workspace. Composite workspaces and member caches use the top-level `workspaceRoot`.

## Managed workspace lifecycle

Repository and composite projects work the same way. Tau prepares one workspace per session, and the session keeps working there. A normal runner restart reconnects without fetching or checking out repositories, running provision hooks, or rewriting generated files. Changes to workspace preparation in the Telegram config affect only workspaces prepared later.

If the expected workspace is missing, recovery reconstructs it from the caches and current project configuration. `/new` and session close remove a managed workspace; normal shutdown preserves it. Tau does not commit, push, or save uncommitted changes elsewhere.

## Managed workspace safety

A project's `.tau/config.json` can define [MCP servers](config-reference.md#mcpservers) that start commands on the runner machine with the runner's credentials, so [review what you prepare](security.md#trust-mcp-servers). A workspace outside the runner user's home does not inherit servers from global configuration.

**Important:** startup removes entries under managed workspace roots that no persisted session references. Dedicate these roots to Tau; never use a home directory, repository collection, or unrelated tree.

Tau preserves referenced managed workspaces, configured persistent directories, and repository caches. `/new` closes the active session before replacing it. Closing a repository or composite session interrupts work and removes its workspace; persistent directories remain untouched.

## Provision hooks

A repository can include `.tau/scripts/provision` at its root. It must be a regular executable file, not a symlink, and start with a shebang. Tau runs it in the session's working directory once the session is available, without blocking chat input.

New and reconstructed workspaces run their hooks; preserved workspaces and persistent-directory projects do not. Composite sessions run member hooks in order and continue after failures. A failure is reported to linked chats but leaves the session usable. Keep hooks repeatable and non-interactive.

## Bot environments

Bots in one runner can use different environment variables, for example to give each bot its own GitHub account and commit identity. Set `bots.<id>.env` to a map of variable names to string values:

```json
"env": {
  "GH_CONFIG_DIR": "/var/lib/assistant-github/gh",
  "GIT_CONFIG_GLOBAL": "/var/lib/assistant-github/gitconfig",
  "GH_TOKEN": "",
  "GITHUB_TOKEN": ""
}
```

Set up the files this example refers to as the runner's user:

1. Sign in to `gh` in that directory with `GH_CONFIG_DIR=/var/lib/assistant-github/gh gh auth login`.
2. Create the Git config file. Git uses it in place of the user's `~/.gitconfig`. Git HTTPS operations need the credential helper, and commits need the identity:

   ```ini
   [credential "https://github.com"]
     helper =
     helper = !gh auth git-credential
   [user]
     name = Assistant
     email = assistant@example.com
   ```

The empty tokens override any token in the runner's environment, which `gh` would otherwise use in place of the signed-in account.

The map applies in two places:

- **Workspace preparation.** The bot's repository clone and fetch commands run with the runner's environment plus the map. The map wins when both set a variable.
- **New sessions.** Session tools, provision hooks, and subagents run with the session's usual environment, which has inherited secret-like variables removed, plus the map.

The runner's own environment and other bots do not change. The map does not set model-provider credentials or configure client tools.

Names and values follow these rules:

- Names must match `[A-Za-z_][A-Za-z0-9_]*`.
- Values cannot contain NUL.
- `HOME` is not allowed, because the execution environment sets it.
- Values are literal. Tau does not expand `$HOME` or `~` and does not resolve relative paths, so use absolute paths for credential directories.

Tau saves the map in each session, so do not put tokens or other secrets in it. Use paths to separately protected credential stores instead. The map is not a security boundary. Bots still share the operating-system user's permissions and repository caches, and commands can override their own environment.

### Changing a bot's environment

Restart the runner after changing or removing `env`. New sessions use the new map. A saved session whose map differs fails recovery before it accepts turns, because it would otherwise continue under the old identity. This check does not change the session's files. A session resumes normally if its map is unchanged, and that includes an older session with no saved map if the bot has no `env`.

A session that failed this check has two ways forward:

- Restore the previous `env` and restart the runner. The session then resumes.
- Start a new session with `/new`. For a repository or composite project, this deletes the old workspace, so first save any unfinished work from it on the runner machine. Persistent-directory projects keep their files.

## Troubleshooting

**Repository preparation fails.** Check that the runner machine has `gh` signed in with access to the repository, `git`, and network access. If the bot sets `env`, check the sign-in that its [environment](#bot-environments) selects. Check `repo`, `ref`, the workspace root's permissions and free space, and that `workingDirectory` exists after checkout. Changing the repository of an existing project ID rebuilds its cache. Do not delete caches or workspaces first; keep the logs and fix access or configuration.

**Startup removed unexpected files.** The workspace root was not dedicated to Tau. Stop the runner and move `workspaceRoot` to an empty directory of its own before restarting. Tau cannot restore unrelated files it deleted.

**Provisioning fails but chat still works.** This is intended: a provisioning failure does not break the session. Fix the executable bit, shebang, script, or dependencies. Then run the script by hand if it supports that, or start a new session to provision again.

**A persistent-directory session fails recovery.** Recovery rejects a saved `cwd` that differs from the configured directory. Restore the directory at its original path, or set the project config back, or start a new session in the new directory. Tau does not move an existing session to a new directory.

**A session fails recovery after a bot's `env` changes.** Recovery rejects a saved environment that differs from the bot's current `env`, and `/status` reports the failure. See [changing a bot's environment](#changing-a-bots-environment) for the ways forward.

**A recovered session does not match the current configuration.** Preserved workspaces are used as they are, and composite root files are not regenerated, so configuration changes apply only to new workspaces. Recovery also needs the same `workspaceRoot`, project definitions, bot `env`, host home, and Tau sessions. Check the runner logs and `/status`. Do not edit runner state, project preferences, saved sessions, or managed workspaces to force a match.
