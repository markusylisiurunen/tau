# tau

Minimal terminal chat app built on `@mariozechner/pi-ai` + `@mariozechner/pi-tui`.

## Run

```sh
npm install
npm run dev
```

Requires Node 20+. macOS only (clipboard uses `pbcopy`).

Set an API key, e.g.:

```sh
export OPENAI_API_KEY=...
# or
export ANTHROPIC_API_KEY=...
```

## Commands

- `/help`
- `/copy`
- `/persona:<id>`
- `/prompt:<id>` (insert a prompt template into the editor)
- `/tool:none` (block all model bash tool calls)
- `/tool:read` (allow read-only model bash tool, default)
- `/tool:all` (allow all model bash tool)
- `/new`
- `!<bash>` (run a shell command)
- Models can also call the `bash` tool during a turn; the tool requires a `risk` argument ("read" or "write"). Tau executes allowed calls, shows output, sends a tool result back to the model, and continues the assistant turn (up to 128 tool subturns). If a call's risk exceeds the current `/tool:` level, it is blocked and the model is told why in the tool result.
- Tau appends a static `<environment>` tag to the system prompt at session start (including the initial tool access level, current time, and cwd). Later `/tool:*` changes are conveyed via a `<system>` prefix on the next user message.

## CLI options

You can also set a few startup options via flags:

```sh
tau --help
tau --persona opus
tau --reasoning high
tau --persona gpt-5.2 --reasoning medium
```

Available flags:

- `--help` – show usage and exit.
- `--persona <id>` – start with a specific persona. See `tau --help` for the current list.
- `--reasoning <level>` – set reasoning effort for the initial persona. Levels: `minimal`, `low`, `medium`, `high`, `xhigh`, or `default`.
- `--tool <level>` – set initial model bash tool access. Levels: `none`, `read`, or `all`. Default: `read`.
- `--no-context` – do not inject any `AGENTS.md` project context into the system prompt.

If you pipe text into `tau`, it will be used as the first user message and sent to the model immediately:

```sh
cat somefile.txt | tau
echo "summarize this:" | tau --persona opus
```

When running in a terminal, Tau will still stay interactive after consuming stdin.
