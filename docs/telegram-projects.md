# Telegram projects and workspaces

A Telegram runner starts every session in a project. The project decides which repository or directory the session works in, how its workspace is prepared, and what happens to the workspace when the session ends or the runner restarts. Projects are defined under `projects` in the runner's config file and offered to chats per bot, as described in [Telegram](telegram.md).

## Project IDs and common fields

Project IDs become `/use_<projectId>` command suffixes. They must contain only lowercase letters, digits, and underscores, and may be at most 28 characters:

```text
ledger
platform_api
release2026
```

Every project can have an optional non-empty `description`. Repository and persistent-directory projects can select `persona` as `<id>` or `<id>:<reasoning>`. Composite projects require their own persona. Sessions load applicable `AGENTS.md` instructions.

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
      "persona": "gpt-6.1-sol-coder"
    }
  }
}
```

`repo` must be a GitHub `owner/repo`; other Git URLs are not accepted. The runner needs `gh` and `git` on its login shell's `PATH`, and `gh` must already be signed in with access to the repository.

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
      "directory": "/srv/tau/notes",
      "persona": "gpt-6.1-sol-coder"
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
      "persona": "gpt-6.1-sol-coder:high",
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

The composite's settings apply to the whole session: persona, subagents, model catalog, configuration, and tools. Members' `.tau/config.json` files are not merged. A subagent started in a member directory rebuilds only the context that depends on the directory: environment and repository details, the applicable `AGENTS.md`, and the skills found there.

If any member cannot be prepared, Tau removes the whole composite workspace. Composite workspaces and member caches use the top-level `workspaceRoot`.

## Managed workspace lifecycle

Repository and composite projects work the same way. Tau prepares one workspace per session, and the session keeps working there. A normal runner restart reconnects without fetching or checking out repositories, running provision hooks, or rewriting generated files. Changes to workspace preparation in the Telegram config affect only workspaces prepared later.

If the expected workspace is missing, recovery reconstructs it from the caches and current project configuration. `/new` and session close remove a managed workspace; normal shutdown preserves it. Tau does not commit, push, or save uncommitted changes elsewhere.

## Managed workspace safety

**Important:** startup removes entries under managed workspace roots that no persisted session references. Dedicate these roots to Tau; never use a home directory, repository collection, or unrelated tree.

Tau preserves referenced managed workspaces, configured persistent directories, and repository caches. `/new` closes the active session before replacing it. Closing a repository or composite session interrupts work and removes its workspace; persistent directories remain untouched.

## Provision hooks

A repository can include `.tau/scripts/provision` at its root. It must be a regular executable file, not a symlink, and start with a shebang. Tau runs it in the session's working directory once the session is available, without blocking chat input.

New and reconstructed workspaces run their hooks; preserved workspaces and persistent-directory projects do not. Composite sessions run member hooks in order and continue after failures. A failure is reported to linked chats but leaves the session usable. Keep hooks repeatable and non-interactive.

## Troubleshooting

**Repository preparation fails.** Check that the runner machine has `gh` signed in with access to the repository, `git`, and network access. Check `repo`, `ref`, the workspace root's permissions and free space, and that `workingDirectory` exists after checkout. Changing the repository of an existing project ID rebuilds its cache. Do not delete caches or workspaces first; keep the logs and fix access or configuration.

**Startup removed unexpected files.** The workspace root was not dedicated to Tau. Stop the runner and move `workspaceRoot` to an empty directory of its own before restarting. Tau cannot restore unrelated files it deleted.

**Provisioning fails but chat still works.** This is intended: a provisioning failure does not break the session. Fix the executable bit, shebang, script, or dependencies. Then run the script by hand if it supports that, or start a new session to provision again.

**A persistent-directory session fails recovery.** Recovery rejects a saved `cwd` that differs from the configured directory. Restore the directory at its original path, or set the project config back, or start a new session in the new directory. Tau does not move an existing session to a new directory.

**A recovered session does not match the current configuration.** Preserved workspaces are used as they are, and composite root files are not regenerated, so configuration changes apply only to new workspaces. Recovery also needs the same `workspaceRoot`, project definitions, host home, and Tau sessions. Check the runner logs and `/status`. Do not edit runner state, project preferences, saved sessions, or managed workspaces to force a match.
