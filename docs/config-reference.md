# Configuration reference

`config.json` controls Tau defaults and integrations. The same schema is available at global and project levels, but a few fields are restricted to one scope and different components consume different results. This reference lists the current fields only.

Read [configuration](configuration.md) first for discovery and precedence. In the tables below, **global** means `~/.config/tau/config.json` when that level is eligible, and **project** means an ancestor `.tau/config.json` discovered from the relevant `cwd`.

## Shipped defaults

These are defaults built into this Tau version, not a dump of the effective configuration:

| Behavior | Shipped default |
| --- | --- |
| Default persona | `opus-5-chat` |
| Default TUI theme | `gold` |
| Built-in personas | Enabled |
| Built-in themes | Enabled |
| Automatic compaction | `{ "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 }` |
| Speech-to-text provider when unset | `mistral` |
| Built-in diff tool code theme | `github-dark-dimmed` |
| Command client tool timeout when unset | `60000` ms |

Project and global content can change which ids are actually available. A configured default that is not loaded produces a warning rather than creating that persona or theme.

## Field summary

| Field | Type | Scope | Combination | Primary owner and apply boundary |
| --- | --- | --- | --- | --- |
| `apiKeys` | Object of string values | Global, project | Merge by provider id | Host or feature consumer; `/reload` for session runtime keys, process restart for environment changes |
| `defaultPersona` | Non-empty string | Global, project | Most-specific wins | Session host; new session |
| `disableBuiltinPersonas` | Boolean | Global, project | Most-specific wins | Session runtime; `/reload` or new session |
| `disableBuiltinThemes` | Boolean | Global, project | Most-specific wins | TUI client; client restart |
| `defaultTheme` | Non-empty string | Global, project | Most-specific wins | TUI client; client restart |
| `diffTool` | Object | Global, project | Most-specific complete object | TUI client; client restart |
| `builtInDiffTool` | Object | Global, project | Most-specific complete object | TUI client; client restart |
| `clientTools` | Array of objects | Global only | One global definition list | Owning client; TUI restart or new Telegram session client |
| `enabledClientTools` | String array | Project only | Most-specific project list | Owning client; TUI restart or new Telegram session client |
| `agentContextFiles` | String array | Global, project | Additive, resolved and deduplicated | Execution environment and session host; `/reload` or new session |
| `subagents` | Object | Global, project | Field-wise, currently one selectable list | Session runtime; `/reload` or new session |
| `autoCompact` | Object | Global, project | Merge by field over shipped defaults | Session runtime; `/reload` or new session |
| `modelSystemNotices` | String map | Global, project | Merge by model target | Session runtime; `/reload`, affects later inputs |
| `speechToText` | Object | Global, project | Most-specific wins | TUI client or Telegram runner; process restart |
| `cloudflareSandbox` | Object | Global, project | Merge bridges by id | Host startup; host restart |
| `flySprites` | Object | Global, project | Merge APIs by id | Host startup; host restart |
| `nook` | Object | Global, project | Most-specific complete object | Host tool runtime; `/reload` or new session |
| `history` | Object | Global only | One global object | Host startup; host restart |

Unknown fields are stripped without warnings. Wrong types and invalid known values produce warnings, and Tau continues with valid fields. A field at a forbidden scope is rejected.

## Persona, model behavior, and context

### `defaultPersona`

A persona id, optionally followed by `:` and a reasoning level:

```json
{
  "defaultPersona": "gpt-5.6-sol-coder:high"
}
```

Allowed reasoning suffixes are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The persona id is matched exactly and case-sensitively during startup selection. The id must exist after built-in, global, and project personas are loaded.

`defaultPersona` selects a new session when no CLI or session-creation override is supplied. Reloading an existing session retains its current persona id when possible. See [personas](personas.md).

### `disableBuiltinPersonas`

A boolean that removes shipped personas from the loaded persona catalog:

```json
{
  "disableBuiltinPersonas": true
}
```

The default is `false`. When enabled, at least one valid custom persona must be available or session startup fails. This field does not disable user or project personas.

### `agentContextFiles`

An array of non-empty paths to additional text files included as project context:

```json
{
  "agentContextFiles": ["docs/AI_GUIDE.md", "services/payments/AGENTS.md"]
}
```

Entries are additive across levels. Global paths resolve from home; project paths resolve from the directory containing `.tau`. Tau deduplicates identical resolved paths. Eligibility and ordinary `AGENTS.md` discovery are described in [prompts and project context](prompts-and-project-context.md).

The startup flag `--no-agent-context-files` disables context injection independently of this list.

### `subagents`

The top-level subagent configuration currently accepts one optional field:

| Nested field | Type | Contract |
| --- | --- | --- |
| `defaultLaunchModels` | String array | Allowlist for launch overrides of the built-in `default` subagent |

Each entry must use `<provider>/<model>:<effort>` and resolve against the merged model catalog:

```json
{
  "subagents": {
    "defaultLaunchModels": [
      "openai-codex/gpt-5.6-sol:high",
      "anthropic/claude-haiku-4-5:low"
    ]
  }
}
```

A more-specific list replaces the broader list. Custom subagent definitions belong in persona frontmatter, not this object. See [subagents](subagents.md).

### `autoCompact`

Automatic compaction settings:

| Nested field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | Boolean | `true` | Whether Tau checks and compacts before model subturns |
| `reserveTokens` | Positive integer | `16384` | Context reserved below the model's context-window limit |
| `keepRecentTokens` | Positive integer | `20000` | Target budget for the recent retained tail |

Fields merge independently across levels:

```json
{
  "autoCompact": {
    "reserveTokens": 24000
  }
}
```

The omitted fields retain their broader or shipped values. This setting changes Tau's automatic policy; manual `/compact-all` and `/compact-keep-last` remain available. See [sessions](sessions.md).

### `modelSystemNotices`

A map from exact `<provider>/<model>` targets to non-empty notice text:

```json
{
  "modelSystemNotices": {
    "openai/gpt-5.6-sol": "Use the repository's checked-in formatter for source changes."
  }
}
```

Provider ids must be known, and model ids must resolve against the merged built-in and `models.json` catalog. Entries merge by normalized target, with the more-specific value winning. Tau prepends the matching notice to later committed main-session and subagent user input. Ephemeral agents and maintenance model calls do not receive a newly resolved notice.

Use this for model-specific operational guidance, not for persona behavior that belongs in a persona file. See [models](models.md) and [personas](personas.md).

## Credentials and service selection

### `apiKeys`

A map from provider or feature id to a string credential:

```json
{
  "apiKeys": {
    "anthropic": "sk-ant-...",
    "openai": "sk-...",
    "google": "...",
    "exa": "...",
    "mistral": "..."
  }
}
```

The map accepts arbitrary non-empty provider names and string values. Values are trimmed when consumed; an empty string is not a usable credential. Maps merge by key, so a project can replace one provider without removing others.

For model requests, credential precedence is an explicit request override, configured `apiKeys.<provider>`, then the provider runtime's ambient authentication. This means `apiKeys.openai` wins over `OPENAI_API_KEY` for model calls. The `openai-codex` provider uses managed OAuth separately and does not use `apiKeys.openai`.

Feature-specific helpers use different precedence: `EXA_API_KEY`, `GEMINI_API_KEY`, and `MISTRAL_API_KEY` take precedence over `apiKeys.exa`, `apiKeys.google`, and `apiKeys.mistral` for the features that consume those helpers. See [credentials](credentials.md) for the exact feature matrix.

Credentials are consumed where the model or feature runs. In an attached session that is usually the host, not the TUI client. Avoid committing project API keys. See [credentials](credentials.md).

### `speechToText`

An object with one required field when present:

| Nested field | Type   | Values                |
| ------------ | ------ | --------------------- |
| `provider`   | String | `mistral` or `gemini` |

```json
{
  "speechToText": {
    "provider": "gemini"
  }
}
```

When the object is absent, `/listen` and Telegram transcription use `mistral`. The TUI consumes this setting for client-local recording; the Telegram runner consumes it for Telegram audio. Restart the owning process after changing it.

### `nook`

Connection details for one existing Nook deployment:

| Nested field | Type | Required | Contract |
| --- | --- | --- | --- |
| `domain` | Non-empty string | Yes | DNS hostname, optionally supplied as a plain `http://` or `https://` origin with no port, path, query, credentials, or fragment |
| `accessClientId` | Non-empty string | No | Cloudflare Access service-token client id |
| `accessClientSecret` | Non-empty string | No | Inline service-token secret |
| `accessClientSecretEnv` | Non-empty string | No | Host environment variable containing the secret |

```json
{
  "nook": {
    "domain": "apps.example.com",
    "accessClientId": "8f0c...access",
    "accessClientSecretEnv": "NOOK_ACCESS_CLIENT_SECRET"
  }
}
```

Tau normalizes the domain to a lowercase hostname. A non-empty value from `accessClientSecretEnv` takes precedence over `accessClientSecret`. The `nook` tool is available only when both the active persona allows it and effective configuration contains this object. See [Nook](nook.md).

### `history`

A global-only remote history target:

| Nested field | Type | Required | Contract |
| --- | --- | --- | --- |
| `endpoint` | Non-empty string | Yes | HTTP(S) URL with no query or fragment |
| `apiKey` | Non-empty string | No | Inline service API key |
| `apiKeyEnv` | Non-empty string | No | Host environment variable containing the key |

```json
{
  "history": {
    "endpoint": "https://history.example.com",
    "apiKeyEnv": "TEAM_TAU_HISTORY_KEY"
  }
}
```

Credential precedence is `TAU_HISTORY_API_KEY`, then the variable named by `apiKeyEnv`, then `apiKey`. Configuring an endpoint without an available key prevents the host service from starting. Without `history`, transcript storage and queries remain machine-local. See [history](history.md).

## TUI presentation and diff review

### `disableBuiltinThemes`

A boolean that removes shipped themes from the TUI client's loaded theme list. The default is `false`.

```json
{
  "disableBuiltinThemes": true
}
```

If built-ins are disabled, provide a valid custom theme. This setting does not affect personas or model behavior.

### `defaultTheme`

The exact, case-sensitive id of a loaded theme. The shipped default is `gold`:

```json
{
  "defaultTheme": "azure"
}
```

The attached TUI uses its client-local configuration and theme files. `/theme:<id>` changes the current client only and is not persisted into the session. See [TUI](tui.md).

### `diffTool`

A custom client-local diff-review launcher:

| Nested field | Type | Required | Contract |
| --- | --- | --- | --- |
| `command` | Non-empty string | Yes | Executable name or path |
| `args` | String array | No | Arguments passed to the executable |
| `env` | Object of string values | No | Extra environment entries for the tool process |

```json
{
  "diffTool": {
    "command": "./tools/review-ui",
    "args": ["--browser", "firefox"],
    "env": {
      "REVIEW_LOG_LEVEL": "warn"
    }
  }
}
```

The most-specific complete object wins. A relative command containing `/` resolves from the declaring level root; a bare command resolves through client `PATH`. The TUI launches this process on the client machine. If this field is absent, the TUI uses Tau's built-in diff tool. See [TUI](tui.md) and [client tools](client-tools.md) for the broader client-local distinction.

### `builtInDiffTool`

Settings for the built-in fallback diff tool:

```json
{
  "builtInDiffTool": {
    "codeTheme": "nord"
  }
}
```

`codeTheme` defaults to `github-dark-dimmed`. Supported values are:

`andromeeda`, `aurora-x`, `ayu-dark`, `ayu-mirage`, `catppuccin-frappe`, `catppuccin-macchiato`, `catppuccin-mocha`, `dark-plus`, `dracula`, `dracula-soft`, `everforest-dark`, `github-dark`, `github-dark-default`, `github-dark-dimmed`, `github-dark-high-contrast`, `gruvbox-dark-hard`, `gruvbox-dark-medium`, `gruvbox-dark-soft`, `horizon`, `horizon-bright`, `houston`, `kanagawa-dragon`, `kanagawa-wave`, `laserwave`, `material-theme`, `material-theme-darker`, `material-theme-ocean`, `material-theme-palenight`, `min-dark`, `monokai`, `night-owl`, `nord`, `one-dark-pro`, `plastic`, `poimandres`, `red`, `rose-pine`, `rose-pine-moon`, `slack-dark`, `solarized-dark`, `synthwave-84`, `tokyo-night`, `vesper`, `vitesse-black`, and `vitesse-dark`.

This object does not configure a custom `diffTool` process.

## Command client tools

### `clientTools`

A global-only array of commands exposed as client-provided tools:

| Nested field | Type | Required | Contract |
| --- | --- | --- | --- |
| `name` | Non-empty string | Yes | Unique within the array |
| `defaultEnabled` | Boolean | Yes | Advertise when no project selection exists |
| `description` | Non-empty string | Yes | Model-facing tool description |
| `parameters` | JSON Schema object | Yes | Root `type` must be `"object"` |
| `command` | Non-empty string | Yes | Executable name or path |
| `args` | String array | No | Command arguments |
| `executionTimeoutMs` | Positive integer | No | Invocation timeout, default `60000` |

```json
{
  "clientTools": [
    {
      "name": "open-ticket",
      "defaultEnabled": false,
      "description": "Open a ticket in the client team's tracker.",
      "parameters": {
        "type": "object",
        "properties": {
          "title": { "type": "string" }
        },
        "required": ["title"],
        "additionalProperties": false
      },
      "command": "./bin/open-ticket"
    }
  ]
}
```

Unknown properties inside `parameters` are preserved as part of the configured schema; unknown fields elsewhere in each tool object are stripped. A command containing `/` resolves from home because definitions are global. The command executes directly on the owning client without a shell and participates in Tau's bounded client-tool protocol.

TUI startup flag `--no-client-tools` disables both configured command tools and built-in TUI client tools. See [client tools](client-tools.md).

### `enabledClientTools`

A project-only exact allowlist of names from global `clientTools`:

```json
{
  "enabledClientTools": ["open-ticket"]
}
```

Names are trimmed and duplicates removed. Unknown names are silently ignored. An empty list selects none. If the field is absent at every project level, Tau selects tools with `defaultEnabled: true`.

The most-specific project list replaces broader project lists. Project configuration cannot define executable client tool commands.

## Hosted execution environments

These fields configure resolvers owned by a host process. They do not provision sandboxes or Sprites. A client creating a session supplies an existing environment identity and `cwd` that references one of these host-known entries. See [remote sessions](remote-sessions.md).

### `cloudflareSandbox`

An optional `bridges` map keyed by bridge id:

```json
{
  "cloudflareSandbox": {
    "bridges": {
      "team": {
        "url": "https://tau-sandbox.example.workers.dev",
        "apiKeyEnv": "TAU_SANDBOX_BRIDGE_KEY",
        "home": "/home/sandbox"
      }
    }
  }
}
```

Each bridge accepts:

| Nested field | Type | Required | Default or behavior |
| --- | --- | --- | --- |
| `url` | Non-empty string | Yes | Bridge base URL; schema requires a string but does not perform general URL validation |
| `apiKey` | Non-empty string | No | Inline bridge key; takes precedence when present |
| `apiKeyEnv` | Non-empty string | No | Host environment variable used when `apiKey` is absent |
| `home` | Non-empty string | No | Execution-environment home, default `/home/sandbox` |

Bridge maps merge by id. A more-specific bridge replaces the complete entry with that id, so it must repeat the required `url`.

### `flySprites`

An optional `apis` map keyed by API id:

```json
{
  "flySprites": {
    "apis": {
      "personal": {
        "tokenEnv": "FLY_SPRITES_TOKEN",
        "home": "/home/sprite"
      }
    }
  }
}
```

Each API accepts:

| Nested field | Type | Required | Default or behavior |
| --- | --- | --- | --- |
| `baseURL` | Non-empty string | No | Defaults to `https://api.sprites.dev` |
| `token` | Non-empty string | No | Inline token; takes precedence when present |
| `tokenEnv` | Non-empty string | No | Host environment variable used when `token` is absent |
| `home` | Non-empty string | No | Execution-environment home, default `/home/sprite` |

A usable token is required when the host resolves a Sprite. API maps merge by id, with the more-specific complete entry replacing the broader entry.
