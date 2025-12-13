# tau

Minimal terminal chat app built on `@mariozechner/pi-ai` + `@mariozechner/pi-tui`.

## Run

```sh
npm install
npm run dev
```

Requires Node 20+. macOS only (clipboard uses `pbcopy`).

Set an API key:

```sh
export OPENAI_API_KEY=...
# or
export ANTHROPIC_API_KEY=...
```

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
tau --tool all --no-context
```

- `--help`
- `--persona <id>`: see `tau --help` for available personas.
- `--reasoning <level>`: `minimal`, `low`, `medium`, `high`, `xhigh`.
- `--tool <level>`: `none`, `read`, `all` (default: `read`).
- `--no-context`: skip injecting `AGENTS.md` context.

Piping input works as expected:

```sh
cat file.ts | tau --persona opus
```
