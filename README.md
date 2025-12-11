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
- `/new`
- `!<bash>` (run a shell command)

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
