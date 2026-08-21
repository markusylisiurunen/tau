# Tau documentation

Tau ships this canonical product guide with the host so agents and people can work from the same version-matched contracts. It covers supported operation, configuration, integrations, and troubleshooting, including the machine boundaries that matter in local and remote sessions.

The intrinsic `tau_docs` tool reads one exact Markdown path at a time. It does not search files, list current settings, or inspect client-local state. Start here, choose the page that matches the task, and pass its flat path exactly.

## Start and orient

- [Getting started](getting-started.md) covers installation, provider setup, and a first local session.
- [Ownership and scope](ownership-and-scope.md) explains the client, host, execution environment, and Telegram runner. Read it before changing paths or remote-session configuration.
- [TUI](tui.md) covers interactive commands, keybindings, themes, speech, and local presentation behavior.
- [Troubleshooting](troubleshooting.md) provides checks for common startup, configuration, provider, tool, and remote-session failures.

## Configure Tau

- [Configuration](configuration.md) explains discovery, precedence, safe edits, reload behavior, and common scope mistakes.
- [Configuration reference](config-reference.md) defines every current top-level `config.json` field and its apply boundary.
- [Credentials](credentials.md) covers API keys, Codex OAuth accounts, secret precedence, and credential ownership.
- [Models](models.md) explains the model catalog and layered `models.json` overrides.
- [Personas](personas.md) covers model-facing behavior, reasoning, tools, and persona files.
- [Subagents](subagents.md) explains available subagents, launch policy, model overrides, and supervision.
- [Skills](skills.md) covers discovery, frontmatter, trigger sensitivity, and tool eligibility.
- [Prompts and project context](prompts-and-project-context.md) explains prompt templates, `AGENTS.md`, and additional context files.
- [Client tools](client-tools.md) covers command-backed tools that execute on the owning client.
- [Security](security.md) summarizes trust boundaries, secret handling, process execution, and remote access.

## Build integrations

- [Session protocol](session-protocol.md) explains transports, envelopes, observed state, delta application, errors, and client rules.
- [Session protocol method reference](session-protocol-methods.md) defines the complete current request surface and result shapes.
- [Node SDK](node-sdk.md) covers client choices, the public session facade, streamed state, client tools, cancellation, and exported types.
- [SDK browser diff review](sdk-diff-review.md) covers hosting the built-in review UI, durable state, one-shot submission, and lifecycle ownership.

## Work with sessions and services

- [Tools](tools.md) explains built-in tool availability, execution, cancellation, and code-mode tools.
- [Sessions](sessions.md) covers creation, turns, queueing, compaction, rewind, goals, recovery, and persistence.
- [Remote sessions](remote-sessions.md) explains `serve`, `attach`, remote paths, and transport authentication.
- [History](history.md) covers local transcript history, optional remote replication, and the history tool.
- [Nook](nook.md) explains configuration and operation of the optional static mini-app platform.
- [Telegram](telegram.md) covers runner configuration, projects, workspaces, routing, and recovery.
