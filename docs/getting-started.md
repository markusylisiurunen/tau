# Getting started

Tau is a terminal AI client that gives an agent tools for working in a project. It runs on macOS and Linux and requires Node.js 26 or newer.

## Install

```sh
npm install -g @markusylisiurunen/tau@latest
```

Run the same command to upgrade.

## Connect a provider

Export the API key of the provider you want to use:

```sh
export ANTHROPIC_API_KEY='sk-ant-...'
```

`OPENAI_API_KEY` and `GEMINI_API_KEY` work the same way. To use a ChatGPT subscription instead, run `tau auth login codex` and start Tau with a ChatGPT persona: `tau --persona gpt-6.1-sol-chatgpt-coder`. See [models and credentials](models-and-credentials.md).

## Run a session

```sh
cd ~/Code/my-project
tau
```

Type a request and press Enter:

```text
Run the parser tests, fix the failure, and summarize the change.
```

The agent starts in this directory and can run any command your user can run. Tau saves the session as you go. Press `Ctrl+C` twice to exit, and use `/help` to see commands and keys.

## Choose a persona

A persona selects the model, instructions, and tools. `tau --help` lists the available ones:

```sh
tau --persona gpt-6.1-sol-coder:high
```

The optional suffix sets the reasoning level. To make a choice permanent, set a default in `~/.config/tau/config.json`:

```json
{ "defaultPersona": "gpt-6.1-sol-coder:high" }
```

Inside a session, `/persona:<id>` switches persona and `Shift+Tab` cycles reasoning.

## Ask Tau about itself

The agent can read this manual, so you can ask it to configure Tau or explain a feature:

```text
Using Tau's documentation, add a project skill that runs our release checks.
```

## Prepare the shell

Every agent command runs in a fresh non-interactive login Bash. Login startup files must not print text, prompt, or need a terminal. Check that the tools you expect are found:

```sh
bash -lc 'command -v node git'
```

## Next steps

Read [how Tau works](how-tau-works.md) before using remote sessions, the SDK, or Telegram. It explains which machine each setting belongs to.
