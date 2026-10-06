# Configuration

Tau builds configuration for a working directory. It combines the shipped defaults, the global level when it applies, and every project level on the path to that directory. The same field can therefore have different values on different machines or in different directories, so first find out which working directory applies.

This page explains how the layers behave. Use [configuration reference](config-reference.md) for the fields themselves and [ownership and scope](ownership-and-scope.md) when more than one machine is involved.

## Where configuration is loaded

Tau recognizes these `config.json` locations:

| Level | Path | Included when |
| --- | --- | --- |
| Shipped defaults | Built into the installed Tau version | Always |
| Global | `~/.config/tau/config.json` | The relevant `cwd` is the home directory or lies below it |
| Project | `<ancestor>/.tau/config.json` | The ancestor is on the path from the relevant `cwd` to the discovery stop |

When `cwd` is inside home, discovery stops at home. When it is outside home, the global level is omitted and project discovery continues to the filesystem root.

A directory counts as a project level when it contains `.tau/` or `.agents/skills/`. The level does not need a `config.json` file, so a directory with only skills still takes part in content discovery.

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

In a remote session, the session uses the `cwd` and home of the execution environment. An attached TUI loads its own client settings from the `cwd` and home of the `tau attach` process.

## How levels combine

For most fields, **the most specific level wins**. A value in the nearest project level replaces the same field from broader levels, including whole objects.

In `~/.config/tau/config.json`:

```json
{
  "defaultPersona": "sonnet-5.5-coder"
}
```

In `~/work/ledger/.tau/config.json`:

```json
{
  "defaultPersona": "gpt-6.1-sol-coder:high"
}
```

Within the project, the effective default persona is `gpt-6.1-sol-coder:high`.

A few fields use other rules:

- `apiKeys` is global-only; project values are rejected.
- `modelSystemNotices` merges by normalized `<provider>/<model>` key.
- `flySprites` configures one connection; more-specific connection fields replace broader values.
- `subagents.launchModels` selects the most-specific list.
- `clientTools` is defined only at global scope. `enabledClientTools` at the most-specific project level is an exact selection from those definitions.
- `history` is accepted only at global scope.

An empty `enabledClientTools` list in a project disables all command client tools for that project:

```json
{
  "enabledClientTools": []
}
```

Without `enabledClientTools`, Tau selects global client tools whose `defaultEnabled` value is `true`. Unknown selected names are ignored.

## How relative paths resolve

A relative path resolves from the level that declares it:

- A global `clientTools[].command` containing a slash resolves from home.
- A bare command such as `git` is left bare and resolves through the owning process's `PATH`.

Other fields that contain paths are used as written, unless the field's reference entry says otherwise. For example, the `home` value of a hosted execution environment is passed on unchanged.

## Invalid and unknown fields

Each `config.json` must contain a JSON object. Malformed JSON, wrong types, invalid enum values, unknown model targets, and fields used at a forbidden scope produce configuration warnings. Tau keeps valid fields from the same file and continues merging other levels. Run `/reload` in an idle session to see the current warnings.

An invalid field is skipped. If a broader level sets the same field validly, that broader value stays in effect. A warning therefore means your override did not apply.

Unknown fields are removed without a warning, both at the top level and inside nested objects. This lets an older Tau version read configuration written for a newer one. It also means a misspelled field silently has no effect:

```json
{
  "defaultPersnoa": "gpt-6.1-sol-coder"
}
```

This is valid JSON but sets nothing, because `defaultPersnoa` is not a known field. Check edited keys against the [configuration reference](config-reference.md), especially when no warning appears.

## Make a safe edit

First find out what reads the setting, and on which machine, `cwd`, and home. Then choose the narrowest level that works:

- Personal defaults and secrets usually belong in global configuration.
- Settings for a repository that collaborators share belong in the project's `.tau/config.json`, as long as they contain no secrets or machine-specific commands.
- Use a nested project level only when that subdirectory needs a different value.
- Client commands belong on the client. Defining them in a remote execution environment does not make them appear on an attached laptop.

Keep examples small and edit only the intended field. Validate JSON before asking Tau to load it:

```sh
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' \
  ~/.config/tau/config.json
```

That check covers syntax only. To validate fields and content references, start Tau from the relevant `cwd`:

```sh
cd ~/work/ledger
tau --debug
```

`--debug` inspects a local startup, and its output can include project instructions. It cannot show the state of a running host, a remote execution environment, or an attached client. For a running session, use `/reload` and read its configuration warnings. No command prints the complete effective configuration.

Never check a secret by printing the full config or environment into a shared transcript. Instead, run the operation that needs the credential. For Codex OAuth accounts, use the auth commands.

## When changes take effect

### New local or client process

Tau loads client configuration before opening the TUI. Restart the local TUI or `tau attach` to apply client changes such as:

- `defaultTheme`
- `clientTools` and `enabledClientTools`
- client environment variables

`/theme:<id>` changes only the current client's appearance. Themes are not saved in the session.

### Current session runtime

When no turn is running, `/reload` reads configuration and content again from the execution environment. It updates the session's runtime configuration, model catalog, personas, prompts, skills, the selected persona's definition, and project context. It also reports warnings and refreshes the session catalog.

The session keeps its current persona if that persona still exists. Otherwise Tau picks the first available persona. Changing `defaultPersona` does not switch an existing session on reload. It applies to new sessions, unless a CLI flag or creation request chooses another persona.

A turn keeps the persona, model settings, and tools it started with. Reload is refused while a turn is running, and reloaded settings apply to later turns.

### Host startup

Restart the host process to apply settings that the host reads once at startup, including:

- `flySprites`
- `history`
- host environment variables

For `tau serve`, make the changes on the host machine and restart the server. Restarting an attached TUI does not restart the host.

### New session or runner

Some settings apply only when something new is created. `defaultPersona` and startup persona flags choose the persona of a new session. The execution environment's kind, identity, `cwd`, and home are fixed when the session is created or recovered.

The Telegram runner loads its speech provider and its runner config at startup. Restart it after changing speech, projects, routing, or workspace preparation.

- Workspace-preparation changes apply when a managed workspace is created or reconstructed. Restarting does not change a preserved workspace.
- Command client tools are chosen when the runner creates the client for a session. Changes apply to new sessions, and also to existing sessions when a runner restart recovers them.
- Existing sessions keep their recorded execution environment, unless recovery has to reconstruct a missing managed workspace (see [Telegram projects and workspaces](telegram-projects.md)).

## Common precedence mistakes

**Editing global config for a project outside home.** The global level is skipped when the relevant `cwd` is outside home. Add a project level, or change the environment's configured home.

**Editing the laptop for host behavior.** Credentials, session storage, hosted-environment definitions, and project configuration on the laptop do not reach a remote host through an attached TUI.

**Editing the host's files for a hosted environment.** A hosted execution environment has its own project files and home. Put project `.tau` content on that environment, not at a similar path on the host.

**Expecting nested objects to deep-merge.** A nearer `mcpServers` entry replaces the whole entry with the same name, including its credentials, and a nearer `nook` object replaces the broader one completely. Repeat every setting the entry needs.

**Expecting `/reload` to restart the client or server.** Reload affects only the current session. Restart the process that reads the setting at startup.

**Using a project file for global-only fields.** `apiKeys`, `clientTools`, and `history` are rejected outside global config. `enabledClientTools` is rejected outside project config.

**Trusting a silent typo.** Unknown fields are removed without a warning. Valid JSON is not necessarily valid Tau configuration, so check exact names and confirm the setting changed behavior.
