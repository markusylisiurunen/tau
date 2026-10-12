# Cowork repository configuration

## Session settings

`.cowork/config.json` accepts a `workflows` object with these IDs:

- `issue-plan`
- `issue-implement`
- `pull-request-review`
- `pull-request-deslop`
- `pull-request-fix` (the persistent PR conversation, including submitted diff feedback)
- `pull-request-explain`
- `pull-request-diff` (the hosted discussion)

For example, change review reasoning while keeping the repository's normal Tau persona:

```json
{
  "workflows": {
    "pull-request-review": { "reasoning": "high" }
  }
}
```

Each entry may be empty, specify `reasoning` alone, or specify both `persona` and `reasoning`. Missing or empty entries keep Tau's repository-resolved defaults. Entries with only a `persona`, and standalone `model` fields, are not supported. Use an exact available Tau persona ID without a reasoning suffix. Cowork accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` as reasoning values. Choose one that is supported by the selected persona and provider.

Cowork reads session settings only when it creates a session, so existing persistent sessions keep their settings through configuration changes and service restarts. To adopt changed settings, restart the conversation or start a fresh hosted diff.

## Workflow guidance

Use `.cowork/prompts/<workflow-id>.append.md` for additive guidance. For example, `issue-implement.append.md` could contain:

```markdown
Run the repository's focused checks for every changed component before opening the pull request. Explain any checks that could not run.
```

Prompts are supported for the six ordinary workflow IDs listed above. `pull-request-diff` supports only session settings. There is no standalone diff-feedback prompt; feedback runs through `pull-request-fix`.

A `<workflow-id>.md` file replaces the built-in workflow instructions. If both files exist, the append comes after the replacement. Either way, Cowork's execution contract, invocation facts, and triggering request are always included. Prefer an append unless the user needs a replacement and understands the built-in guidance it removes.

Prompts are refreshed from the default branch on every invocation, including resumed sessions. A missing file falls back to the default, but an invalid file that is present makes the workflow fail.

Built-in reviews can use parallel subreviews when trusted append guidance specifies an exact launch model. If that prompt is centrally managed, change its source instead of editing the generated prompt by hand. A replacement review prompt must define its own subagent behavior.

## Workspace hooks

Optional executable files under `.cowork/scripts/` control workspace setup:

| File       | When it runs                                           | Typical purpose                  |
| ---------- | ------------------------------------------------------ | -------------------------------- |
| `init`     | Once per fresh workspace, before session creation      | Durable workspace setup          |
| `activate` | Before every new turn, including the first             | Recreate disposable dependencies |
| `idle`     | After a persistent workspace's configured quiet period | Remove disposable state          |

Each file needs a valid shebang and executable permission committed to Git. Scripts run directly from the workspace root with closed stdin and a five-minute timeout. The environment excludes Cowork's own `COWORK_*` settings and package-manager production settings such as `NODE_ENV`. Never print credentials.

Hooks come from the trusted default branch. Cowork takes a snapshot of `activate` and `idle` before running `init`, so later branch changes cannot replace those scripts. A retained workspace keeps these pinned hooks.

`activate` and `idle` can encounter a dirty worktree, a different branch, or missing component directories. Detect the files needed for setup, preserve tracked and untracked work, and never reset, clean, stash, or switch branches as lifecycle housekeeping. Failed runs can be retried, so make idle cleanup idempotent.

A trusted hook can still execute untrusted worktree code indirectly. For example, `npm ci` can run scripts from the checked-out `package.json`. Use `--ignore-scripts` where appropriate, or use an isolated runner for untrusted branches. Do not run a program from the worktree just because it exists.

## Recurring tasks

Each `.cowork/schedules/<schedule-id>.md` defines one recurring task. Use lowercase letters or digits separated by hyphens for the filename. For example:

```markdown
---
schedule: "0 9 * * 1"
timezone: Europe/Helsinki
---

Inspect open dependency update pull requests. Post a summary in the designated tracking issue. Do not merge or modify branches.
```

State the allowed actions and any expected output explicitly in the body, because Cowork does not automatically publish success or failure comments for scheduled runs.

Enabled definitions require a five-field cron expression and a non-empty Markdown body. `enabled` defaults to `true`, so omitting it can activate a task. `timezone` defaults to `UTC` and accepts IANA names. Usually leave out `persona` and `reasoning`, so the task uses Tau's repository-resolved default persona. To override them, put them in this frontmatter instead of `config.json`. They follow the session-setting rules above. Unknown fields are invalid. A disabled definition does not require a schedule or body. An invalid file disables only its own schedule.

Discovery requires an explicit service-side `COWORK_REPOSITORIES` allowlist. Cowork reads the trusted default branch at startup and polls every 12 minutes. Each occurrence pins its definition and settings and starts in a fresh workspace. Missed occurrences are not backfilled. A schedule may have only one pending or running occurrence at a time, so overlapping occurrences are skipped. A schedule file does not run until the repository is in that allowlist.
