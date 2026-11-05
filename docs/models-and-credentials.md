# Models and credentials

A persona selects a provider and model, and credentials authorize the request. The host makes model calls, so model credentials belong where the host runs. In a remote session, that is usually not your terminal.

## API keys

Set a provider's usual environment variable, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`, or use the global configuration:

```json
{
  "apiKeys": {
    "anthropic": "sk-ant-...",
    "openai": "sk-...",
    "google": "..."
  }
}
```

The environment variable wins. Keys are keyed by provider ID, and values are literal strings. Restart the process after changing either source.

The agent's Bash commands do not inherit variables whose names end in `_KEY`, `_SECRET`, `_TOKEN`, or `_PASSWORD`. When the agent runs a `tau tool` command, the key therefore needs to be in global configuration on that machine.

## Feature keys

| Feature | Environment variable | `apiKeys` entry | Read by |
| --- | --- | --- | --- |
| Web search and fetch | `EXA_API_KEY` | `exa` | Host |
| `/listen`, Telegram transcription, Google images | `GEMINI_API_KEY` | `google` | Client, runner, or command |
| `/speak` rewriting, spelling hints, OpenAI images | `OPENAI_API_KEY` | `openai` | Client, runner, or command |
| `/speak`, Telegram voice, speech generation | `ELEVENLABS_API_KEY` | `elevenlabs` | Client, runner, or command |
| PDF OCR | `MISTRAL_API_KEY` | `mistral` | Command |
| `tau.models`, OpenRouter tool | `OPENROUTER_API_KEY` | `openrouter` | Host or command |

## ChatGPT subscription

The `openai-codex` provider uses a ChatGPT Plus or Pro account through OAuth. Run these on the host:

```sh
tau auth login codex
tau auth list
tau auth use codex --account developer@example.com
tau auth logout codex --account developer@example.com
```

At most one account is active. The first login activates it, and later logins add an account without switching. Logging out the active account leaves none active. Tau never switches accounts by itself, including when one runs out of usage. A change applies to later requests without a restart.

## Other credentials

- MCP servers: see [MCP](mcp.md).
- Claude Code workers: sign in with Claude Code on the execution environment. See [subagents](subagents.md).
- Remote history and Fly Sprites: see [history](history.md) and [remote sessions](remote-sessions.md).

## Model catalog

Tau ships a model catalog with limits, capabilities, and prices. A host refreshes it from `pi.dev` in the background at startup if the cache is older than four hours. To refresh right away, run:

```sh
tau models refresh
```

A session keeps its catalog until `/reload`. A catalog record can change a model's endpoint and headers, so treat this refresh like a software update channel. Set `TAU_OFFLINE` to skip automatic checks.

A persona or launch allowlist can name a model ID missing from the catalog if the provider is known. Tau then uses the provider's default template, so its limits and prices may be wrong.

## Verifying

Check a credential by making a small request with the intended persona. Do not print the environment or configuration into a transcript. If a secret ends up in a session or log, rotate it at the provider.
