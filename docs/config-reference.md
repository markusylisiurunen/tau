# Configuration reference

`config.json` sets Tau defaults and integrations. Global and project levels use the same schema, but a few fields are allowed at only one level, and different parts of Tau read different fields.

Read [configuration](configuration.md) first for discovery and precedence. In the tables below, **global** means `~/.config/tau/config.json` when that level applies, and **project** means a `.tau/config.json` found from the relevant `cwd` upward.

## Shipped defaults

These defaults are built into this Tau version. Your configuration can override them:

| Behavior                               | Shipped default      |
| -------------------------------------- | -------------------- |
| Default persona                        | `sonnet-5.5-coder`   |
| Default TUI theme                      | `gold`               |
| Built-in personas                      | Enabled              |
| Speech-to-text provider                | Gemini               |
| Built-in diff tool code theme          | `github-dark-dimmed` |
| Command client tool timeout when unset | `60000` ms           |

Project and global content can change which persona ids exist. A configured default must match an available persona or built-in theme. Otherwise Tau reports a warning.

## Field summary

| Field | Type | Scope | Combination | Read by; when changes apply |
| --- | --- | --- | --- | --- |
| `apiKeys` | Object of string values | Global only | Provider-keyed map | Owning host or feature process; restart after changes |
| `defaultPersona` | Non-empty string | Global, project | Most-specific wins | Session host; new session |
| `speech` | Object with optional `voiceId` and `recordingShortcut` | Global, project | Merge by field | TUI client or Telegram runner; process restart |
| `defaultTheme` | Non-empty string | Global, project | Most-specific wins | TUI client; client restart |
| `clientTools` | Array of objects | Global only | One global definition list | Owning client; TUI restart or new Telegram session client |
| `enabledClientTools` | String array | Project only | Most-specific project list | Owning client; TUI restart or new Telegram session client |
| `subagents` | Object | Global, project | Most-specific `launchModels` list | Session runtime; `/reload` or new session |
| `modelSystemNotices` | String map | Global, project | Merge by model target | Session runtime; `/reload`, affects later inputs |
| `flySprites` | Object | Global, project | Merge connection fields | Host startup; host restart |
| `nook` | Object | Global, project | Most-specific complete object | Host tool runtime; `/reload` or new session |
| `history` | Object | Global only | One global object | Host startup; host restart |
| `mcpServers` | Object keyed by server name | Global and project | Merge names; nearer entry replaces | Host startup; host restart |

Unknown fields are removed without a warning. Wrong types and invalid values produce warnings, and Tau continues with the valid fields. A field at a level where it is not allowed is rejected.

## Persona, model behavior, and context

### `defaultPersona`

A persona id, optionally followed by `:` and a reasoning level:

```json
{
  "defaultPersona": "gpt-6.1-sol-coder:high"
}
```

Allowed reasoning suffixes are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The persona id must match exactly, including case, a persona that exists after built-in, global, and project personas are loaded.

`defaultPersona` sets the persona of a new session unless a CLI flag or creation request chooses another. Reloading an existing session keeps its current persona when it still exists. See [personas](personas.md).

### `subagents`

`subagents` accepts one optional field:

| Nested field | Type | Contract |
| --- | --- | --- |
| `launchModels` | String array | Models an agent may choose when it starts a subagent |

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

A more specific list replaces the broader one. Subagents inherit instructions and tools from the main persona. Custom subagent definitions are not supported. See [subagents](subagents.md).

### `modelSystemNotices`

A map from exact `<provider>/<model>` targets to non-empty notice text:

```json
{
  "modelSystemNotices": {
    "openai/gpt-6.1-sol": "Use the repository's checked-in formatter for source changes."
  }
}
```

Provider ids must be known, and model ids must exist in the model catalog. Entries merge by normalized target, and the more specific value wins. Tau adds the matching notice to the start of later user input in the main session and in subagents. Ephemeral agents and maintenance model calls do not receive a newly resolved notice.

Use notices for guidance that applies to one model. Behavior that belongs to a persona goes in the persona file. See [models](models.md) and [personas](personas.md).

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

The map accepts any non-empty provider name with a string value. Values are trimmed when used, and an empty string does not count as a credential.

For model requests and features, a provider's environment variable wins over the same provider's entry in `apiKeys`. Other authentication a provider supports without a key still works. `apiKeys` in a project file is rejected. Codex OAuth does not use this map; it uses the active stored account. See [credentials](credentials.md).

### `speech`

Controls `/speak` and Telegram `/tts_on` voice selection. Set `voiceId` to a non-empty ElevenLabs voice ID:

```json
{
  "speech": {
    "voiceId": "QtY3JBOUKEB5xzrRfOKc"
  }
}
```

For terminal recording, `recordingShortcut` replaces Ctrl+Y. Its required `key` is a single printable, non-whitespace character, `ctrl+y`, or `f1` through `f12`. Its required `gesture` is `press` or `double-tap`:

```json
{
  "speech": {
    "recordingShortcut": { "key": "§", "gesture": "double-tap" }
  }
}
```

A double tap must arrive within 300 ms. For printable double-tap bindings, an unmatched first tap inserts the character after that delay; another key inserts it immediately before processing the new input. A single-press binding reserves its character, so it can no longer be typed. Bracketed paste never triggers recording. Keyboard auto-repeat can count as repeated taps. Recording shortcuts apply only to the TUI, not Telegram.

Without an override, Tau looks up Maisie (`QtY3JBOUKEB5xzrRfOKc`) before synthesis and tries Caleb (`AaOhDHYJ1XLZk74lXhdE`) only if ElevenLabs reports that Maisie was not found. If neither is available, speech fails. A configured voice is the only voice Tau tries. If it is unavailable, speech fails without falling back to a default.

Authentication, permission, rate-limit, and network errors during voice lookup do not trigger the fallback. Once lookup succeeds, that voice is used for the whole reply, although synthesis can still be refused. Synthesis failures never switch voices, and Tau never retries synthesis automatically because each request may be billed.

Speech uses Eleven v4 Turbo, the delivery note `[Brisk but relaxed, speaking naturally to a colleague]`, and a 1.15× tempo adjustment. GPT-6 Luna rewrites the text with reasoning disabled before ElevenLabs synthesis, so both OpenAI and ElevenLabs credentials are required. Voice Library API access may require a paid ElevenLabs plan, and shared voices can become unavailable.

The TUI reads this setting from its own client configuration, also when attached to a remote host. Telegram reads it from the runner's startup configuration, not from session workspaces. Restart the respective process after changes. This setting does not affect the explicit voices supplied to `tau tool speech-generate`.

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

Tau normalizes the domain to a lowercase hostname. A non-empty value from `accessClientSecretEnv` wins over `accessClientSecret`. The `nook` tool is available only when the active persona allows it and the effective configuration contains this object. See [Nook](nook.md).

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

Tau uses the first key it finds: `TAU_HISTORY_API_KEY`, then the variable named by `apiKeyEnv`, then `apiKey`. If `history` is configured but no key is available, the host fails to start. Without `history`, history is stored and searched only on the host machine. See [history](history.md).

### `mcpServers`

The host reads MCP servers once at startup, from the global config and the project levels of the directory where the host was launched.

- Server names add up across levels. A nearer definition replaces the whole entry with the same name, including credentials.
- Set `enabled: false` to turn off an inherited server.
- All sessions on the host share the same servers. Subagents have their parent's access, even in another working directory.
- Configuration in a session's execution environment never adds servers.
- Restart the host after changing definitions or credentials. `/reload` does not reload servers.

```json
{
  "mcpServers": {
    "issues": {
      "type": "stdio",
      "command": "uvx",
      "args": ["example-mcp-server"],
      "env": { "API_TOKEN": "${ISSUES_TOKEN}" }
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${REMOTE_MCP_TOKEN}" }
    }
  }
}
```

Server names use letters, digits, `_`, and `-`. Every entry requires an explicit `type`:

- `stdio`: requires a non-empty `command`; accepts optional literal `args`, `cwd`, and string-valued `env`.
- `http`: requires an HTTP(S) `url` without embedded username/password; accepts optional string-valued `headers`. This is streamable HTTP, not the legacy SSE transport.
- Both accept `enabled` (default `true`), `timeoutMs` for tool calls and resource reads (integer from 1 to 900,000, default 300,000), and `discoveryTimeoutMs` for connection startup and discovery requests (integer from 1 to 60,000, default 30,000). The outer MCP code-mode program has a 15-minute deadline. All calls remain interruptible.

Stdio executables run directly, without a shell. Bare commands resolve through the host's `PATH`. Commands that contain `/`, and relative `cwd` values, resolve from the directory of the config level that defines the server. `~/` resolves from the host user's home. Without `cwd`, the server starts in the defining level's directory. Arguments are passed literally, with no interpolation or shell expansion.

Values in `env` and `headers` can reference host environment variables as `${NAME}`. A missing variable makes the connection fail. Command substitution is not supported. Stdio servers inherit the host environment, and `env` overrides matching names. Keep secrets in the host environment instead of committing them to JSON.

An invalid entry is skipped with a diagnostic, and the other servers stay configured. OAuth sign-in, MCP prompts, subscriptions, elicitation, sampling, execution-environment servers, and user approval dialogs are not supported. See [tools](tools.md#capabilities) for discovery, calls, and result handling.

## TUI presentation and diff review

### `defaultTheme`

The exact, case-sensitive id of a built-in theme. The shipped default is `gold`:

```json
{
  "defaultTheme": "azure"
}
```

An attached TUI uses its own client configuration. `/theme:<id>` changes only the current client and is not saved in the session. See [TUI](tui.md).

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

Unknown properties inside `parameters` are kept as part of the schema. Unknown fields elsewhere in a tool object are removed. Because definitions are global, a command that contains `/` resolves from home. The command runs directly on the client, without a shell.

The TUI flag `--no-client-tools` disables both configured command tools and the TUI's built-in client tools. See [client tools](client-tools.md).

### `enabledClientTools`

A project-only exact allowlist of names from global `clientTools`:

```json
{
  "enabledClientTools": ["open-ticket"]
}
```

Names are trimmed and duplicates removed. Unknown names are ignored without a warning. An empty list selects no tools. If no project level sets the field, Tau selects the tools with `defaultEnabled: true`.

The most specific project list replaces broader ones. Project configuration cannot define client tool commands.

## Hosted execution environments

These fields tell a host how to reach hosted execution environments. They do not create Sprites. A client that creates a session names an existing environment and a `cwd` on it, and the host connects using these settings. See [remote sessions](remote-sessions.md).

### `flySprites`

One configured connection:

```json
{
  "flySprites": {
    "tokenEnv": "FLY_SPRITES_TOKEN",
    "home": "/home/sprite"
  }
}
```

| Field | Type | Required | Default or behavior |
| --- | --- | --- | --- |
| `baseURL` | Non-empty string | No | Defaults to `https://api.sprites.dev` |
| `token` | Non-empty string | No | Inline token; takes precedence when present |
| `tokenEnv` | Non-empty string | No | Host environment variable used when `token` is absent |
| `home` | Non-empty string | No | Sprite home, default `/home/sprite` |

The host needs a usable token when it connects to a Sprite. Sessions select an existing Sprite by name. More specific connection fields replace broader ones.
