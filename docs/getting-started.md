# Getting started

Tau is a terminal chat client that gives model-backed agents tools for working in a project. A local session is the shortest path to understanding it: the terminal client, session host, and execution environment all run on the same machine, while retaining the same boundaries used by remote sessions.

## Requirements

Tau supports macOS and Linux. Windows is not supported.

The published package requires Node.js 24 or newer. Tau runs commands through fresh non-interactive login Bash processes, so verify that environment from the account that will run Tau before installing:

```sh
bash -lc 'command -v node && node --version && command -v npm && npm --version'
```

The command should resolve both executables and finish without prompts, terminal errors, or unrelated startup output. Use the same check for other executables you expect the agent to use.

## Install or upgrade Tau

Install the latest published version globally:

```sh
npm install -g @markusylisiurunen/tau@latest
```

Run the same command to upgrade. Then confirm which executable and version npm installed:

```sh
command -v tau
npm list -g @markusylisiurunen/tau --depth=0
```

The built-in documentation is packaged with Tau. Upgrading the package upgrades the documentation read by `tau_docs` on that host. Tau also refreshes compatible model metadata asynchronously when a model-owning host starts. To force that refresh without upgrading Tau, run:

```sh
tau models refresh
```

## Set up a provider

A session needs credentials for the provider selected by its persona. API-key providers accept ordinary provider environment variables. For example:

```sh
export ANTHROPIC_API_KEY='sk-ant-...'
tau
```

Common built-in choices are `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY`. Keys may instead be placed in `apiKeys` in Tau configuration:

```json
{
  "apiKeys": {
    "anthropic": "sk-ant-..."
  }
}
```

Put personal secrets in the global config at `~/.config/tau/config.json`, not in a project file likely to be committed. Environment variables and feature-specific key precedence are covered in [credentials](credentials.md).

The `openai-codex` provider uses ChatGPT subscription OAuth rather than `OPENAI_API_KEY` or `apiKeys.openai`:

```sh
tau auth login codex
tau auth list
```

Use the auth commands to manage this storage. Do not edit `~/.config/tau/auth.json` directly.

## Start a local session

Change to the project directory that should become the execution environment's working directory, then run Tau:

```sh
cd ~/Code/ledger-service
tau
```

Tau discovers project configuration and content from that directory upward, loads the selected persona, creates a durable local session, and opens the TUI. The agent's file and command tools operate in this execution environment, initially rooted at the selected working directory.

Type a request and press Enter. Useful first requests are concrete and scoped:

```text
Explain the request flow through this service and point to the key files.
```

```text
Run the focused tests for the parser, fix the failure, and summarize the change.
```

Use `/help` inside the TUI to see interactive commands. Press `Ctrl+C` twice to exit. Tau persists local sessions through the host, so exiting the TUI does not require manually saving a transcript.

## Choose a persona and reasoning level

A **persona** selects a provider and model together with instructions, tools, skills, and default model settings. Tau ships built-in chat and coder personas and can load custom persona files.

Start with a specific persona by passing its exact id:

```sh
tau --persona gpt-5.6-sol-coder
```

Append a reasoning level when the selected model supports it:

```sh
tau --persona gpt-5.6-sol-coder:high
```

The accepted reasoning levels are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. A persona may expose only a subset in the TUI, and providers that do not support reasoning ignore the setting.

During a session, `/persona:<id>` changes the persona and `Shift+Tab` cycles the available reasoning levels. A running logical turn keeps the persona, reasoning, model, and tools captured when that turn began. Changes apply to the next independently started turn.

To choose a default for new sessions, set `defaultPersona`:

```json
{
  "defaultPersona": "gpt-5.6-sol-coder:high"
}
```

See [personas](personas.md) for custom persona files and exact inheritance behavior, and [models](models.md) for model catalog overrides.

## Inspect startup safely

Start with the normal help output:

```sh
tau --help
```

Tau reports configuration and content warnings on stderr during startup. Warnings identify the source path and invalid field or content entry; Tau continues with the valid portions it could load.

For a local startup, `--debug` shows the resources and tool schemas resolved for the selected working directory without opening the TUI:

```sh
tau --debug --persona gpt-5.6-sol-coder:high
```

Debug output can contain project instructions and other model-facing context, so review where it is captured before sharing it. It is a local startup inspection, not a query of an already running remote host or attached client's effective state.

After editing session runtime content, `/reload` refreshes it when no turn is active and reports warnings in the transcript. Client-local or host-startup changes require the owning process to restart. [Configuration](configuration.md) explains those boundaries.

## Continue from here

Read [ownership and scope](ownership-and-scope.md) before using `tau attach`, hosted execution environments, the SDK, or Telegram. For ordinary configuration changes, use [configuration](configuration.md) with the complete [configuration reference](config-reference.md). The [TUI](tui.md) page covers daily interaction, while [sessions](sessions.md) explains persistence, recovery, compaction, and rewind.
