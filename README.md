# tau

Tau is a terminal-based AI chat client for working with code.

![tau](https://raw.githubusercontent.com/markusylisiurunen/tau/main/assets/tau.png)

## Install

Tau supports macOS and Linux and requires Node.js 24 or newer.

```sh
npm install -g @markusylisiurunen/tau@latest
```

## First run

Provide a credential for the model provider you want to use:

```sh
export ANTHROPIC_API_KEY='sk-ant-...'
```

Then start Tau in a project:

```sh
cd ~/Code/my-project
tau
```

## Documentation

The [Tau documentation](docs/index.md) describes the version it ships with. Tau's agent can read the same pages, so once a session is running you can ask Tau about itself:

```text
Using Tau's built-in documentation, briefly explain what Tau can do, covering its core features, built-in tools, optional services, and integrations.
```

Or go directly to:

- [Getting started](docs/getting-started.md)
- [Configuration](docs/configuration.md)
- [Session protocol](docs/session-protocol.md)
- [Node SDK](docs/node-sdk.md)
- [Remote sessions](docs/remote-sessions.md)
- [Security](docs/security.md)
