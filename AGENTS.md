# Tau

Terminal-based AI chat client with tool execution, streaming responses, and risk-level controls. Supports Anthropic, OpenAI, and Google models.

## Architecture

- **ChatApp** (`src/tui/app.ts`): Thin wiring between the controller and TUI view adapter
- **ChatController** (`src/tui/chat_controller.ts`): Orchestrates session state, commands, and core events
- **TuiChatView** (`src/tui/chat_view.ts`): TUI adapter for rendering, editor, and tool UI
- **CoreSession** (`src/core/session/core_session.ts`): Owns session state and emits core events for consumers
- **SessionEngine** (`src/core/session/session_engine.ts`): Internal streaming/tool dispatch runner used by CoreSession
- **Core events** (`src/core/events/`): Serializable event protocol emitted by the core runtime
- **Mode adapters** (`src/core/modes/`): ModeAdapter interface and RPC stub for alternate front-ends
- **ToolCatalog** (`src/core/tools/catalog.ts`): Builds the internal tool registry
- **ToolExecutionBackend** (`src/core/tools/execution_backend.ts`): Execution backend for filesystem/process tools (local host or docker sandbox)
- **ToolRegistry** (`src/core/tools/registry.ts`): Tool registry type used by ToolCatalog for main-session (bash, write, edit, task, fork) and sub-agent (bash, web_search, web_fetch) registries
- **TUI**: Terminal rendering via `@mariozechner/pi-tui` with components in `src/tui/ui/`
- **Chat UI models** (`src/tui/ui/chat_message_model.ts`): Typed message models and rendering glue for UI components
- **Tool output layout** (`src/tui/ui/tool_output.ts`): Shared compact/expanded tool UI layout and header building
- **Tool UI registry** (`src/tui/ui/tool_ui_registry.ts`): Maps ToolUiEvent types to tool output view models

**Data flow**: User input → `ChatApp` → `ChatController.onUserInput()` → `CoreSession.events()` (yields core events) → `ChatController.onEvent()` → `TuiChatView` rendering.

**Engine events**: `CoreSession.events()` yields `assistant_start`/`partial`/`final` for streaming text, `tool_ui` for tool progress, `tool_result` when tools complete, and `notice` for warnings. The core event protocol lives in `src/core/events/`. Tools can return immediate results or two-phase results (emit start event, run async, emit completion) for progress indication.

## Key modules

- `src/main.ts` - Entry point: config loading, CLI parsing, app bootstrap
- `src/core/`
  - `personas.ts` - Built-in persona definitions and system prompt blocks
  - `prompts.ts` - Built-in prompt templates
  - `types.ts` - Core types and reasoning levels
  - `commands/registry.ts` - Slash command parsing and dispatch
  - `cli.ts` - CLI argument parsing and help text
  - `debug.ts` - `--debug` output
  - `config/deps.ts` - Config loader dependencies
  - `config/paths.ts` - Config level discovery
  - `config/bash_commands.ts` - Bash command parsing and merge rules
  - `config/runtime.ts` - Runtime config loader (config + content)
  - `config/virtual_bundle.ts` - Built-in content bundling
  - `config/virtual_defaults.ts` - Built-in default content
  - `config/content_loader.ts` - Load personas, prompts, skills, themes
  - `config/schema.ts` - Config schema and merge rules
  - `auth/cli.ts` - login/logout flows
  - `auth/auth_storage.ts` - Credential storage and refresh
  - `auth/credential_resolver.ts` - API key resolution
  - `auth/auth_paths.ts` - Auth file path resolution
  - `auth/auth_messages.ts` - Auth error messaging
  - `auth/codex_prompt.ts` - Codex system prompt handling
  - `events/` - Core event protocol types and serialization
  - `session/` - Turn processing, streaming, and tool dispatch
  - `tools/` - Tool definitions (bash, write, edit, task, fork, web_search, web_fetch) plus read/list/grep helpers not wired into the default registry
  - `tools/execution_backend.ts` - Local and sandbox tool backends
  - `tools/sandbox/docker_sandbox.ts` - Docker sandbox runner
  - `subagents/` - Explore/web subagents and runner
  - `modes/` - ModeAdapter interface and RPC stub
  - `runtime/deps.ts` - Core dependency injection
  - `utils/context_builder.ts` - System prompt assembly
  - `utils/agents_files.ts` - AGENTS.md discovery
  - `utils/project_files.ts` - Project file discovery for `@file` autocomplete
  - `utils/tool_preview.ts` - Tool UI preview truncation
  - `utils/truncate.ts` - Truncation helpers
  - `utils/model_stream.ts` - Model streaming wrapper
  - `utils/restricted_fs.ts` - Restricted filesystem helpers
  - `utils/spawn_capture.ts` - Process capture helper
  - `utils/sanitize_env.ts` - Environment sanitization
  - `utils/token.ts` - Token heuristics
  - `utils/streaming_settings.ts` - Streaming config parsing
  - `utils/fuzzy.ts` - Fuzzy matching for autocomplete
  - `utils/format.ts` - Display formatting
  - `utils/git.ts` - Git helpers
  - `utils/messages.ts` - Message helpers
- `src/tui/`
  - `app.ts` - ChatApp wiring
  - `chat_controller.ts` - UI-agnostic controller for session orchestration
  - `chat_view.ts` - TUI view adapter used by ChatApp
  - `tool_ui_router.ts` - Tool UI event sequencing and routing
  - `terminal.ts` - Terminal adapter
  - `clipboard.ts` - Clipboard helper
  - `export/` - HTML export pipeline
  - `ui/` - Terminal UI surface (messages, tool output, editor, autocomplete)
  - `ui/components/` - Editor and layout primitives
  - `ui/theme/` - Theme tokens, palette, and renderer
  - `ui/chat_message_model.ts` - Message view models and renderer for the chat UI
  - `ui/tool_output.ts` - Shared tool output layout primitives
  - `ui/tool_ui_registry.ts` - Tool UI renderer registry

## Tool system

| Tool    | Purpose                     | Risk requirement                               |
| ------- | --------------------------- | ---------------------------------------------- |
| `bash`  | Shell execution             | `read-only` for reads, `read-write` for writes |
| `write` | Create/overwrite files      | `read-write`                                   |
| `edit`  | Replace exact text in files | `read-write`                                   |
| `task`  | Run isolated subagent       | `read-only` or `read-write`                    |
| `fork`  | Fork session and run agent  | `read-only` or `read-write`                    |

Note: read/list/grep tool definitions exist in `src/core/tools`, but ToolCatalog does not register them in the default tool set.

Risk levels (`read-only`, `read-write`) gate model tool calls. The model declares intent via `safetyLevel` on bash calls.

**Bash limits**: 2MB raw capture, 60s timeout. No TTY/stdin (interactive prompts and editors will hang or fail). Environment sanitized via allowlist (see `ALLOWED_ENV_VARS` in `src/core/utils/sanitize_env.ts`), git is forced non-interactive (no prompt/editor/pager, batch-mode ssh).

**Model context truncation**: Truncation follows a `num_bytes / 6` token heuristic.

- **Bash (assistant)**: 4,096 lines / 25,000 tokens for stdout and stderr separately.
- **Bash (user/!/@/$)**: 16,384 lines / 100,000 tokens for stdout; 4,096 lines / 25,000 tokens for stderr.
- **web_fetch**: 8,192 lines / 50,000 tokens.
- **web_search**: 4,096 lines / 25,000 tokens.

**Tool UI preview formatting**:

- Output-capable tools emit `ToolUiText` with `previewText`, `statusLine`, and `fullText`.
- Preview truncation/formatting happens in core tools via `src/core/utils/tool_preview.ts`.
- The TUI only styles output: compact uses `previewText` + `statusLine`, expanded uses raw `fullText`.
- Current preview shapes: bash uses head/tail output plus a status line; write shows up to 16 preview lines with a status line; edit uses a truncated diff preview with counts.

**Subagent-only tools**: the `web` subagent uses `web_search`, `web_fetch`, and read-only `bash` (see `src/core/tools/web_search.ts`, `src/core/tools/web_fetch.ts`) via the subagent tool registry in `src/core/subagents/subagent_engine.ts`.

## Personas and subagents

**Built-in**: 6 base persona families (Claude Opus 4.5, Claude Haiku 4.5, GPT-5.2, GPT-5.2 flex, Gemini 3 Pro, Gemini 3 Flash) × 2 variants (chat, coder), plus GPT-5.2 Codex as a single coder persona, for 13 total personas. Both variants include the **web** subagent (max 64 turns, trigger: explicit) for agentic web research, and coder variants also include the **explore** subagent (max 64 turns, trigger: eager) for multi-turn read-only codebase investigation. Built-in personas have `skills: "*"` to enable all discovered skills by default. See trigger sensitivity below for how subagent and skill activation is controlled.

Personas can be defined at user level (`~/.config/tau/personas/*.md`) and project level (`.tau/personas/*.md`). Both use YAML frontmatter with required fields `id`, `provider`, `model` and optional fields. The persona file name (without `.md`) must match the `id`.

- `extends`: inherit from a built-in persona id. only optional fields are inherited; `provider` and `model` are still required on the extending persona. if the markdown body is empty, the base persona's system prompt is used.
- `label`, `description`: metadata
- `reasoning`: default reasoning effort level
- `allowedReasoningLevels`: list of reasoning levels shown in the UI
- `skills`: list of enabled skill names (matched by `name` in skill frontmatter), or `"*"` to enable all discovered skills
- `subagents`: enable sub-agents (`explore` for codebase investigation, `web` for web research). specify as a list `[explore]`, `[web]`, or `[explore, web]` to use the main persona's model, or as an object with custom model/reasoning per sub-agent.
- `tools`: list of tool names to enable for this persona. allowed: `bash`, `write`, `edit`, `task`, `fork`. if omitted, defaults to `bash`, `write`, `edit` (and `task` when subagents are enabled). risk levels still apply.

On conflicts, the most specific level wins (built-ins are the base layer).

## Configuration

- **Global**: `~/.config/tau/config.json` (API keys, `defaultPersona`, `defaultRisk`, `disableBuiltinPersonas`, `disableBuiltinPrompts`, `defaultTheme`, `bashCommands`, `agentContextFiles`, `sandbox`). This level is only included when cwd is inside home.
  - `apiKeys.parallel` (optional): Parallel API key for the `web` subagent.
  - `defaultPersona` (optional): String ID of the persona to use by default when starting the app. Overridden by `--persona` flag.
  - `defaultRisk` (optional): Default risk level (`read-only`, `read-write`). Overridden by `--risk` flag. Defaults to `read-only`.
  - `sandbox` (optional): Docker sandbox settings (see below).
  - `disableBuiltinPersonas` (optional): If true, tau will not load built-in personas, only entries from disk.
  - `disableBuiltinPrompts` (optional): If true, tau will not load built-in prompts, only entries from disk.
  - `defaultTheme` (optional): Theme id to load from `.tau/themes/<id>.json` or `~/.config/tau/themes/<id>.json`.
- **Config levels**: `.tau/config.json` files are discovered from cwd up to home (or filesystem root if cwd is outside home). The global level is included only when cwd is under home. Scalars use most-specific wins; `apiKeys` and `sandbox` merge per field; `bashCommands` merge by `id`; `agentContextFiles` are additive.
- **Project Context**: `AGENTS.md` (searched from current directory up to home/root), plus optional additional `AGENTS.md` files configured via `agentContextFiles` in config (paths resolved relative to the directory containing `.tau/`, or relative to home for the global config when it is in scope). Entries are only included when their directory is an ancestor or descendant of the current working directory; sibling paths are ignored.
- **Bash commands**: `bashCommands` entries in any in-scope config file (`{ "bashCommands": [{ "id", "cmd", "description?" }] }`).

**Sandbox config fields** (used when starting tau with `--sandbox`):
- `sandbox.image` (required with `--sandbox`): Docker image to run.
- `sandbox.mountPath` (optional): Container path for the project root mount. Defaults to `/workspace`.
- `sandbox.pruneAfterHours` (optional): Auto-prune stale sandbox containers after N hours. Defaults to `24`.
- `sandbox.extraDockerArgs` (optional): Additional `docker run` args (string array).
- `sandbox.environmentInfo` (optional): Freeform text injected into the system prompt to describe the sandbox environment.
- **Prompts**: `~/.config/tau/prompts/*.md` and `.tau/prompts/*.md` (discovered by walking up from cwd to home/root; most specific wins on conflicts). Prompt file names (without `.md`) must match their `id`.
- **Themes**: `~/.config/tau/themes/*.json` and `.tau/themes/*.json` (same discovery rules as prompts/config). Theme values accept `#rgb`, `#rrggbb`, `rgb(r, g, b)`, or `hsl(h, s%, l%)`. Missing palette tokens render as plain text when a theme is selected.
- **Skills**: `~/.config/tau/skills/` and `.tau/skills/` (discovered by walking up from cwd to home/root). Each skill is a directory containing `SKILL.md` with required YAML frontmatter:
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
- `--risk <level>`, `-r` - Set initial risk level (`read-only`, `read-write`)
- `--sandbox` - Run all tool calls inside a session-specific Docker container
- `--no-agent-context-files` - Disable AGENTS.md injection into the system prompt

The `--debug` flag respects `--persona` and `--no-agent-context-files`, so you can inspect exactly what system prompt a given configuration produces.

## CLI subcommands

- `tau login openai-codex` - OAuth login for ChatGPT Plus/Pro; stores `~/.config/tau/auth.json`
- `tau logout openai-codex` - Remove stored OAuth credentials

## Commands

- `/help`, `/new`, `/copy`, `/copy:code`, `/export:html`, `/reload`
- `/compact:only-summary`, `/compact:with-last-turn` - Compact history to continue
- `/risk:read-only|read-write`, `/persona:<id>`, `/prompt:<id>`, `/theme:<id>`, `/bash:<id>`
- `!<cmd>` - Direct bash execution (bypasses model; runs inside sandbox when enabled)
- `#<request>` - Memory mode for updating AGENTS.md

**Keybindings**: `Shift+Tab` (cycle reasoning), `Ctrl+R` (cycle risk level), `Ctrl+P` (cycle personality), `Ctrl+T` (toggle thinking), `Ctrl+O` (compact UI), `Ctrl+F` (expand @files and $skills), `Ctrl+S` (stash input to clipboard), `Alt+Up` (pop queued message), `Escape` (interrupt), `Ctrl+C` (exit)

## Development

- `npm run check` - Format (Biome) + typecheck
- `npm run build` - Compile to dist/
- `npm test` - Build + run UI tests

**Do not run the app** (`npm start`, `node dist/main.js`) ever. It launches an interactive TUI that requires a real terminal.

**Style**: Biome (2-space indent, 100 line width). Types `PascalCase`, values/functions `camelCase`, files `lowercase.ts`.

**Commit style**: Short, imperative, lowercase subject lines (no prefixes).

## Adding a slash command

1. `src/core/commands/registry.ts`: Add to `Command` type and register it in `createCommandRegistry()`
2. `src/tui/chat_controller.ts`: Wire the handler in `commandHandlers`
3. `src/tui/ui/slash_autocomplete.ts`: If the command needs argument suggestions, extend the parser

## Security

- Risk levels gate model tools only; `!` commands bypass checks (but still use the sandbox when enabled)
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
