---
name: cowork
description: "Cowork is Markus's personal GitHub automation service, backed by Tau. The skill explains Cowork and helps configure its repository conversations, workflows, hosted diffs, workspace hooks, and schedules. Use this skill when someone asks about Cowork or when you work on .cowork files. Trigger: balanced."
---

Cowork turns GitHub events and recurring schedules into Tau agent sessions. GitHub holds the issues, pull requests, and discussion. Cowork handles triggers, sessions, and workspaces, and each repository defines in its `.cowork/` files what its agents do. Tau agents do the work and respond on GitHub.

## Before changing configuration

1. Read the repository instructions and existing `.cowork/` files. Check `.agents/managed.json` for centrally managed paths before editing them.
2. Identify the requested change: a conversation, a workflow, hosted diff settings, workspace setup, or a recurring task. Read the relevant section of [the configuration reference](references/configuration.md).
3. Respect ownership. If configuration is centrally managed, change it at its source instead of editing the generated files. Preserve repository-owned hooks, schedules, and other local content. Do not bypass ownership conflicts.
4. Separate preparing files from activating automation. A `.cowork` directory does not prove that webhooks, repository access, or the service allowlist are configured. Enabling schedules is fine, since users review the change. Do not post bot commands, change service settings, or deploy unless the request authorizes those actions.

Cowork reads workflow configuration from the trusted default branch, never from a PR head. When you make a change, explain when it will take effect: instructions refresh on each invocation, session settings apply only to new sessions, and lifecycle hooks are pinned when a workspace is created. Changing a file in a PR does not test its live behavior.

## Using Cowork through GitHub

The default mention is `@markustherobot`, although the service can configure a different one. The mention must be the first non-whitespace content in a comment, review summary, or inline review comment, and the sender must be allowed by the service.

| Context  | Comment after the mention                                        | Behavior                                                         |
| -------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| Issue    | A question or planning request                                   | Continues the issue conversation                                 |
| Issue/PR | `/<name>` for a workflow in `.cowork/workflows/` that targets it | Starts a fresh run of that workflow, with optional guidance      |
| Issue    | `/restart` alone                                                 | Replaces the issue conversation and workspace without a turn     |
| PR       | A question or change request                                     | Continues the PR conversation, which can update the branch       |
| PR       | `/restart` alone                                                 | Replaces the PR conversation and workspace without an agent turn |
| PR       | `/diff` alone                                                    | Creates a hosted interactive review of the current head          |

Which workflows exist depends on the repository. Centrally managed repositories have `/implement` on issues, and `/review`, `/improve`, `/review-and-improve`, `/explain`, and `/rewrite` on PRs.

Ordinary messages may follow the mention on the same line. Commands must be the only token on their line after the mention; guidance starts on a later line, optionally after a blank line. Bare keywords are ordinary conversation. An unknown command, or a workflow used on the wrong kind of resource, fails with a short diagnostic.

The agent receives the request with the leading mention and recognized command removed and surrounding whitespace trimmed. Internal formatting stays unchanged. Workflow runs without guidance use “Run the selected workflow. No additional instructions were provided.” The original comment ID and URL remain available separately.

Submitting a GitHub review hands its requests to the PR conversation in one turn. The review starts work when its summary or any of its inline comments begins with the mention. Nothing runs while the review is pending. A single inline comment or thread reply is its own review, so it starts its own turn. The agent sees the whole review, but only tagged text defines the work. For example, if two inline comments are tagged and a third is not, the agent handles the two requests and reads the third as context. A tagged summary such as “address all comments in this review” brings every comment in that review into scope, but not findings from earlier reviews. Questions leave the branch and thread status unchanged, and verified changes resolve their threads. Replies go in the requested threads, and a tagged summary gets one top-level response. A slash command in a tagged summary or tagged inline comment rejects the whole review, so start commands from a top-level PR comment. Review summaries trigger work only when the service's GitHub webhook subscribes to pull request review events.

Eyes on a tagged comment means Cowork received the request. Except for `/restart`, the reaction stays after the work finishes, so it does not show whether work is still running. Cowork attempts eyes on a tagged inline review comment or thread reply as soon as its eligible webhook arrives, even while earlier work on the PR is still running. Reactions are best-effort, so a missing reaction does not mean the request was rejected. Review summaries, untagged comments, automatic reviews, and hosted diff feedback get no reaction; the response or a failure comment shows that the work ran.

Send `/restart` alone, then send the actual request in a separate comment. The request can follow immediately and queues behind the replacement. Eyes marks the pending restart; `+1` replaces it when the fresh session is ready. Success posts no comment. Trailing restart guidance is rejected. If restart fails or is interrupted before installation, the previous mapping is preserved but follow-ups fail explicitly instead of using it. Send `/restart` alone again, then resend blocked requests after it succeeds.

Submitting hosted diff feedback hands the requested work to the persistent PR conversation. That work uses the conversation's workspace, settings, and hooks. The hosted discussion itself runs no hooks. Posting a command or submitting feedback can start autonomous work, so do not treat these examples as permission to trigger it.

Eligible non-draft PRs also start the workflows whose `triggers` include a PR event, such as an automatic review or explanation, and a hosted diff when `.cowork/diff.md` exists.

Leave automatic workflows enabled by default, including for PRs created by automation. Only when explicitly requested, opt a PR out by putting the exact marker `<!-- cowork:skip-auto -->` in its description. Cowork checks the description on each opened, ready-for-review, and synchronize event. When opting out, include the marker when creating the PR or add it before the next push to an existing PR. Explicit commands still work on a marked PR. Adding the marker does not cancel work that Cowork already accepted, and removing it does not replay skipped events.

## Finding sessions in Tau history

Every new Tau session that Cowork creates records why it was created, and you can filter Tau history by these attributes. For example, a hosted diff review of pull request 680 has:

```text
source=cowork
repository=github.com/owner/repository
cowork_workflow=pull-request-diff
github_pr=680
```

- `repository` is the lowercase `host/owner/repository` form.
- `cowork_workflow` is `issue-conversation`, `pull-request-conversation`, `pull-request-diff`, or the name of the repository workflow that started the session.
- Each session also has one target attribute: `github_issue` or `github_pr` with the issue or PR number, or `cowork_schedule` with the scheduled workflow's name.

Cowork records no run ID because a persistent session can span many runs. Submitted diff feedback runs in the persistent PR conversation, so look for it under `pull-request-conversation`.

Attributes never change after a session is created. A persistent session created before Cowork recorded the workflow and target keeps its original attributes, even while it stays in use, so filters on `cowork_workflow` or a target attribute miss it. Filter by `source` and `repository` to find these sessions.

## Verify the change

Check file names, required frontmatter fields, YAML syntax, instruction content, and hook executable permissions. Cowork has no built-in instructions, so a conversation or workflow file must state the whole task, including its GitHub output. Validate the change with the owning repository's existing checks. Do not run lifecycle scripts against a real workspace just to test them.

When behavior is unclear, say so instead of inventing configuration keys. Use only the fields and files documented in [the configuration reference](references/configuration.md). Keep credentials and service deployment outside repository configuration work.
