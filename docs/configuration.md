# Configuration

Tau reads `config.json` from these levels, and nearer levels win:

```text
~/.config/tau/config.json            global, only when cwd is inside home
<ancestor>/.tau/config.json          each project level, from broadest to nearest
```

When the working directory is inside home, the search stops at home. Otherwise it continues to the filesystem root and skips the global level. A session reads these files on its execution environment, and a client reads them from its own startup directory. See [how Tau works](how-tau-works.md).

## Fields

```ts
type Config = {
  defaultPersona?: string; // "id" or "id:reasoning", default "sonnet-5.5-coder"
  defaultTheme?: string; // built-in theme ID, default "gold"
  apiKeys?: Record<string, string>; // global only, keyed by provider
  subagents?: { launchModels?: string[] }; // "<provider>/<model>:<effort>"
  modelSystemNotices?: Record<string, string>; // keyed by "<provider>/<model>"
  mcpServers?: Record<string, McpServer>; // see mcp.md
  clientTools?: CommandClientTool[]; // global only, see client-tools.md
  enabledClientTools?: string[]; // project only, [] selects none
  speech?: {
    voiceId?: string; // ElevenLabs voice for /speak and Telegram /tts_on
    recordingShortcut?: {
      key: string; // one printable character, "ctrl+y", or "f1" to "f12"
      gesture: "press" | "double-tap";
    };
    vocabulary?: string[]; // spelling hints for transcription
  };
  markdownExport?: {
    // global only, see tui.md
    url: string; // HTTPS, or HTTP on localhost
    token?: string;
    tokenEnv?: string; // variable holding the token
  };
  history?: {
    // global only, see history.md
    endpoint: string;
    apiKey?: string;
    apiKeyEnv?: string;
  };
  flySprites?: {
    // see remote-sessions.md
    baseURL?: string; // default "https://api.sprites.dev"
    token?: string;
    tokenEnv?: string;
    home?: string; // default "/home/sprite"
  };
};
```

An example:

```json
{
  "defaultPersona": "gpt-6.1-sol-coder:high",
  "speech": { "vocabulary": ["Tau", "PostgreSQL"] },
  "subagents": { "launchModels": ["openai/gpt-6-luna:medium"] },
  "modelSystemNotices": {
    "openai/gpt-6.1-sol": "Use the repository's formatter for source changes."
  }
}
```

A model system notice is added to later user input for that model. It is saved with the session, so keep secrets out of it.

## How levels combine

The nearest level replaces the whole field, with these exceptions:

| Field | Behavior |
| --- | --- |
| `speech` | Merges by field. `vocabulary` lists add up, nearest first. |
| `modelSystemNotices` | Merges by key. |
| `flySprites` | Merges by field. |
| `mcpServers` | Merges by server name. A nearer entry replaces the whole server, including its credentials. |

`apiKeys`, `clientTools`, `history`, and `markdownExport` are read from global configuration only. Tau rejects them in project files, so a cloned repository cannot set them.

## Invalid and unknown fields

An invalid value produces a warning and is skipped, so a broader value may stay in effect. Unknown fields are removed without a warning, which means a misspelled field has no effect:

```json
{ "defaultPersnoa": "gpt-6.1-sol-coder" }
```

`tau` prints warnings at startup, `/reload` shows them for the current session, and `tau serve` and `tau telegram` write them to stderr. To check a new local startup, run `tau --debug` from the project directory.

## When changes apply

| Change | How to apply |
| --- | --- |
| `subagents`, `modelSystemNotices`, `speech.vocabulary` in a project | `/reload` while idle |
| `defaultPersona` | Applies to new sessions |
| `mcpServers` | New session, or reopen the session after the host unloads it |
| `defaultTheme`, `voiceId`, `recordingShortcut`, `markdownExport`, client tools | Restart the client |
| `apiKeys`, `history`, `flySprites`, host environment variables | Restart the host |
| Telegram configuration | Restart the runner |

## Choosing a level

Put personal defaults and secrets in global configuration. Put settings that collaborators share in the repository's `.tau/config.json`, and use a nested level only when a subdirectory needs a different value.
