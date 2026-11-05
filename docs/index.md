# Tau documentation

This is the manual for the Tau version it ships with, for people and agents who use, operate, or integrate Tau. It covers what you need to get work done. For implementation details, read the [source](https://github.com/markusylisiurunen/tau).

## Start

- [Getting started](getting-started.md): install Tau and run a first session.
- [How Tau works](how-tau-works.md): client, host, and execution environment, and what runs where.

## Use Tau

- [TUI](tui.md): the commands and keys worth knowing.
- [Sessions](sessions.md): turns, compaction, rewind, reload, recovery, and usage.
- [Troubleshooting](troubleshooting.md): how to find out why something does not apply.

## Set up the agent

- [Configuration](configuration.md): `config.json` fields, levels, and when changes apply.
- [Models and credentials](models-and-credentials.md): API keys, Codex accounts, and the model catalog.
- [Personas](personas.md): model, prompt, reasoning, and tools.
- [Instructions and skills](instructions-and-skills.md): `AGENTS.md`, prompt templates, and skills.

## Extend what the agent can do

- [Tools](tools.md): built-in tools, background jobs, and command-line tools.
- [Code mode](code-mode.md): programs that combine tools in one call, with examples.
- [MCP](mcp.md): connect MCP servers.
- [Subagents](subagents.md): background workers, including Claude Code.
- [Client tools](client-tools.md): tools that run in the attached client.

## Run Tau as a service

- [Remote sessions](remote-sessions.md): `tau serve`, `tau attach`, and Fly Sprites.
- [Telegram](telegram.md): bots, projects, workspaces, and chat use.
- [History](history.md): transcript search and the optional shared service.
- [Security](security.md): what Tau does and does not protect against.

## Integrate

- [Node SDK](sdk.md): create and control sessions from Node.
- [Session protocol](session-protocol.md): the WebSocket protocol and its methods.

## Command-line tools

- [PDF unpacking](pdf-unpacking.md): OCR a PDF into Markdown and page images.
- [Image generation](image-generation.md): generate and edit images.
- [Speech generation](speech-generation.md): narration and dialogue as a WAV file.
- [OpenRouter](openrouter.md): typed decisions and text or media analysis.
