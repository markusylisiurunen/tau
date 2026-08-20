# Configuration

Tau builds configuration from a working directory, not from one universal file. It combines shipped defaults, an eligible global level, and every project level on the path to that working directory. Knowing whose working directory is in use is as important as knowing the field name.

This page explains how the layers behave. Use [configuration reference](config-reference.md) for the fields themselves and [ownership and scope](ownership-and-scope.md) when more than one machine is involved.

## Where configuration is loaded

Tau recognizes these `config.json` locations:

| Level | Path | Included when |
| --- | --- | --- |
| Shipped defaults | Built into the installed Tau version | Always |
| Global | `~/.config/tau/config.json` | The relevant `cwd` is the home directory or lies below it |
| Project | `<ancestor>/.tau/config.json` | The ancestor is on the path from the relevant `cwd` to the discovery stop |

When `cwd` is inside home, discovery stops at home. When it is outside home, the global level is omitted and project discovery continues to the filesystem root.

Tau recognizes a project level when that ancestor contains either `.tau/` or `.agents/skills/`. A `config.json` file is optional at a recognized level. This allows skill-only levels to participate in content discovery without requiring an empty config file.

For this layout:

```text
/home/ada/
  .config/tau/config.json
  work/ledger/
    .tau/config.json
    packages/api/
      .tau/config.json
```

starting from `/home/ada/work/ledger/packages/api` loads, from least to most specific:

```text
/home/ada/.config/tau/config.json
/home/ada/work/ledger/.tau/config.json
/home/ada/work/ledger/packages/api/.tau/config.json
```

In a remote session, the session runtime uses the execution environment's `cwd` and home. An attached TUI separately loads client-local settings from the attach process's `cwd` and home.

## How levels combine

Most scalar or whole-object settings use **most-specific wins**. A value in the nearest project level replaces the corresponding value from broader levels.

In `~/.config/tau/config.json`:

```json
{
  "defaultPersona": "opus-5-chat",
  "speechToText": { "provider": "mistral" }
}
```

In `~/work/ledger/.tau/config.json`:

```json
{
  "defaultPersona": "gpt-5.6-sol-coder:high",
  "speechToText": { "provider": "gemini" }
}
```

Within the project, the effective values are the coder persona and the Gemini speech provider. Tau does not recursively combine `speechToText`; the project object replaces the global object.

A few fields intentionally use other rules:

- `apiKeys` merges by provider id. A more-specific key replaces only the same provider's value.
- `autoCompact` merges by field on top of shipped defaults.
- `modelSystemNotices` merges by normalized `<provider>/<model>` key.
- `cloudflareSandbox.bridges` merges by bridge id. A more-specific bridge replaces the complete bridge with that id.
- `flySprites.apis` merges by API id. A more-specific API replaces the complete API entry with that id.
- `agentContextFiles` is additive across levels, resolves each entry at its owning level, and removes duplicate resolved paths while preserving order.
- `diffTool` and `builtInDiffTool` select the complete object from the most-specific level that defines them.
- `subagents.defaultLaunchModels` selects the most-specific list.
- `clientTools` is defined only at global scope. `enabledClientTools` at the most-specific project level is an exact selection from those definitions.
- `history` is accepted only at global scope.

An empty project `enabledClientTools` list deliberately disables all configured command client tools for that project:

```json
{
  "enabledClientTools": []
}
```

Without `enabledClientTools`, Tau selects global client tools whose `defaultEnabled` value is `true`. Unknown selected names are ignored.

## How relative paths resolve

Relative path bases belong to the level that declares the value:

- Global `agentContextFiles` entries resolve from home.
- Project `agentContextFiles` entries resolve from the directory containing `.tau`.
- A relative `diffTool.command` containing a slash resolves from the same level root.
- A global `clientTools[].command` containing a slash resolves from home.
- A bare command such as `review-ui` is left bare and resolves through the owning process's `PATH`.

For example, in `/home/ada/work/ledger/.tau/config.json`:

```json
{
  "agentContextFiles": ["docs/AI_GUIDE.md"],
  "diffTool": {
    "command": "./tools/review-ui"
  }
}
```

Tau resolves the paths as `/home/ada/work/ledger/docs/AI_GUIDE.md` and `/home/ada/work/ledger/tools/review-ui`. In an attached session, `diffTool` used by the TUI comes from the client-local load, so this resolved command is a client path.

Other strings that happen to contain paths are not automatically rebased unless their field contract says so. In particular, hosted execution-environment `home` values are passed as configured.

## Invalid and unknown fields

Each `config.json` must contain a JSON object. Malformed JSON, wrong types, invalid enum values, unknown model targets, and fields used at a forbidden scope produce configuration warnings. Tau keeps valid fields from the same file and continues merging other levels. Run `/reload` in an idle session to see the current warnings.

If a more-specific field is invalid, it is skipped rather than replacing a valid broader value. This can make the broader value remain effective, so do not treat a warning as if the requested override took effect.

Unknown object fields are accepted and stripped without a warning. This applies at the top level and in validated nested objects. It makes newer configuration tolerable to an older binary, but it also means misspelled fields have no effect:

```json
{
  "defaultPersnoa": "gpt-5.6-sol-coder"
}
```

The example is valid JSON and produces no setting because `defaultPersnoa` is unknown. Compare edited keys against [configuration reference](config-reference.md), especially when no warning appears.

## Make a safe edit

First identify the consumer and its `cwd`, home, and machine. Then choose the narrowest valid scope:

- Personal defaults and secrets usually belong in eligible global configuration.
- Repository behavior shared by collaborators belongs in a project `.tau/config.json` when it contains no secrets or machine-local commands.
- Nested project levels are appropriate only when that subtree genuinely needs a different value.
- Client-only commands should not be placed in a remote execution environment and expected to appear on an attached laptop.

Keep examples small and edit only the intended field. Validate JSON before asking Tau to load it:

```sh
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' \
  ~/.config/tau/config.json
```

That check proves syntax only. Start Tau from the relevant `cwd` to validate field contracts and content references:

```sh
cd ~/work/ledger
tau --debug
```

`--debug` is appropriate for a local startup and can reveal project instructions in its output. It does not query an already running host, remote execution environment, or attached client's state. For a live session runtime, use `/reload` and read its configuration warnings. There is no command that serializes the complete effective configuration.

Never verify a secret by printing the full config or environment into a shared transcript. Test the operation that needs the credential, and use the auth commands for Codex OAuth accounts.

## When changes take effect

### New local or client process

Tau loads startup configuration and content before opening the TUI. Restart the local TUI or `tau attach` to apply client-owned changes such as:

- `defaultTheme`, `disableBuiltinThemes`, and theme files
- `diffTool` and `builtInDiffTool`
- `clientTools` and `enabledClientTools`
- `speechToText` for `/listen`
- client environment variables

Changing `/theme:<id>` updates only the current client presentation. Themes are not persisted in session snapshots.

### Current session runtime

Run `/reload` when no session turn is active to recollect runtime configuration and content from the execution environment. Reload updates the current session's runtime config, model catalog, personas, prompts, skills, selected persona definition, and project context. It reports warnings and refreshes the session catalog.

The current persona id is retained if it still exists; otherwise Tau chooses the first available persona. Changing `defaultPersona` does not by itself switch an existing session during reload. It selects new sessions unless a CLI or creation request overrides it.

A logical turn captures its persona, model settings, and tools when it starts. Reload is blocked while a turn is active, and reloaded behavior applies to later turns.

### Host startup

Restart the host process to apply settings used to construct host-wide services, including:

- `cloudflareSandbox.bridges`
- `flySprites.apis`
- `history`
- host environment variables and Codex account forcing

For `tau serve`, make the changes on the host machine and restart the server. Restarting only an attached TUI does not rebuild the host.

### New session or runner

Some settings are choices rather than live mutations. `defaultPersona` and startup persona flags select a new session. Execution-environment kind, identity, `cwd`, and home are fixed when the session is created or recovered.

The Telegram runner loads its speech provider and separate runner config at startup. Restart it for speech, project, routing, or workspace-preparation changes. Workspace-preparation changes apply when a managed workspace is created or reconstructed; restarting does not retrofit a preserved workspace. Command client tools are selected when a Telegram session client is created, so configuration changes apply to new sessions; restarting the runner also rebuilds clients while recovering its sessions. Existing sessions retain their recorded execution environment unless the documented recovery behavior reconstructs a managed workspace.

## Common precedence mistakes

**Editing global config for a project outside home.** The global level is omitted when the relevant `cwd` is outside home. Add an appropriate project level or change the environment's configured home rather than assuming `~/.config/tau` is always included.

**Editing the laptop for host behavior.** An attached TUI cannot provide credentials, session storage, hosted-environment definitions, or runtime project config to a remote host merely by having them locally.

**Editing the host filesystem for target content.** A hosted execution environment owns its project files and home. Put project `.tau` content on that target, not in a similarly named path on the host.

**Expecting nested objects to deep-merge.** A project bridge or Sprite API entry replaces the complete entry with the same id. Repeat required fields such as a Cloudflare bridge `url`.

**Expecting `/reload` to rebuild the client or server.** Reload is a current-session runtime operation. Restart the component that owns startup-only behavior.

**Using a project file for global-only fields.** `clientTools` and `history` are rejected outside global config. `enabledClientTools` is rejected outside project config.

**Trusting a silent typo.** Unknown fields are stripped. Check exact names and observe the resulting operation rather than assuming valid JSON means valid Tau configuration.
