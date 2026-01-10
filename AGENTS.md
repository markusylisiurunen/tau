# Tau

Terminal-based AI chat client with tool execution, streaming responses, and risk-level controls. Supports Anthropic, OpenAI, and Google models.

## Architecture

- **ChatApp** (`src/app.ts`): Main orchestrator handling UI, commands, and state
- **SessionEngine** (`src/session/session_engine.ts`): Manages LLM streaming and tool dispatch via async generator events
- **ToolRegistry** (`src/tools/registry.ts`): Registers bash, write, edit, task, and fork tools
- **TUI**: Terminal rendering via `@mariozechner/pi-tui` with components in `src/ui/`
- **Chat UI models** (`src/ui/chat_message_model.ts`): Typed message models and rendering glue for UI components
- **Tool output layout** (`src/ui/tool_output_layout.ts`): Shared compact/expanded tool UI layout and header building

**Data flow**: User input → `ChatApp.handleSubmit()` → `SessionEngine.processTurn()` (yields events) → tool dispatch → UI rendering.

**Engine events**: `processTurn()` yields `assistant_start`/`partial`/`final` for streaming text, `tool_ui` for tool progress, `tool_result` when tools complete, and `notice` for warnings. Tools can return immediate results or two-phase results (emit start event, run async, emit completion) for progress indication.

## Key modules

- `src/main.ts` - Entry point: config loading, CLI parsing, app bootstrap
- `src/personas.ts` - Built-in persona definitions and system prompt blocks
- `src/content_loader.ts` - User/project content loading (personas, prompts, skills)
- `src/commands.ts` - Slash command parsing
- `src/session/` - Turn processing and message accumulation
- `src/tools/` - Tool implementations (bash, write, edit, task, fork, web_search, web_fetch)
- `src/subagents/` - Isolated agent execution (`explore`, `web`) and runtime (`src/subagents/subagent_engine.ts`)
- `src/ui/` - Terminal components, themes, autocomplete
- `src/ui/chat_message_model.ts` - Message view models and renderer for the chat UI
- `src/ui/tool_output_layout.ts` - Shared tool output layout primitives
- `src/utils/project_files.ts` - Project file discovery for `@file` autocomplete
- `src/utils/` - Helpers for truncation, fuzzy matching, context building

## Tool system

| Tool    | Purpose                     | Risk requirement                               |
| ------- | --------------------------- | ---------------------------------------------- |
| `bash`  | Shell execution             | `read-only` for reads, `read-write` for writes |
| `write` | Create/overwrite files      | `read-write`                                   |
| `edit`  | Replace exact text in files | `read-write`                                   |
| `task`  | Run isolated subagent       | `read-only` or higher                          |
| `fork`  | Fork session and run agent  | `read-only` or higher                          |
| `read`  | Read file content safely    | `restricted`                                   |
| `grep`  | Search the project safely   | `restricted`                                   |
| `list`  | List directory contents     | `restricted`                                   |

Risk levels (`restricted`, `read-only`, `read-write`) gate model tool calls. The model declares intent via `safetyLevel` on bash calls.

**Bash limits**: 2MB raw capture, 60s timeout. Environment sanitized via allowlist (see `ALLOWED_ENV_VARS` in `src/tools/bash.ts`).

**Model context truncation**: Truncation follows a `num_bytes / 6` token heuristic.

- **Bash (assistant)**: 4,096 lines / 25,000 tokens for stdout and stderr separately.
- **Bash (user/!/@)**: 16,384 lines / 100,000 tokens for stdout; 4,096 lines / 25,000 tokens for stderr.
- **web_fetch**: 8,192 lines / 50,000 tokens.
- **web_search**: 4,096 lines / 25,000 tokens.

**UI truncation**:

- **Bash (compact)**: 4 head + 4 tail lines plus a summary line.
- **Bash (expanded)**: 32 lines / 5,000 tokens from the middle.
- **read/list/grep/write (compact)**: 16 lines preview from the start.
- **edit**: full diff (no UI truncation).

**Subagent-only tools**: the `web` subagent uses `web_search` and `web_fetch` (see `src/tools/web_search.ts`, `src/tools/web_fetch.ts`) via the subagent tool registry in `src/subagents/subagent_engine.ts`.

## Personas and subagents

**Built-in**: 5 models (Claude Opus/Haiku 4.5, GPT-5.2, Gemini 3 Pro/Flash) × 2 variants (chat, coder) = 10 personas. Both variants include the **web** subagent (max 64 turns, trigger: explicit) for agentic web research, and coder variants also include the **explore** subagent (max 64 turns, trigger: eager) for multi-turn read-only codebase investigation. Built-in personas have `skills: "*"` to enable all discovered skills by default. See trigger sensitivity below for how subagent and skill activation is controlled.

Personas can be defined at user level (`~/.config/tau/personas/*.md`) and project level (`.tau/personas/*.md`). Both use YAML frontmatter with required fields `id`, `provider`, `model` and optional fields:

- `label`, `description`: metadata
- `reasoning`: default reasoning effort level
- `allowedReasoningLevels`: list of reasoning levels shown in the UI
- `skills`: list of enabled skill names (matched by `name` in skill frontmatter), or `"*"` to enable all discovered skills
- `subagents`: enable sub-agents (`explore` for codebase investigation, `web` for web research). specify as a list `[explore]`, `[web]`, or `[explore, web]` to use the main persona's model, or as an object with custom model/reasoning per sub-agent.

On conflicts, project personas override user and built-in personas.

## Configuration

- **Global**: `~/.config/tau/config.json` (API keys, `toolDisplayMode`, `defaultPersona`, `defaultRisk`)
  - `apiKeys.parallel` (optional): Parallel API key for the `web` subagent.
  - `defaultPersona` (optional): String ID of the persona to use by default when starting the app. Overridden by `--persona` flag.
  - `defaultRisk` (optional): Default risk level (`restricted`, `read-only`, `read-write`). Overridden by `--risk` flag. Defaults to `read-only`.
- **Project Context**: `AGENTS.md` (searched from current directory up to home)
- **Bash commands**: `.tau/config.json` or `~/.tau/config.json` with `{ "bash": [{ "id", "cmd", "description?" }] }`
- **Prompts**: user-level `~/.config/tau/prompts/*.md` and project-level `.tau/prompts/*.md` (project `.tau/` dirs are discovered by walking up from cwd to the git repo root, project overrides on conflicts)
- **Skills**: user `$XDG_CONFIG_HOME/tau/skills/` (defaults to `~/.config/tau/skills/`) and project `.tau/skills/` (project `.tau/` dirs are discovered by walking up from cwd to the git repo root). Each skill is a directory containing `SKILL.md` with required YAML frontmatter:
  - `name` (1-64 chars, `a-z0-9-`, must match directory name)
  - `description` (1-1024 chars)

  Optional frontmatter: `license`, `compatibility` (<=500 chars), `metadata` (string map), `allowed-tools` (validated, currently ignored).

  **Trigger sensitivity**: Skills can specify when they should be activated by including a trigger keyword in their description. If not specified, the default is **balanced**:
  - Include "Trigger: eager" to use whenever the capability helps, even if not explicitly requested
  - Include "Trigger: balanced" (or omit to use default) to use when the request clearly matches the skill's purpose
  - Include "Trigger: explicit" to use only when the user specifically names or requests the skill

  Example: "Git workflow helper. Trigger: eager." or "Database migrator. Trigger: explicit."

  On conflicts, project overrides user by `name`.

## Trigger sensitivity

Trigger sensitivity is a concept that guides how proactively the model should activate skills and sub-agents. All three levels are defined in the system prompt, and the model respects them when deciding whether to use a capability.

**Levels:**

- **eager**: Use proactively whenever the capability would help, even if not explicitly requested. The model should consider using it for related problems.
- **balanced**: Use when the request clearly matches the capability. This is the default if not specified. The model should activate it when appropriate, but not speculatively.
- **explicit**: Use only when the user specifically names or requests it. The model should never use this capability unless explicitly mentioned.

**Built-in subagents:**

- `explore`: eager (multi-turn codebase investigation is often valuable for code understanding questions)
- `web`: explicit (web research should only happen when explicitly requested, to avoid unnecessary external calls)

**For custom skills:** Include "Trigger: eager", "Trigger: balanced", or "Trigger: explicit" in your skill's description. If omitted, balanced is the default. This ensures the model knows when to use your skill.

## CLI flags

- `--help`, `-h` - Show help and exit
- `--debug` - Print debug info (loaded personas, prompts, bash commands, skills, full system prompt, tool schemas) and exit
- `--persona <id>[:<level>]`, `-p` - Start with a specific persona and optional reasoning level
- `--risk <level>`, `-r` - Set initial risk level (`restricted`, `read-only`, `read-write`)
- `--with-context` - Inject AGENTS.md into the system prompt

The `--debug` flag respects `--persona` and `--with-context`, so you can inspect exactly what system prompt a given configuration produces.

## Commands

- `/help`, `/new`, `/copy`, `/copy:code`, `/reload`
- `/compact:only-summary`, `/compact:with-last-turn` - Compact history to continue
- `/risk:restricted|read-only|read-write`, `/persona:<id>`, `/prompt:<id>`, `/bash:<id>`
- `!<cmd>` - Direct bash execution (bypasses model)
- `#<request>` - Memory mode for updating AGENTS.md

**Keybindings**: `Shift+Tab` (cycle reasoning), `Ctrl+R` (cycle risk level), `Ctrl+P` (cycle personality), `Ctrl+T` (toggle thinking), `Ctrl+O` (compact UI), `Ctrl+F` (expand @files), `Ctrl+S` (stash input to clipboard), `Alt+Up` (pop queued message), `Escape` (interrupt), `Ctrl+C` (exit)

## Development

- `npm run check` - Format (Biome) + typecheck
- `npm run build` - Compile to dist/
- `npm test` - Build + run UI tests

**Do not run the app** (`npm start`, `node dist/main.js`) ever. It launches an interactive TUI that requires a real terminal.

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

Publishing to npm happens automatically via GitHub Actions when a GitHub Release is published.

1. Ensure you are on `main` with a clean working tree.
2. Run verification, build and tests:
   - `npm run check`
   - `npm run build`
   - `npm test`
3. Bump the version and create a tag:
   - `npm version patch|minor|major` (creates a `vX.Y.Z` tag)
4. Push the commit and tag:
   - `git push --follow-tags`
5. Create a GitHub Release (this triggers the publish workflow):
   - `gh release create v$(node -p "require('./package.json').version") --generate-notes`

Notes:

- The workflow uses the `NPM_TOKEN` GitHub secret to authenticate with npm.

## Maintaining this file

Keep AGENTS.md/README.md in sync with the codebase. After making code changes, reflect on whether documentation needs updates. When making changes that affect architecture, commands, configuration, or other documented behavior, update the relevant sections here. This includes updates to this file itself, README.md, or any other user-facing docs. Do not add documentation for previously undocumented features or behavior unless explicitly requested.
