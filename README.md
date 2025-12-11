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
