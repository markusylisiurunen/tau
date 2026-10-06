# Tau documentation

These pages describe how to install, configure, operate, and integrate the version of Tau they ship with. Tau's agent reads the same pages through its built-in documentation tool, one page at a time.

## Start and orient

- [Getting started](getting-started.md): install Tau, set up a provider, and run a first local session.
- [Ownership and scope](ownership-and-scope.md): which machine runs what in local and remote sessions. Read it before changing paths or remote-session configuration.
- [TUI](tui.md): interactive commands, keybindings, themes, speech, and other terminal behavior.
- [Troubleshooting](troubleshooting.md): checks for common startup, configuration, provider, tool, and remote-session problems.

## Configure Tau

- [Configuration](configuration.md): where configuration lives, which layer wins, how to edit safely, and when changes apply.
- [Configuration reference](config-reference.md): every top-level `config.json` field and when a change takes effect.
- [Credentials](credentials.md): API keys, Codex OAuth accounts, key precedence, and where credentials belong.
- [Models](models.md): the bundled model catalog and how it is refreshed.
- [Personas](personas.md): model, instructions, reasoning, tools, and custom persona files.
- [Subagents](subagents.md): when agents can start subagents, which models they may use, and how to supervise them.
- [Skills](skills.md): skill discovery, frontmatter, trigger sensitivity, and tool eligibility.
- [Prompts and project context](prompts-and-project-context.md): prompt templates, `AGENTS.md`, and extra context files.
- [Client tools](client-tools.md): command-backed tools that run on the machine of the attached client.
- [Security](security.md): trust boundaries, secrets, process execution, and remote access.

## Build integrations

- [Session protocol](session-protocol.md): transports, message envelopes, session state, deltas, errors, and rules for clients.
- [Session protocol method reference](session-protocol-methods.md): every request method and its result.
- [Node SDK](node-sdk.md): choosing a client, the session API, streamed state, client tools, cancellation, and exported types.
- [SDK browser diff review](sdk-diff-review.md): hosting the built-in review UI from an SDK application.

## Work with sessions and services

- [Tools](tools.md): built-in tools, when they are available, how they run and stop, and code-mode tools.
- [Sessions](sessions.md): creating sessions, turns, queueing, compaction, rewind, recovery, and storage.
- [Remote sessions](remote-sessions.md): `serve`, `attach`, remote paths, and authentication.
- [History](history.md): searchable local history, optional remote replication, and the history tool.
- [Nook](nook.md): setting up and running the optional static mini-app platform.
- [Telegram](telegram.md): running the Telegram runner, bot access, chat commands, attachments, and recovery.
- [Telegram projects and workspaces](telegram-projects.md): repository, persistent-directory, and composite projects, workspace lifecycle, and provision hooks.

## Run command-line tools

- [PDF unpacking](pdf-unpacking.md): OCR PDFs with Mistral into Markdown and page images.
- [Image generation](image-generation.md): generate and edit images with Google and OpenAI.
- [Speech generation](speech-generation.md): narration and dialogue with ElevenLabs voices, assembled into long WAV files.
- [OpenRouter](openrouter.md): typed decisions and text, image, audio, and video understanding with fixed models.
