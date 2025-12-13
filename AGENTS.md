# Repository Guidelines

## Project Structure & Module Organization

- `src/`: TypeScript source (ESM). Entry point is `src/main.ts`.
- `src/session/`: core session logic (message accumulation, turn processing).
- `src/tools/`: tool definitions and registry (e.g., bash execution or editing files)
- `src/ui/`: terminal UI components (rendering, themes, slash autocomplete, message views).
- `src/utils/`: small shared helpers (e.g., fuzzy matching, truncation).
- `dist/`: build output from TypeScript (`npm run build`). Do not edit by hand.
- `bin/`: local helper binaries (ignored by git).

## Build, Test, and Development Commands

- `npm install`: install dependencies (requires Node `>=20`).
- `npm run dev`: run from source via `tsx` (fast iteration).
- `npm run build`: compile TypeScript to `dist/` using `tsc`.
- `npm start`: run the compiled CLI from `dist/`.
- `npm run check`: auto-format/lint with Biome + typecheck (`tsc --noEmit`).
- `npm run fmt`: format the repo with Biome.
- `npm run lint`: lint with Biome (no writes).

## Coding Style & Naming Conventions

- Formatting/linting: Biome (2-space indent, line width 100). Prefer `npm run check` before pushing.
- TypeScript: keep types in `PascalCase`, values/functions in `camelCase`, and files `lowercase.ts` (as in `src/app.ts`).
- Keep OS-specific behavior isolated. Clipboard currently uses `pbcopy` (macOS-only) in `src/clipboard.ts` and has no cross-platform fallback yet.

## Testing Guidelines

There is no dedicated test runner in this repo currently. Validate changes by:

- `npm run check` (format + lint + typecheck)
- manual smoke tests: `npm run dev` and a full build/run (`npm run build && npm start`)
  - try slash commands: `/help`, `/new`, `/fork`, `/copy`, `/risk:none|read-only|read-write`, `/persona:<id>`, `/prompt:<id>`
  - try direct bash mode: prefix input with `!` to run a shell command (separate from model tool calls)
  - try file-path autocomplete: type `@` then a path fragment to insert a project-relative file path
  - if relevant, verify piped stdin behavior (non-interactive first message) and `/dev/tty` fallback for interactive input

## Commit & Pull Request Guidelines

- Commit messages follow a simple imperative style (examples from history: "add …", "implement …", "update …").
- Keep commits focused; avoid bundling formatting-only changes with behavior changes unless necessary.
- PRs should include: what changed, how to reproduce/verify in the terminal, and any relevant notes about risk level behavior (`/risk:none|read-only|read-write`) or API key usage.

## Security & Configuration Tips

- Never commit secrets. Use env vars like `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` for local runs.
- Treat any changes to shell/tool execution paths as security-sensitive: document defaults and failure modes in the PR description.
- Risk levels (`/risk:none|read-only|read-write`) gate *model* tool calls (bash/write/edit). User-initiated `!` commands run directly in the app, so keep that distinction clear when changing execution behavior.
- Bash tool execution sanitizes environment variables (see `sanitizeEnvironment()` in `src/tools/bash.ts`); update allow/deny lists carefully.

## Adding a New Slash Command

To add a new slash command (e.g., `/example`), update the following files:

1. **`src/commands.ts`**:
   - Add the command to the `Command` type union (e.g., `| { type: "example" }`)
   - Add parsing logic in `parseCommand()` (e.g., `if (trimmed === "/example") return { type: "example" };`)
   - Add the command to `buildHelpText()` so it appears in `/help` output

2. **`src/ui/slash_autocomplete.ts`**:
   - Add an entry to `STATIC_COMMANDS` array with `value`, `label`, and `description`

3. **`src/app.ts`**:
   - Add a `case "example":` in the `handleCommand()` switch statement
   - Implement the handler method (e.g., `private exampleCommand(): void { ... }`)

## Configuration

The app loads configuration from `~/.config/tau/config.json`. This file is optional and can store API keys as an alternative to environment variables:

```json
{
  "apiKeys": {
    "anthropic": "sk-ant-...",
    "openai": "sk-...",
    "google": "..."
  }
}
```

The `loadConfig()` function in `src/config.ts` reads this file. Environment variables take precedence if both are set.
