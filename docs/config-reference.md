# Configuration reference

`config.json` sets Tau defaults and integrations. Global and project levels use the same schema, but a few fields are allowed at only one level, and different parts of Tau read different fields.

Read [configuration](configuration.md) first for discovery and precedence. In the tables below, **global** means `~/.config/tau/config.json` when that level applies, and **project** means a `.tau/config.json` found from the relevant `cwd` upward.

## Shipped defaults

These are the defaults for fields you leave unset in this Tau version:

| Field                              | Default            |
| ---------------------------------- | ------------------ |
| `defaultPersona`                   | `sonnet-5.5-coder` |
| `defaultTheme`                     | `gold`             |
| `clientTools[].executionTimeoutMs` | `60000` ms         |

Project and global content can change which persona ids exist. A configured default must match an available persona or built-in theme. Otherwise Tau reports a warning.

## Field summary

| Field | Type | Scope | Combination | Read by; when changes apply |
| --- | --- | --- | --- | --- |
| `apiKeys` | Object of string values | Global only | Provider-keyed map | Owning host or feature process; restart after changes |
| `defaultPersona` | Non-empty string | Global, project | Most-specific wins | Session host; new session |
| `speech` | Object with optional `voiceId`, `recordingShortcut`, `cleanupStyle`, and `vocabulary` | Global, project | Merge by field; vocabulary is additive | `voiceId`, `recordingShortcut`, and `cleanupStyle`: client; process restart. `vocabulary`: session host; `/reload` or new session. Global `vocabulary` terms are also read by the client; process restart |
| `defaultTheme` | Non-empty string | Global, project | Most-specific wins | TUI client; client restart |
| `markdownExport` | Object with `url` and optional `token`, `tokenEnv` | Global only | One global object | TUI client; client restart |
| `clientTools` | Array of objects | Global only | One global definition list | Owning client; TUI restart or new Telegram session client |
| `enabledClientTools` | String array | Project only | Most-specific project list | Owning client; TUI restart or new Telegram session client |
| `subagents` | Object | Global, project | Most-specific `launchModels` list | Session runtime; `/reload` or new session |
| `modelSystemNotices` | String map | Global, project | Merge by model target | Session runtime; `/reload`, affects later inputs |
| `flySprites` | Object | Global, project | Merge connection fields | Host startup; host restart |
| `history` | Object | Global only | One global object | Host startup; host restart |
| `mcpServers` | Object keyed by server name | Global and project | Merge names; nearer entry replaces | Session host, local sessions only; next time the host loads the session |

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

A more specific list replaces the broader one. Subagents inherit instructions and tools from their parent agent. Custom subagent definitions are not supported. See [subagents](subagents.md).

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

### `markdownExport`

`/export-response` sends the latest completed assistant response to one Markdown service. Configure the full endpoint in the terminal client's `~/.config/tau/config.json`:

```json
{
  "markdownExport": {
    "url": "https://example.com/api/documents",
    "tokenEnv": "MARKDOWN_EXPORT_TOKEN"
  }
}
```

`url` is required. It must use HTTPS, except that HTTP is allowed for `localhost`, `127.0.0.1`, and `[::1]`. Embedded credentials and fragments are rejected. Project configuration cannot set or override this object.

`token` supplies an inline bearer token and takes precedence over `tokenEnv`. Otherwise, `tokenEnv` names a variable in the terminal process's environment. A missing or empty variable fails before any request. With neither field, requests have no authorization header. Tokens must be non-empty printable ASCII without spaces. Credentials are not included in diagnostics.

The request runs on the terminal's machine, including with `tau attach`. Restart the TUI after changing this configuration. See [the export contract](tui.md#exporting-a-response) for the HTTP request and response.

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

For terminal dictation, `cleanupStyle` sets the initial [cleanup style](tui.md#cleanup-styles) for each recording. It accepts `"off"` (the default) or `"default"`. Tab changes the style for the current recording only. Enabling cleanup prepares the OpenAI connection and instructions during recording.

```json
{
  "speech": {
    "cleanupStyle": "default"
  }
}
```

Telegram uses its separate per-bot `speechCleanupStyle` setting.

For dictation, `vocabulary` supplies spelling hints for recurring names, identifiers, and short phrases:

```json
{
  "speech": {
    "vocabulary": ["Tau", "PostgreSQL", "ChatRuntime"]
  }
}
```

Define personal terms in `~/.config/tau/config.json` and project terms in `.tau/config.json`. Tau combines the nearest project's entries first, then parent projects, then global entries, preserving each list's order. An omitted list or `[]` adds nothing and does not clear inherited terms. Entries are trimmed and deduplicated case-insensitively, preserving the first spelling. Invalid entries produce a configuration warning. Each entry must be a non-empty string of at most 50 Unicode characters and 5 words, without line breaks or any of the characters `<`, `>`, `{`, `}`, `[`, `]`, and `\`.

Tau appends keywords extracted from the recent conversation after configured terms. The combined list is limited to 1,000 terms and 50,000 Unicode characters, so explicit project terms take priority. Live dictation sends only the first 50 terms that have at most 20 characters, because ElevenLabs limits realtime hints more strictly. Recording retries and Telegram audio send the full list. For file transcription, [ElevenLabs charges](https://elevenlabs.io/docs/api-reference/speech-to-text/convert) 20% more when keyterms are present, and bills a request with more than 100 terms for at least 20 seconds of audio.

Vocabulary goes directly to ElevenLabs Scribe as keyterms for live dictation, recording retries, and Telegram audio. It does not instruct the model to insert words or replace text afterward. When speech cleanup is on in the [TUI](tui.md#cleanup-styles) or [Telegram](telegram.md#bots-and-access-control), the cleanup model also receives the terms, only to correct spelling. Configured terms still work without conversation context, without OpenAI credentials, or when keyword extraction fails. With no vocabulary configured, Tau uses only context-derived hints.

Without an override, Tau looks up Maisie (`QtY3JBOUKEB5xzrRfOKc`) before synthesis and tries Caleb (`AaOhDHYJ1XLZk74lXhdE`) only if ElevenLabs reports that Maisie was not found. If neither is available, speech fails. A configured voice is the only voice Tau tries. If it is unavailable, speech fails without falling back to a default.

Authentication, permission, rate-limit, and network errors during voice lookup do not trigger the fallback. Once lookup succeeds, that voice is used for the whole reply, although synthesis can still be refused. Synthesis failures never switch voices, and Tau never retries synthesis automatically because each request may be billed.

Speech uses Eleven v4 Turbo, the delivery note `[Brisk but relaxed, speaking naturally to a colleague]`, and a 1.15× tempo adjustment. GPT-6 Luna rewrites the text with reasoning disabled before ElevenLabs synthesis, so both OpenAI and ElevenLabs credentials are required. Voice Library API access may require a paid ElevenLabs plan, and shared voices can become unavailable.

`voiceId`, `recordingShortcut`, and `cleanupStyle` come from the client's own configuration. The TUI reads them from its startup directory's configuration, also when attached to a remote host, and Telegram reads `voiceId` from the runner's startup configuration. Restart the respective process after changes. `voiceId` does not affect the explicit voices supplied to `tau tool speech-generate`.

Vocabulary follows the session. The host resolves it from the global and project levels of the session's working directory, on the execution environment. The client that transcribes the audio then adds the terms from its own global configuration, after the session's terms. Project configuration in the client's startup directory is not used. For example:

| Location | `vocabulary` |
| --- | --- |
| Global config on the session's machine | `["Team"]` |
| `.tau/config.json` in the session's project | `["Ledger"]` |
| Global config on the machine running `tau attach` | `["Personal"]` |
| `.tau/config.json` where `tau attach` started | `["Notes"]` |
| **Terms used for this session** | `["Ledger", "Team", "Personal"]` |

A client adds its global terms only when it started inside its user's home, because that is when it reads the global level. See [configuration](configuration.md). Run `/reload` after changing the session's terms, and restart the client after changing its global terms.

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

Each session on a local execution environment uses the servers from the global config and project levels of its own working directory. The directory where the host was launched does not choose them, so `tau`, `tau serve`, the SDK, and Telegram behave the same way.

- Server names add up across levels. A nearer definition replaces the whole entry with the same name, including credentials.
- Set `enabled: false` to turn off an inherited server.
- The global level applies only when the session's working directory is inside the home directory. See [configuration](configuration.md).
- Each session has its own servers and connections. Subagents use their parent's, even in another working directory.
- A session on a remote execution environment, such as a Fly Sprite, has no MCP servers. Tau does not use definitions from that environment or from the host. Servers would run on the host, and Tau cannot tell which of them expose the host's files. [Security](security.md#trust-mcp-servers) explains the trade-off.
- The host reads definitions when it creates or recovers a session, and they stay fixed while the session is loaded. `/reload` does not change them, but it warns if the definitions on disk differ. To apply a change, start a new session, or reopen the session after the host has unloaded it. The host unloads a session when no client is attached, its work has finished, and no [retention](session-protocol.md#keep-a-session-loaded-without-clients) period is active, and when the host shuts down.
- Restart the host after changing the environment variables that servers use. OAuth credentials updated through `tau mcp login` take effect without restarting.

```json
{
  "mcpServers": {
    "issues": {
      "type": "stdio",
      "command": "uvx",
      "description": "Search and update engineering issues and milestones.",
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
- Both accept `enabled` (default `true`), `timeoutMs` for tool calls and resource reads (integer from 1 to 900,000, default 300,000), and `discoveryTimeoutMs` for connection startup and discovery requests (integer from 1 to 60,000, default 30,000). MCP calls run inside a `code` program, so a foreground program's deadline also limits them: 5 minutes by default, at most 60 minutes. All calls remain interruptible.

When a stdio server's transport reports an error, Tau closes the connection and fails its pending requests. Tau does not replay those requests, and a later call starts a new connection. For an HTTP server, a failure of its optional notification stream does not close the connection or fail calls that are in progress.

Both types accept an optional `description`: a nonblank capability summary of at most 512 UTF-16 code units after trimming surrounding whitespace. Enabled server names and configured descriptions appear in the model's initial `code` tool description when its persona allows `mcp`. Servers without descriptions appear by name; disabled servers are omitted. This catalog contains no connection settings and requires no server connections. Descriptions are capability summaries, not instructions or permission grants. Do not put secrets in them. Full server instructions and tool schemas remain available through discovery.

Stdio executables run directly, without a shell. Bare commands resolve through the host's `PATH`. Commands that contain `/`, and relative `cwd` values, resolve from the directory of the config level that defines the server. `~/` resolves from the host user's home. Without `cwd`, the server starts in the defining level's directory. Arguments are passed literally, with no interpolation or shell expansion.

Values in `env` and `headers` can reference host environment variables as `${NAME}`. A missing variable makes the connection fail. Command substitution is not supported. Stdio servers inherit the host environment, and `env` overrides matching names. Keep secrets in the host environment instead of committing them to JSON.

An invalid entry is skipped with a [configuration warning](configuration.md#see-configuration-warnings), and the other servers stay configured. HTTP OAuth sign-in is available through `tau mcp login`; see [credentials](credentials.md#mcp-oauth). MCP prompts, subscriptions, elicitation, sampling, execution-environment servers, and user approval dialogs are not supported. See [code mode](code-mode.md#capabilities) for discovery, calls, and result handling.

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
