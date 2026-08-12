# Credentials

Tau can read secrets from configuration, process environments, and managed OAuth storage. The correct location depends on which process performs the authenticated operation. In a remote session, the attached terminal is usually not that process.

Treat credentials separately from model definitions. [Models](models.md) describes providers, model metadata, and `models.json`; this page describes how authenticated requests obtain secrets.

## Credential ownership

The host performs model calls and runs host-owned services such as web search and remote history. Its home and process environment therefore own most credentials. The execution environment still owns the `config.json` files used by a session, so a provider key loaded from project configuration crosses into the host for use in model calls.

Common cases are:

| Operation | Credential owner |
| --- | --- |
| Main-agent, subagent, sampling, and maintenance model calls | Session host |
| OpenAI Codex OAuth accounts | Session host home |
| Exa-backed `web.search` and `web.fetch` | Session host |
| Remote history replication and queries | Session host |
| Nook host tool | Session host |
| Cloudflare Sandbox bridge and Fly Sprite API | Session host startup |
| `/listen` and `/speak` | TUI client |
| Telegram transcription and voice responses | Telegram runner |
| `tau tool pdf-unpack` | The process running that command |

With local `tau`, these roles normally share one machine. With `tau attach`, setting a key only in the attached client's shell does not authenticate the remote host. Run `tau auth` on the host machine and set host-owned environment variables where `tau serve` or the SDK host actually runs. See [ownership and scope](ownership-and-scope.md) for the full boundary.

## Provider API keys

Tau accepts provider API keys in the effective runtime configuration:

```json
{
  "apiKeys": {
    "anthropic": "<anthropic-api-key>",
    "openai": "<openai-api-key>",
    "google": "<gemini-api-key>"
  }
}
```

Keys are provider IDs, not model IDs. `apiKeys` merges by provider across configuration levels, so a nearer project value replaces the same provider's broader value while unrelated provider entries remain. Global and project discovery is defined in [configuration](configuration.md).

Configuration files contain literal strings. Tau does not expand `$NAME` or `${NAME}` inside JSON. A key placed in `.tau/config.json` is project data and may be committed accidentally. Prefer host process environment variables or private global configuration when the credential should not live with the project.

For model authentication, Tau resolves credentials in this order:

1. A managed stored credential for the provider, when one exists.
2. `apiKeys.<provider>` from the session's effective runtime configuration.
3. The provider runtime's ambient authentication, such as its standard API-key environment variable or supported cloud credential mechanism.

This means `apiKeys.openai` wins over `OPENAI_API_KEY` for model calls. If the config entry is absent, OpenAI can use `OPENAI_API_KEY`. Similar conventional variables include `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and `MISTRAL_API_KEY`. Anthropic's ambient resolution also supports bearer and OAuth token variables, with `ANTHROPIC_AUTH_TOKEN` before `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`.

Other bundled providers define their own ambient authentication. A provider being present in the bundled [model catalog](models.md) does not prove that the host currently has usable credentials.

Changes to `apiKeys` are picked up when an idle session runs `/reload`, or when a new session is created. Environment changes generally require restarting the owning process because an already-running process does not receive later shell exports.

## Feature-specific keys

Several Tau features share provider credentials but intentionally prefer a fixed environment variable over configuration. Their precedence is:

| Feature | Resolution order |
| --- | --- |
| Exa web search and fetch | `EXA_API_KEY`, then `apiKeys.exa` |
| Google speech, Gemini speech-to-text, Telegram Gemini transcription, and Telegram voice responses | `GEMINI_API_KEY`, then `apiKeys.google` |
| Mistral speech-to-text, Telegram Mistral transcription, and PDF OCR | `MISTRAL_API_KEY`, then `apiKeys.mistral` |

The Google and Mistral rows describe feature-specific helpers. Model calls follow the general model-authentication order instead, where the configured provider key wins over ambient environment authentication.

`web.discover` does not require Exa. `web.search` and `web.fetch` do. `/speak` and Telegram `/tts_on` voice responses use Google. `/listen` and incoming Telegram audio use the configured `speechToText.provider`, which is `mistral` unless configuration selects `gemini`. PDF OCR through `tau tool pdf-unpack` uses Mistral.

Set these variables on the process that owns the feature. For example, a remote TUI's `/speak` reads the attached client's `GEMINI_API_KEY`, while a Google model selected by the session reads credentials at the host.

## OpenAI Codex OAuth

The `openai-codex` provider uses ChatGPT Plus or Pro OAuth accounts managed by Tau. Authenticate on the host:

```sh
tau auth login codex
```

The flow opens or prints a browser URL and may fall back to a device code or pasted redirect. Tau stores the result under the host user's `~/.config/tau/auth.json` with private file permissions. Do not edit this file directly. The auth commands coordinate concurrent access, refresh tokens when needed, and preserve account state safely.

Multiple Codex accounts may be present. Inspect account identities, enabled state, usage windows, and the account Tau would currently prefer without displaying tokens:

```sh
tau auth list
```

Manage one account by the account ID or email shown in that output:

```sh
tau auth disable codex --account developer@example.com
tau auth enable codex --account developer@example.com
tau auth logout codex --account developer@example.com
```

Login adds a new account or refreshes the matching account. Disable keeps the account stored but removes it from automatic selection. Logout removes it.

### Account selection and failover

Without an override, Tau chooses among enabled accounts with usable quota and keeps the selected account stable for a session. If a provider error reveals that the selected account's tracked quota is exhausted, Tau clears that session selection so a later attempt can choose another usable account. Disabled accounts, accounts whose credentials cannot be refreshed, and accounts with exhausted quota are not suitable candidates.

Set `TAU_CODEX_ACCOUNT` in the host process environment to force one stored account by email or account ID:

```sh
TAU_CODEX_ACCOUNT=developer@example.com tau
```

Matching is case-insensitive. A missing or disabled match fails with an explicit error. A forced account disables automatic failover, so use it when deterministic account selection matters more than continuity.

Auth storage is reloaded when credentials are resolved. Login, enable, disable, and logout therefore affect later credential resolutions without a host restart. They do not rewrite a model request already in flight. A changed `TAU_CODEX_ACCOUNT` still requires restarting the host process.

## History and Nook indirection

History and Nook can name environment variables instead of embedding secrets in configuration.

Remote history is global-only configuration:

```json
{
  "history": {
    "endpoint": "https://history.example.net",
    "apiKeyEnv": "TEAM_HISTORY_KEY"
  }
}
```

History resolves its API key in this order:

1. `TAU_HISTORY_API_KEY`
2. The host environment variable named by `history.apiKeyEnv`
3. Inline `history.apiKey`

If `history` is configured but none resolves, host setup fails for the remote target. Without `history` configuration, transcripts remain machine-local. See [history](history.md) for service behavior.

A Nook Access service token uses an ID plus a secret:

```json
{
  "nook": {
    "domain": "apps.example.net",
    "accessClientId": "service-token-id.access",
    "accessClientSecretEnv": "NOOK_ACCESS_CLIENT_SECRET"
  }
}
```

If the named `accessClientSecretEnv` has a non-empty value, it wins over inline `accessClientSecret`; otherwise Tau falls back to the inline value. The process performing the Nook operation resolves it. For a session tool that is the host, while `tau nook` commands use the invoking CLI process. Nook setup and destruction also accept their documented command flags and environment variables. See [Nook](nook.md).

## Hosted execution credentials

Cloudflare Sandbox bridges and Fly Sprite APIs are host-owned resolver configuration. They must be available when the host is constructed, before a client asks it to create one of those execution environments.

A Cloudflare bridge can use an inline key or name a host environment variable:

```json
{
  "cloudflareSandbox": {
    "bridges": {
      "engineering": {
        "url": "https://sandbox-bridge.example.workers.dev",
        "apiKeyEnv": "TAU_SANDBOX_BRIDGE_KEY"
      }
    }
  }
}
```

For a bridge, inline `apiKey` wins when present; `apiKeyEnv` is consulted only when no inline key exists. A bridge may also be configured without authentication.

A Fly API requires a token:

```json
{
  "flySprites": {
    "apis": {
      "engineering": {
        "baseURL": "https://api.sprites.dev",
        "tokenEnv": "FLY_SPRITES_TOKEN"
      }
    }
  }
}
```

For Fly, inline `token` wins when present; `tokenEnv` is the fallback. Session creation fails if neither resolves.

These target definitions are read from the host's startup configuration, not from an attached client. `/reload` refreshes session runtime content but does not rebuild the host's execution-environment resolvers. Restart the host after changing bridge definitions, Sprite API definitions, or their environment.

## Safe verification

Verify credentials through the operation that owns them, without printing secret values:

- Run `tau auth list` to check Codex identities, enabled state, refresh health, and quota windows.
- Run `/reload` while the session is idle after changing runtime `apiKeys`; review every configuration warning.
- Make a small request with the intended persona to verify model authentication and endpoint access.
- Exercise the specific feature after setting Exa, speech, History, Nook, Cloudflare, or Fly credentials. Their missing-credential errors name the accepted source.
- For remote sessions, first confirm which machine is the host and which process owns the feature.

Do not verify by printing the process environment, dumping `config.json`, or reading `auth.json` into a transcript. If a secret was exposed in shell history, logs, a session, or version control, rotate it at the provider and replace the compromised value. Broader handling guidance is in [security](security.md) and failure checks are in [troubleshooting](troubleshooting.md).
