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

The [canonical Tau documentation](docs/tau/index.md) is the version-matched guide to using, managing, and configuring Tau. Start there for the complete operational documentation, or go directly to:

- [Getting started](docs/tau/getting-started.md)
- [Configuration](docs/tau/configuration.md)
- [Remote sessions](docs/tau/remote-sessions.md)
- [Security](docs/tau/security.md)

Tau also ships this corpus to agents through the intrinsic `tau_docs` tool, so agents and people can work from the same contracts.

## Developer references

The operational corpus intentionally leaves wire-level and typed SDK detail to these focused references:

- [RPC protocol](docs/rpc.md)
- [Node SDK](docs/sdk.md)
