# tau

Minimal terminal chat app built on `@mariozechner/pi-ai` + `@mariozechner/pi-tui`.

## Run

```sh
npm install
npm run dev
```

Requires Node 20+. macOS only (clipboard uses `pbcopy`).

Set an API key via environment variable:

```sh
export ANTHROPIC_API_KEY=...
# or
export OPENAI_API_KEY=...
# or
export GOOGLE_API_KEY=...
```

Or store it in a config file at `~/.config/tau/config.json`:

```json
{
  "apiKeys": {
    "anthropic": "sk-ant-...",
    "openai": "sk-...",
    "google": "..."
  },
  "userPreferences": "Prefer concise responses. Use TypeScript for code examples. Always explain trade-offs."
}
```

Environment variables take precedence over the config file. The `userPreferences` field is optional; when provided as a non-empty string, it is automatically injected into the system prompt wrapped in `<user_preferences>` tags, allowing you to specify consistent guidance (style, constraints, defaults) without re-prompting each session.

## Commands

- `/help`
- `/new` (clear session)
- `/copy` (copy last assistant message)
- `/persona:<id>` (switch persona)
- `/prompt:<id>` (insert prompt template)
- `/tool:none|read|all` (configure model tool access; default: `read`)
- `!<cmd>` (run immediate shell command)

## Keys

- `shift+tab`: cycle reasoning effort (low/medium/high)
- `ctrl+t`: toggle thought chain visibility
- `esc`: interrupt generation
- `ctrl+c`: exit

## CLI Options

```sh
tau --help
tau --persona opus --reasoning high
tau --tool all --with-context
```

- `--help`
- `--persona <id>`: see `tau --help` for available personas.
- `--reasoning <level>`: `minimal`, `low`, `medium`, `high`, `xhigh`.
- `--tool <level>`: `none`, `read`, `all` (default: `read`).
- `--with-context`: inject `AGENTS.md` context into the system prompt.

Piping input works as expected:

```sh
cat file.ts | tau --persona opus
```
