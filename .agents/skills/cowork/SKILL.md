---
name: cowork
description: "Cowork is Markus's personal GitHub automation service, backed by Tau. The skill explains Cowork and helps configure its repository workflows, prompts, PR commands, workspace hooks, and schedules. Use this skill when someone asks about Cowork or when you work on .cowork files. Trigger: balanced."
---

Cowork turns GitHub events and recurring schedules into Tau agent sessions. GitHub holds the issues, pull requests, and discussion. Cowork handles triggers and workspaces. Tau agents do the work and respond on GitHub.

## Before changing configuration

1. Read the repository instructions and existing `.cowork/` files. Check `.agents/managed.json` for centrally managed paths before editing them.
2. Identify the requested change: session settings, workflow guidance, a PR command, workspace setup, or a recurring task. Read the relevant section of [the configuration reference](references/configuration.md).
3. Respect ownership. If configuration is centrally managed, change it at its source instead of editing the generated files. Preserve repository-owned hooks, schedules, and other local content. Do not bypass ownership conflicts.
4. Separate preparing files from activating automation. A `.cowork` directory does not prove that webhooks, repository access, or the service allowlist are configured. Enabling schedules is fine, since users review the change. Do not post bot commands, change service settings, or deploy unless the request authorizes those actions.

Cowork reads workflow configuration from the trusted default branch, never from a PR head. When you make a change, explain when it will take effect: prompts refresh on each invocation, session settings apply only to new sessions, and lifecycle hooks are pinned when a workspace is created. Changing a file in a PR does not test its live behavior.

## Using Cowork through GitHub

The default mention is `@markustherobot`, although the service can configure a different one. The mention must be the first non-whitespace content in a comment, and the sender must be allowed by the service.

| Context | Comment after the mention                                          | Behavior                                                                   |
| ------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Issue   | A question or planning request                                     | Continues the issue's planning session                                     |
| Issue   | `/implement`, with optional guidance on subsequent lines           | Starts a fresh implementation attempt that can push a branch and open a PR |
| Issue   | `/restart` alone                                                   | Replaces the planning session and workspace without an agent turn          |
| PR      | A question or change request                                       | Continues the PR conversation, which can update the branch                 |
| PR      | `/review` or `/deslop`, with optional guidance on subsequent lines | Starts a fresh review or branch cleanup                                    |
| PR      | `/explain`, with optional guidance on subsequent lines             | Updates a persistent explanation comment                                   |
| PR      | `/restart` alone                                                   | Replaces the PR conversation and workspace without an agent turn           |
| PR      | `/diff` alone                                                      | Creates a hosted interactive review of the current head                    |
| PR      | `/<name>` from `.cowork/commands/`, with optional guidance         | Starts a fresh run of a repository-defined command                         |

Ordinary messages may follow the mention on the same line. Commands must be the only token on their line after the mention; guidance starts on a later line, optionally after a blank line. Bare keywords are ordinary conversation. There is no explanation restart command.

The agent receives the request with the leading mention and recognized command removed and surrounding whitespace trimmed. Internal formatting stays unchanged. Agent-starting commands without guidance use “Run the selected workflow. No additional instructions were provided.” The original comment ID and URL remain available separately.

Send `/restart` alone, then send the actual request in a separate comment. The request can follow immediately and queues behind the replacement. Eyes marks the pending restart; `+1` replaces it when the fresh session is ready. Success posts no comment. Trailing restart guidance is rejected. If restart fails or is interrupted before installation, the previous mapping is preserved but follow-ups fail explicitly instead of using it. Send `/restart` alone again, then resend blocked requests after it succeeds.

Submitting hosted diff feedback hands the requested work to the persistent PR conversation. That work uses the conversation's settings instead of the hosted discussion's settings. Posting a command or submitting feedback can start autonomous work, so do not treat these examples as permission to trigger it.

When the service enables them, eligible non-draft PRs can also receive automatic reviews, hosted diffs, and explanations. These switches belong to the service, and repository configuration cannot change them.

## Verify the change

Check exact workflow IDs, supported fields, JSON or YAML syntax, prompt content, and hook executable permissions. Prefer append guidance over replacing built-in workflow instructions. Validate the change with the owning repository's existing checks. Do not run lifecycle scripts against a real workspace just to test them.

When behavior is unclear, say so instead of inventing configuration keys. Use only the fields and files documented in [the configuration reference](references/configuration.md). Keep credentials and service deployment outside repository configuration work.
