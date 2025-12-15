# Tau

Terminal-based AI chat client with tool execution, streaming responses, and risk-level controls. Supports Anthropic, OpenAI, and Google models.

## Architecture

- **ChatApp** (`src/app.ts`): Main orchestrator handling UI, commands, and state
- **SessionEngine** (`src/session/session_engine.ts`): Manages LLM streaming and tool dispatch via async generator events
- **ToolRegistry** (`src/tools/registry.ts`): Registers bash, write, edit, and task tools
- **TUI**: Terminal rendering via `@mariozechner/pi-tui` with components in `src/ui/`

**Data flow**: User input → `ChatApp.handleSubmit()` → `SessionEngine.processTurn()` (yields events) → tool dispatch → UI rendering.

**Engine events**: `processTurn()` yields `assistant_start`/`partial`/`final` for streaming text, `tool_ui` for tool progress, `tool_result` when tools complete, and `notice` for warnings. Tools can return immediate results or two-phase results (emit start event, run async, emit completion) for progress indication.

## Key modules

- `src/main.ts` - Entry point: config loading, CLI parsing, app bootstrap
- `src/personas.ts` - Persona definitions and system prompt blocks
- `src/content_loader.ts` - User persona/prompt loading from `~/.config/tau/`
- `src/commands.ts` - Slash command parsing
- `src/session/` - Turn processing and message accumulation
- `src/tools/` - Tool implementations (bash, write, edit, task)
- `src/subagents/` - Isolated agent execution (explore subagent)
- `src/ui/` - Terminal components, themes, autocomplete
- `src/utils/` - Helpers for truncation, fuzzy matching, context building

## Tool system

| Tool    | Purpose                     | Risk requirement                               |
| ------- | --------------------------- | ---------------------------------------------- |
| `bash`  | Shell execution             | `read-only` for reads, `read-write` for writes |
| `write` | Create/overwrite files      | `read-write`                                   |
| `edit`  | Replace exact text in files | `read-write`                                   |
| `task`  | Run isolated subagent       | `read-only` or higher                          |

Risk levels (`none`, `read-only`, `read-write`) gate model tool calls. The model declares intent via `safetyLevel` on bash calls.

**Bash limits**: 2MB capture, 1MB to model context, 50KB to display, 60s timeout. Environment sanitized via allowlist (see `ALLOWED_ENV_VARS` in `src/tools/bash.ts`).

## Personas and subagents

**Built-in**: 5 models (Claude Opus/Haiku 4.5, GPT-5.2, Gemini 3 Pro/2.5 Flash) × 3 variants (basic, coder, raw) = 15 personas. Coder variants include the **explore** subagent for multi-turn read-only codebase investigation.

User personas: `~/.config/tau/personas/*.md` with YAML frontmatter (`id`, `provider`, `model` required).

## Configuration

- **Global**: `~/.config/tau/config.json` (API keys, `toolDisplayMode`, `defaultPersona`, `defaultRisk`)
  - `defaultPersona` (optional): String ID of the persona to use by default when starting the app. Overridden by `--persona` flag.
  - `defaultRisk` (optional): Default risk level (`none`, `read-only`, `read-write`). Overridden by `--risk` flag. Defaults to `read-only`.
- **Bash commands**: `.tau/config.json` or `~/.tau/config.json` with `{ "bash": [{ "id", "cmd", "description?" }] }`
- **User prompts**: `~/.config/tau/prompts/*.md` (YAML frontmatter with `id`)

## Commands

- `/help`, `/new`, `/copy`, `/copy:code`, `/reload`
- `/fork:only-summary`, `/fork:with-last-turn` - Fork with compressed history
- `/risk:none|read-only|read-write`, `/persona:<id>`, `/prompt:<id>`, `/bash:<id>`
- `!<cmd>` - Direct bash execution (bypasses model)
- `#<request>` - Memory mode for updating AGENTS.md

**Keybindings**: `Shift+Tab` (cycle reasoning), `Ctrl+T` (toggle thinking), `Ctrl+O` (compact UI), `Ctrl+F` (expand @files), `Escape` (interrupt)

## Development

- `npm run check` - Format (Biome) + typecheck
- `npm run dev` - Run from source via tsx
- `npm run build` - Compile to dist/

**Do not run the app** (`npm run dev`, `npm start`, `node dist/main.js`) in automated or non-interactive environments. It launches an interactive TUI that requires a real terminal.

**Style**: Biome (2-space indent, 100 line width). Types `PascalCase`, values/functions `camelCase`, files `lowercase.ts`.

## Adding a slash command

1. `src/commands.ts`: Add to `Command` type, `parseCommand()`, `buildHelpText()`
2. `src/ui/slash_autocomplete.ts`: Add to `STATIC_COMMANDS`
3. `src/app.ts`: Add case in `handleCommand()`, implement handler

## Security

- Risk levels gate model tools only; `!` commands bypass checks
- Bash sanitizes environment, blocks `*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD` patterns
- Process groups terminated on abort to prevent orphaned processes

## Releasing

Releases are published to npm locally (no CI publish workflow).

1. Ensure you are on `main` with a clean working tree.
2. Bump the version and create a tag:
   - `npm version patch|minor|major` (creates a `vX.Y.Z` tag)
3. Run verification and build:
   - `npm run check`
   - `npm run build`
4. Push the commit and tag:
   - `git push --follow-tags`
5. Create a GitHub Release:
   - `gh release create v$(node -p "require('./package.json').version") --generate-notes`
6. Publish to npm:
   - `npm publish --access public`

## Maintaining this file

Keep AGENTS.md/README.md in sync with the codebase. After making code changes, reflect on whether documentation needs updates. When making changes that affect architecture, commands, configuration, or other documented behavior, update the relevant sections here. This includes updates to this file itself, README.md, or any other user-facing docs. Do not add documentation for previously undocumented features or behavior unless explicitly requested.
