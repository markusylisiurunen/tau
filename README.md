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

The [Tau documentation](docs/index.md) is the complete version-matched guide for people and agents. Start there, or go directly to:

- [Getting started](docs/getting-started.md)
- [Configuration](docs/configuration.md)
- [Session protocol](docs/session-protocol.md)
- [Node SDK](docs/node-sdk.md)
- [Remote sessions](docs/remote-sessions.md)
- [Security](docs/security.md)

Tau ships the same corpus to agents through the intrinsic `tau_docs` tool, so agents and people work from the same contracts.
