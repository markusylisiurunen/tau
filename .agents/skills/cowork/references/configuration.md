# Cowork repository configuration

Cowork provides the triggers, sessions, and workspaces. The repository decides what each agent does: every agent Cowork can start is defined by one Markdown file on the trusted default branch, and Cowork has no built-in workflow instructions to fall back on.

```text
.cowork/
  conversations/issue.md          the issue conversation
  conversations/pull-request.md   the PR conversation, submitted reviews, and diff feedback
  diff.md                         hosted diffs
  workflows/<name>.md             commands, PR event workflows, and schedules
  scripts/                        workspace hooks
```

Every file is UTF-8, at most 32 KiB, and starts with YAML frontmatter. Unknown frontmatter fields are invalid. A missing file turns its feature off for the repository: a tagged issue or PR comment fails with a short diagnostic, and hosted diffs do not start.

## Session settings

Every file requires `persona` and `reasoning`. Use an exact available Tau persona ID without a reasoning suffix. Cowork accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` as reasoning values. Choose one that is supported by the selected persona and provider.

Cowork reads session settings only when it creates a session, so existing persistent conversations keep their settings through configuration changes and service restarts. To adopt changed settings, restart the conversation or start a fresh hosted diff.

## Conversations

`conversations/issue.md` and `conversations/pull-request.md` hold the settings and the instructions for the persistent conversation on each issue and PR. For example:

```markdown
---
persona: gpt-6.2-sol-chatgpt-coder
reasoning: medium
---

Work through the issue with the user until you agree on a direction that is solid enough to implement. Do not modify repository files. Post exactly one issue comment per request.
```

Cowork tells the agent which issue or PR it works on, that GitHub is the source of truth, how to catch up on each turn, and how to keep its workspace current. For the PR conversation, each request also carries a contract for its kind, such as a top-level comment, an inline review comment, a submitted review, or diff feedback, with its scope and where to reply. The body decides everything else, such as whether the agent may change code, how it verifies and pushes, and how it writes.

The body is refreshed from the default branch on every request. The conversation keeps its instructions in the session history and follows the newest copy from the next request. Compaction tries to keep them word for word but may still shorten or lose them. If a long-running conversation stops following its guidance, `/restart` gives it a fresh copy on the next request.

## Hosted diffs

`diff.md` holds only the hosted discussion's settings and must have an empty body:

```markdown
---
persona: gpt-6.1-terra-chatgpt-coder
reasoning: medium
---
```

With the file present, Cowork hosts a diff for every eligible PR head, and `/diff` creates a fresh one. Submitted feedback runs in the PR conversation.

## Workflows

Each `workflows/<name>.md` defines one workflow. The name must start with a lowercase letter and contain only lowercase letters, digits, or hyphens, up to 64 characters. `diff` and `restart` are reserved. The body is the complete task: the agent's final response is not posted, so the body must ask for any commits, pushes, description updates, reviews, or comments it wants. Cowork wraps it with its GitHub identity and writing rules, the issue or PR, the trigger, and the triggering comment. For example:

```markdown
---
target: pull-request
triggers: [command]
persona: gpt-6.2-sol-chatgpt-coder
reasoning: medium
---

Check that the changelog covers every user-visible change in this pull request. Add missing entries, commit, and push to the pull request branch. Then post a short comment on the pull request listing what you added.
```

`target` is required:

| `target`       | Allowed triggers                                        | Starts in                                             |
| -------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| `pull-request` | `command`, `pull_request.ready`, `pull_request.updated` | A default-branch clone, told to check out the PR head |
| `issue`        | `command`                                               | A default-branch clone                                |
| `repository`   | None; requires `schedule` and `timezone`                | A default-branch clone                                |

`triggers` lists one or more triggers:

- `command`: a top-level comment `@markustherobot /<name>`, optionally with guidance on later lines.
- `pull_request.ready`: the PR first becomes ready for review, either opened as a non-draft or marked ready for the first time. It fires once per PR.
- `pull_request.updated`: the head of a ready PR changes, or the PR is marked ready again after being a draft.

The event triggers follow the draft, `<!-- cowork:skip-auto -->`, and PR-author rules. For event runs, the wrapper gives the base and head commits, and the previous head after a push.

Every run gets a fresh session and workspace and has its own queue for each issue or PR, so different workflows can run on the same PR at once. Do not start two workflows that push to the same branch in parallel. A queued event run is replaced by a newer event run of the same workflow on the same PR. Command runs are never replaced. Definitions are read from the default branch when a run starts.

Cowork treats the end of an agent turn as the end of the run. It therefore creates new sessions with Tau notifications turned off, so a subagent that finishes does not wake the main agent or start a new turn. When a conversation or workflow delegates work, it must have the agent wait for its subagents and finish within the same turn. Work still running when the turn ends is not reported by that run.

## Workspace hooks

Optional executable files under `.cowork/scripts/` control workspace setup for agent workflows:

| File       | When it runs                                           | Typical purpose                  |
| ---------- | ------------------------------------------------------ | -------------------------------- |
| `init`     | Once per fresh workspace, before session creation      | Durable workspace setup          |
| `activate` | Before every turn Cowork submits, including the first  | Recreate disposable dependencies |
| `idle`     | After a persistent workspace's configured quiet period | Remove disposable state          |

`/restart` creates a fresh workspace and runs `init`, but it starts no turn, so `activate` first runs with the next request. Hosted diffs run none of these hooks when they are created or restored. Files that hooks already installed in an existing diff workspace stay until normal workspace cleanup. Submitted diff feedback runs in the PR conversation's workspace, which uses the normal hooks.

Each file needs a valid shebang and executable permission committed to Git. Scripts run directly from the workspace root with closed stdin and a five-minute timeout. The environment excludes Cowork's own `COWORK_*` settings and package-manager production settings such as `NODE_ENV`. Never print credentials.

Hooks keep the service's `TMPDIR`, which points to the `/agent-tmp` volume. The host deletes files there once they are older than seven days, even if something still uses them. Remove temporary files when you are done with them, and keep anything a later turn needs in the workspace. Programs that write to `/tmp` directly ignore `TMPDIR` and get the service's private `/tmp` instead.

Hooks come from the trusted default branch. Cowork takes a snapshot of `activate` and `idle` before running `init`, so later branch changes cannot replace those scripts. A retained workspace keeps these pinned hooks.

`activate` and `idle` can encounter a dirty worktree, a different branch, or missing component directories. Detect the files needed for setup, preserve tracked and untracked work, and never reset, clean, stash, or switch branches as lifecycle housekeeping. Failed runs can be retried, so make idle cleanup idempotent.

Cowork asks Tau to keep a persistent session's live runtime loaded for three days after each request, so idle subagents from earlier requests can be reused. This is best effort. If Tau restarts or unloads the runtime anyway, its subagents are lost, and the next request resumes the saved session without them. The three days are separate from the 14-day expiry of the conversation and workspace. `idle` does not wait for this retention or for running subagents and background jobs, so it can remove state they still use. Limit `idle` to state that later turns can recreate.

A trusted hook can still execute untrusted worktree code indirectly. For example, `npm ci` can run scripts from the checked-out `package.json`. Use `--ignore-scripts` where appropriate, or use an isolated runner for untrusted branches. Do not run a program from the worktree just because it exists.

## Recurring tasks

A workflow with `target: repository` runs on a schedule. For example:

```markdown
---
target: repository
schedule: "0 9 * * 1"
timezone: Europe/Helsinki
persona: gpt-6.2-sol-chatgpt-coder
reasoning: medium
---

Inspect open dependency update pull requests. Post a summary in the designated tracking issue. Do not merge or modify branches.
```

State the allowed actions and any expected output explicitly in the body, because Cowork does not automatically publish success or failure comments for scheduled runs.

`schedule` is a five-field cron expression, and `timezone` is an IANA name such as `UTC`. To pause a schedule, delete its file. An invalid file disables only its own schedule.

Discovery requires an explicit service-side `COWORK_REPOSITORIES` allowlist. Cowork reads the trusted default branch at startup and polls every 12 minutes. Each occurrence pins its definition and settings and starts in a fresh workspace. Missed occurrences are not backfilled. A schedule may have only one pending or running occurrence at a time, so overlapping occurrences are skipped. A schedule does not run until the repository is in that allowlist.
