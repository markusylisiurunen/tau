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
  - try slash commands: `/help`, `/new`, `/fork:only-summary`, `/fork:with-last-turn`, `/copy`, `/copy:code` `/risk:none|read-only|read-write`, `/persona:<id>`, `/prompt:<id>`
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
- Risk levels (`/risk:none|read-only|read-write`) gate _model_ tool calls (bash/write/edit). User-initiated `!` commands run directly in the app, so keep that distinction clear when changing execution behavior.
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
    "google": "...",
    "openai": "sk-..."
  },
  "toolDisplayMode": "compact"
}
```

The `loadConfig()` function in `src/config.ts` reads this file. Environment variables take precedence if both are set.

## User-Extensibility: Custom Personas and Prompts

Users can extend tau with custom personas and prompt templates without modifying the codebase.

### Architecture

- **Content Loader** (`src/content_loader.ts`): Scans `~/.config/tau/personas/*.md` and `~/.config/tau/prompts/*.md`, parses YAML front-matter + markdown body, and returns merged arrays with built-ins first (so built-ins win on collision).
  - `loadUserPersonas()`: Returns `{ personas: Persona[]; errors: string[] }`
  - `loadUserPrompts()`: Returns `{ prompts: PromptTemplate[]; errors: string[] }`
  - `loadAllContent()`: Combines both, never throws (catches errors internally and at call sites)

- **Startup Integration** (`src/main.ts`): Calls `loadAllContent()` before CLI parsing. If it throws (safeguard), falls back to built-ins and logs a warning. This ensures `tau --help` works even if user content fails.

- **Persona Lookup** (`src/app.ts`): Now searches `this.personas` (the injected list) instead of a global function, so user personas work everywhere (`--persona`, `/persona:id`, initial persona selection).

- **Reload Command** (`/reload`): Reloads personas and prompts from disk, preserves the current persona if still available (falls back to first), updates the engine, and shows a summary. Guards against re-entrancy (won't reload while streaming).

### File Format

**Persona markdown** (`~/.config/tau/personas/example.md`):

```markdown
---
id: my-id
label: My Persona
provider: anthropic
model: claude-opus-4-5
description: Optional description
reasoning: medium
allowedReasoningLevels:
  - low
  - medium
  - high
---

System prompt body goes here.
```

Required: `id`, `provider`, `model`. Optional: all others.

**Prompt markdown** (`~/.config/tau/prompts/example.md`):

```markdown
---
id: my-template
label: My Template
description: Optional description
---

Prompt template body goes here.
```

Required: `id`. Optional: `label`, `description`.

### Collision Handling

User-defined personas/prompts with IDs that collide with built-ins are silently skipped (case-insensitive comparison). Errors are accumulated in the result and optionally shown to the user (e.g., via `/reload`).

## File Expansion: ctrl+f Keybinding

Users can press `ctrl+f` to expand `@file` mentions in the editor, materializing file contents into the conversation.

### Behavior

- Extracts `@path` tokens from editor text via regex
- Strips trailing punctuation (`.,:;)}\]`) to handle mentions like "@src/app.ts," or "(see @README.md)"
- Filters to only valid project files (case-sensitive exact match against `projectFiles` list)
- De-duplicates while preserving first-seen order
- Runs sequential bash commands: `printf '\n===== <path> =====\n'; cat -- <path>; printf '\n'`
  - `--` prevents `cat` from interpreting filenames starting with `-` as options
  - Blank lines before/after separate multiple files visually
  - Trailing newline ensures files don't run together
- Each file expansion becomes a separate bash execution card + user message in history
- Editor text left unchanged so user can ask follow-up question after expanding

### Guards

- Early return if `this.isStreaming` (prevents interleaving with assistant turn)
- Silent return if no valid tokens are found (no message)
- Skips unknown mentions without noise

### Implementation

- **`src/ui/custom_editor.ts`**: Added `onCtrlF` callback hook and intercepts `\x06` (ctrl+f) byte before default behavior
- **`src/app.ts`**: Implements `expandFileMentions()` and `shellQuote()` helper for safe path escaping
