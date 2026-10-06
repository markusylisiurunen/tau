# Getting started

Tau is a terminal chat client that gives AI agents tools for working in a project. The quickest way to learn it is a local session, where the terminal client, the session host, and the agent's execution environment all run on your machine. Remote sessions use the same three parts on different machines.

## Requirements

Tau supports macOS and Linux. Windows is not supported.

The published package requires Node.js 24 or newer. Tau runs every command in a fresh non-interactive login Bash process. Before installing, check that environment from the account that will run Tau:

```sh
bash -lc 'command -v node && node --version && command -v npm && npm --version'
```

The command should find both executables and finish without prompts, terminal errors, or extra startup output. Use the same check for any other executable you expect the agent to use.

## Install or upgrade Tau

Install the latest published version globally:

```sh
npm install -g @markusylisiurunen/tau@latest
```

Run the same command to upgrade. Then check which executable and version npm installed:

```sh
command -v tau
npm list -g @markusylisiurunen/tau --depth=0
```

The built-in documentation is part of the package, so upgrading Tau also upgrades the documentation its agent reads. Tau also refreshes compatible model metadata in the background when a host that runs models starts. To refresh it without upgrading Tau, run:

```sh
tau models refresh
```

## Set up a provider

A session needs credentials for the provider that its persona uses. Providers that use API keys read their usual environment variables. For example:

```sh
export ANTHROPIC_API_KEY='sk-ant-...'
tau
```

Common choices are `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY`. You can also put keys in `apiKeys` in Tau configuration:

```json
{
  "apiKeys": {
    "anthropic": "sk-ant-..."
  }
}
```

Put personal secrets in the global config at `~/.config/tau/config.json`. A project file is likely to be committed. [Credentials](credentials.md) covers environment variables and which key wins for each feature.

The `openai-codex` provider signs in with a ChatGPT subscription through OAuth. It does not use `OPENAI_API_KEY` or `apiKeys.openai`:

```sh
tau auth login codex
tau auth list
```

Manage this storage with the auth commands. Do not edit `~/.config/tau/auth.json` directly.

## Start a local session

Change to the project directory you want the agent to work in, then run Tau:

```sh
cd ~/Code/ledger-service
tau
```

Tau finds project configuration and content from that directory upward, loads the selected persona, creates a local session that is saved automatically, and opens the TUI. The agent's file and command tools start in this directory.

Type a request and press Enter. Good first requests are concrete and limited in scope:

```text
Explain the request flow through this service and point to the key files.
```

```text
Run the focused tests for the parser, fix the failure, and summarize the change.
```

Use `/help` inside the TUI to see interactive commands. Press `Ctrl+C` twice to exit. Tau saves the session as you go, so there is nothing to save before exiting.

## Choose a persona and reasoning level

A **persona** selects a provider and model, together with instructions, tools, skills, and default model settings. Tau ships built-in chat and coder personas and can load custom persona files.

To start with a specific persona, pass its exact id:

```sh
tau --persona gpt-6.1-sol-coder
```

Append a reasoning level when the model supports it:

```sh
tau --persona gpt-6.1-sol-coder:high
```

The reasoning levels are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. A persona may offer only some of them in the TUI. Providers that do not support reasoning ignore the setting.

During a session, `/persona:<id>` changes the persona and `Shift+Tab` cycles through the available reasoning levels. A turn that is already running keeps the persona, reasoning, model, and tools it started with. Changes apply from the next turn.

To set a default for new sessions, use `defaultPersona`:

```json
{
  "defaultPersona": "gpt-6.1-sol-coder:high"
}
```

See [personas](personas.md) for custom persona files and how inheritance works, and [models](models.md) for model catalog overrides.

## Inspect startup

Start with the help output:

```sh
tau --help
```

Tau prints configuration and content warnings to stderr at startup. Each warning names the source path and the invalid field or entry. Tau continues with everything else it could load.

For a local startup, `--debug` shows the resources and tool schemas resolved for the current directory without opening the TUI:

```sh
tau --debug --persona gpt-6.1-sol-coder:high
```

Debug output can include project instructions and other text sent to the model, so check where it ends up before sharing it. It inspects only a local startup. It cannot show the effective state of a running remote host or an attached client.

After you edit configuration or content that the session loads, `/reload` refreshes it when no turn is running and reports warnings in the transcript. Changes to client settings or host startup settings need a restart of that process. [Configuration](configuration.md) explains which changes apply where.

## Continue from here

Read [ownership and scope](ownership-and-scope.md) before using `tau attach`, hosted execution environments, the SDK, or Telegram. For everyday configuration, use [configuration](configuration.md) together with the [configuration reference](config-reference.md). [TUI](tui.md) covers daily use, and [sessions](sessions.md) explains saving, recovery, compaction, and rewind.
