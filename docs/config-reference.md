# Configuration reference

`config.json` controls Tau defaults and integrations. The same schema is available at global and project levels, but a few fields are restricted to one scope and different components consume different results. This reference lists the current fields only.

Read [configuration](configuration.md) first for discovery and precedence. In the tables below, **global** means `~/.config/tau/config.json` when that level is eligible, and **project** means an ancestor `.tau/config.json` discovered from the relevant `cwd`.

## Shipped defaults

These are defaults built into this Tau version, not a dump of the effective configuration:

| Behavior                               | Shipped default      |
| -------------------------------------- | -------------------- |
| Default persona                        | `sonnet-5.5-coder`   |
| Default TUI theme                      | `gold`               |
| Built-in personas                      | Enabled              |
| Speech-to-text provider when unset     | `openai`             |
| Built-in diff tool code theme          | `github-dark-dimmed` |
| Command client tool timeout when unset | `60000` ms           |

Project and global content can change which persona ids are available. A configured default must match an available persona or built-in theme; otherwise Tau reports a warning.

## Field summary

| Field | Type | Scope | Combination | Primary owner and apply boundary |
| --- | --- | --- | --- | --- |
| `apiKeys` | Object of string values | Global, project | Merge by provider id | Host or feature consumer; `/reload` for session runtime keys, process restart for environment changes |
| `defaultPersona` | Non-empty string | Global, project | Most-specific wins | Session host; new session |
| `speech` | Object with optional `voiceId` | Global, project | Merge by field | TUI client or Telegram runner; process restart |
| `defaultTheme` | Non-empty string | Global, project | Most-specific wins | TUI client; client restart |
| `clientTools` | Array of objects | Global only | One global definition list | Owning client; TUI restart or new Telegram session client |
| `enabledClientTools` | String array | Project only | Most-specific project list | Owning client; TUI restart or new Telegram session client |
| `agentContextFiles` | String array | Global, project | Additive, resolved and deduplicated | Execution environment and session host; `/reload` or new session |
| `subagents` | Object | Global, project | Field-wise, currently one selectable list | Session runtime; `/reload` or new session |
| `modelSystemNotices` | String map | Global, project | Merge by model target | Session runtime; `/reload`, affects later inputs |
| `flySprites` | Object | Global, project | Merge APIs by id | Host startup; host restart |
| `nook` | Object | Global, project | Most-specific complete object | Host tool runtime; `/reload` or new session |
| `history` | Object | Global only | One global object | Host startup; host restart |

Unknown fields are stripped without warnings. Wrong types and invalid known values produce warnings, and Tau continues with valid fields. A field at a forbidden scope is rejected.

## Persona, model behavior, and context

### `defaultPersona`

A persona id, optionally followed by `:` and a reasoning level:

```json
{
  "defaultPersona": "gpt-6.1-sol-coder:high"
}
```

Allowed reasoning suffixes are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The persona id is matched exactly and case-sensitively during startup selection. The id must exist after built-in, global, and project personas are loaded.

`defaultPersona` selects a new session when no CLI or session-creation override is supplied. Reloading an existing session retains its current persona id when possible. See [personas](personas.md).

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

| Nested field   | Type         | Contract                                     |
| -------------- | ------------ | -------------------------------------------- |
| `launchModels` | String array | Allowlist for launch overrides for subagents |

Each entry must use `<provider>/<model>:<effort>` and resolve against the merged model catalog:

```json
{
  "subagents": {
    "launchModels": [
      "openai-codex/gpt-6.1-sol:high",
      "anthropic/claude-haiku-4-5:low"
    ]
  }
}
```

A more-specific list replaces the broader list. The worker’s instructions and tools are inherited from the main persona; custom worker definitions are not supported. See [subagents](subagents.md).

### `modelSystemNotices`

A map from exact `<provider>/<model>` targets to non-empty notice text:

```json
{
  "modelSystemNotices": {
    "openai/gpt-6.1-sol": "Use the repository's checked-in formatter for source changes."
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

Feature-specific helpers use different precedence: `EXA_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, and `OPENAI_API_KEY` take precedence over their matching `apiKeys` entries for the features that consume those helpers. See [credentials](credentials.md) for the exact feature matrix.

Credentials are consumed where the model or feature runs. In an attached session that is usually the host, not the TUI client. Avoid committing project API keys. See [credentials](credentials.md).

### `speech`

Controls `/speak` and Telegram `/tts_on` voice selection. Set `voiceId` to a non-empty ElevenLabs voice ID:

```json
{
  "speech": {
    "voiceId": "QtY3JBOUKEB5xzrRfOKc"
  }
}
```

Without an override, Tau looks up Maisie (`QtY3JBOUKEB5xzrRfOKc`) before synthesis and tries Caleb (`AaOhDHYJ1XLZk74lXhdE`) only if ElevenLabs reports that Maisie was not found. If neither is available, speech fails. A configured voice is used exclusively: an unavailable custom voice is an error, not a request to use a default.

Voice lookup authentication, permission, rate-limit, and network errors do not trigger fallback. Successful metadata lookup fixes the voice for the entire reply; it does not guarantee synthesis permission. Synthesis failures never switch voices or automatically retry a potentially billable request.

Speech uses Eleven v4 Turbo, the delivery note `[Brisk but relaxed, speaking naturally to a colleague]`, and a 1.15× tempo adjustment. GPT-6 Luna rewrites the text with reasoning disabled before ElevenLabs synthesis, so both OpenAI and ElevenLabs credentials are required. Voice Library API access may require a paid ElevenLabs plan, and shared voices can become unavailable.

The TUI reads this setting from its client-side configuration, including during remote attachment. Telegram reads it from the runner's startup configuration, not individual session workspaces. Restart the respective process after changes. This setting does not affect the explicit voices supplied to `tau tool speech-generate`.

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
| `endpoint` | Non-empty string | Yes | HTTP(S) URL with no credentials, query, or fragment |
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

### `defaultTheme`

The exact, case-sensitive id of a built-in theme. The shipped default is `gold`:

```json
{
  "defaultTheme": "azure"
}
```

The attached TUI uses its client-local configuration. `/theme:<id>` changes the current client only and is not persisted into the session. See [TUI](tui.md).

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

These fields configure resolvers owned by a host process. They do not provision Sprites. A client creating a session supplies an existing environment identity and `cwd` that references one of these host-known entries. See [remote sessions](remote-sessions.md).

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
