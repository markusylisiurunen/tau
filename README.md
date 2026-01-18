# tau

a terminal-based AI chat client for working with code. tau gives you access to Claude, GPT, and Gemini models, each equipped with tools to explore, write, and edit files in your project, plus optional sub-agents for deeper codebase investigation and web research.

![tau](./assets/tau.png)

## installation

```sh
npm install -g @markusylisiurunen/tau@latest
```

you'll need an API key from at least one provider. set it via environment variable:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
# or OPENAI_API_KEY, or GEMINI_API_KEY
```

or store keys in `~/.config/tau/config.json`:

```json
{
  "apiKeys": {
    "anthropic": "sk-ant-...",
    "openai": "sk-...",
    "google": "...",
    "parallel": "..."
  }
}
```

environment variables take precedence over the config file.

`parallel` is only needed for the web sub-agent tools (`web_search`/`web_fetch`).

### OpenAI Codex subscription (ChatGPT Plus/Pro)

to use the OpenAI Codex subscription provider (`openai-codex`), run:

```sh
tau login openai-codex
```

this prints a login URL and starts a local callback server on `127.0.0.1:1455`. complete the
login in your browser and tau will store tokens in `~/.config/tau/auth.json`. if port `1455`
is already in use, or the browser callback fails, tau will prompt you to paste the redirect
URL/code. if you see token refresh errors later, run the login command again to re-authenticate.

to remove stored credentials:

```sh
tau logout openai-codex
```

`openai-codex` does **not** use `OPENAI_API_KEY` or `apiKeys.openai`; it relies on the OAuth
tokens in `~/.config/tau/auth.json`.

## security notice

**the risk level system is a UX guardrail, not a hard security boundary.** it helps prevent accidental writes and guides model behavior, but it has significant limitations:

- **model trust**: the bash tool relies on the model honestly declaring whether a command is a read or write. there's no runtime validation that the command actually matches the declared intent. a model could declare `safetyLevel="read"` while running `rm -rf /`.
- **no command analysis**: the system doesn't inspect command content. it trusts the declared safety level without verifying what the command actually does.
- **full system access (by default)**: without sandboxing, the model can access any file on your system that your user account can read or write, not just the current working directory. use `--sandbox` to run tool calls inside a docker container with the project mounted.
- **no tty / non-interactive tools**: tool commands run with stdin ignored and no TTY. anything that prompts for input or opens an editor can hang or fail (for example `sudo`, `ssh` password prompts, `git` credential prompts). tau also forces git into non-interactive mode (no prompt/editor/pager, batch-mode ssh).
- **user bypasses**: the `!` prefix executes shell commands directly and completely bypasses risk level checks. this is intentional for direct use, but means risk levels only constrain the model, not the user. when `--sandbox` is enabled, these commands still run inside the sandbox.

note that there is no confirmation step before tool execution. the model runs commands immediately, and you can only observe the results after the fact.

## getting started

tau requires Node.js 20+ and runs on macOS.

for development from source:

```sh
npm install
npm run build
npm start
```

`npm start` launches the interactive TUI and expects a real terminal.

## themes

tau can load custom palette overrides from theme files. create a theme at:

- `.tau/themes/<id>.json` (project)
- `~/.config/tau/themes/<id>.json` (global)

then set `"defaultTheme": "<id>"` in config. any palette token not defined in the file renders as plain text.
theme values accept `#rgb`, `#rrggbb`, `rgb(r, g, b)`, or `hsl(h, s%, l%)`. hex without `#` is ignored.

example theme file (`.tau/themes/solarized.json`):

```json
{
  "brandAccent": "#b58900",
  "textMuted": "#586e75",
  "textDim": "#657b83"
}
```

and in config (`.tau/config.json` or `~/.config/tau/config.json`):

```json
{ "defaultTheme": "solarized" }
```

## risk levels

tau uses risk levels to control what the model can do. this lets you stay in control while working alongside AI.

- **read-only** (default): model can run read-only tools (no file modifications)
- **read-write**: model can create, edit, and delete files

start with a specific risk level:

```sh
tau --risk read-write
```

or change it during a session with `/risk:read-only` or `/risk:read-write`.

the default is read-only because it lets the model investigate your code and answer questions without risk of unintended changes. bump it to read-write when you're ready to let the model make edits.

## sandboxing

when started with `--sandbox`, tau runs all tool calls inside a session-scoped docker container. the project root (git root or cwd) is mounted into the container, and the working directory matches your current subdirectory.

requirements:
- docker must be available on the host
- config must include `sandbox.image`
- sandboxing is only enabled at startup with `--sandbox` (no runtime toggle)

example config:

```json
{
  "sandbox": {
    "image": "ghcr.io/your-org/tau-sandbox:latest",
    "mountPath": "/workspace",
    "pruneAfterHours": 24,
    "extraDockerArgs": ["--network=none"],
    "environmentInfo": "tools run inside a container. project mounted at /workspace."
  }
}
```

note: when `--sandbox` is enabled, `!` commands also run inside the container.

## personas

tau comes with several built-in personas across different models:

- **Claude Opus 4.5** and **Haiku 4.5** (Anthropic)
- **GPT-5.2** (OpenAI)
- **GPT-5.2 Codex** (OpenAI Codex subscription)
- **Gemini 3 Pro** and **Gemini 3 Flash** (Google)

each model has two variants: a chat variant for general-purpose assistance, and a coder variant optimized for software engineering. GPT-5.2 Codex is a single coder persona. both variants include the `web` sub-agent for web research, and coder variants also include the `explore` sub-agent for multi-turn codebase investigation.

switch personas at startup with `--persona` or mid-session with `/persona:<id>`:

```sh
tau --persona opus-4.5-coder
```

## sub-agents

some personas can run isolated sub-agents via the internal `task` tool.

tau also supports an internal `fork` tool, which runs an autonomous fork of the current session using the full conversation history and returns the fork's final answer.

- `explore`: read-only, multi-turn codebase investigation
- `web`: high-threshold web research using Parallel Search/Extract (`web_search`/`web_fetch`) plus read-only bash for curl/filtering

to use the web sub-agent, set `apiKeys.parallel` in `~/.config/tau/config.json` (see above). tau will only make web calls when you explicitly ask for web research.

## trigger sensitivity

sub-agents and skills define when they should be activated via trigger sensitivity levels:

- **eager**: use proactively whenever the capability would help, even if not explicitly requested. example: `explore` is eager because multi-step codebase investigation is often valuable.
- **balanced**: use when the request clearly matches the capability. this is the default if not specified. good for skills that solve specific problems but shouldn't be assumed.
- **explicit**: use only when the user specifically names or requests it. example: `web` is explicit because web research should happen only when the user asks for current information.

when you write custom skills, you can specify trigger sensitivity in the skill description. if not specified, the default is balanced. the model respects these levels and won't trigger a skill or sub-agent inappropriately.

## reasoning

some models support extended thinking, where they reason through problems before responding. cycle through reasoning levels with `shift+tab`, or set one at startup:

```sh
tau --persona opus-4.5-chat:high
```

toggle visibility of the model's thinking with `ctrl+t`.

## working with files

reference files in your message by typing `@` followed by the filename. autocomplete helps you find the right path. press `ctrl+f` to expand file contents into the conversation, letting the model see the actual code.

reference skills by typing `$` followed by the skill name (for example, `$skill-name`). autocomplete will suggest available skills. press `ctrl+f` to expand the skill's `SKILL.md` into the conversation.

you can also pipe content directly:

```sh
cat src/tui/app.ts | tau --persona opus-4.5-chat
```

by default, tau injects your AGENTS.md into the system prompt. use `--no-agent-context-files` to disable this behavior. tau searches for AGENTS.md in the current directory and parent directories up to your home folder (or filesystem root if cwd is outside home).

you can also include additional `AGENTS.md` files via config (when that config is in scope for the current working directory):

```json
{ "agentContextFiles": ["packages/pkg1/AGENTS.md"] }
```

paths are resolved relative to the directory containing `.tau/` (or relative to home for the global config when it is in scope). entries are only included when their directory is an ancestor or descendant of the current working directory (sibling paths are ignored).

run `tau --help` to see all available options, or `tau --debug` to inspect loaded personas, prompts, skills, and the full system prompt for debugging configuration issues.

## memory mode

prefix a message with `#` to update your project's AGENTS.md file. this is useful for capturing decisions, conventions, and context as you work.

```
# prefer explicit error messages with context about what operation failed
```

tau will create or update AGENTS.md at your project root, integrating the new information into the existing structure. over time, this builds a knowledge base about your project. this file is loaded automatically in future sessions unless you pass `--no-agent-context-files`.

## commands

tau supports slash commands for common actions:

| command                   | description                                    |
| ------------------------- | ---------------------------------------------- |
| `/help`                   | show available commands                        |
| `/new`                    | clear the session and start fresh              |
| `/copy`                   | copy the last assistant message                |
| `/copy:code`              | copy just the code blocks                      |
| `/export:html`            | export chat history to html                    |
| `/reload`                 | reload personas, prompts, skills, and themes from disk |
| `/compact:only-summary`   | compress history and continue with a summary   |
| `/compact:with-last-turn` | compress history but keep the last exchange    |
| `/persona:<id>`           | switch to a different persona                  |
| `/prompt:<id>`            | insert a saved prompt template                 |
| `/theme:<id>`             | switch to a loaded theme                       |
| `/bash:<id>`              | run a saved shell command                      |
| `/risk:<level>`           | change the risk level                          |
| `!<cmd>`                  | run a shell command directly (bypasses risk checks; uses sandbox if enabled) |

the compact commands are useful when conversations get long. they compress everything into a summary so the model retains context without the overhead of a full history.

## keyboard shortcuts

| key         | action                      |
| ----------- | --------------------------- |
| `shift+tab` | cycle reasoning effort      |
| `ctrl+r`    | cycle risk level            |
| `ctrl+p`    | cycle personality           |
| `ctrl+t`    | toggle thinking visibility  |
| `ctrl+o`    | toggle compact tool display |
| `ctrl+f`    | expand @file and $skill mentions |
| `ctrl+s`    | stash input to clipboard    |
| `alt+up`    | pop queued message          |
| `esc`       | interrupt generation        |
| `ctrl+c`    | exit                        |

## configuration

### global config

tau loads config from `~/.config/tau/config.json` only when the current working directory is
inside your home directory. it also loads any `.tau/config.json` found by walking up from the
current working directory to home (or to the filesystem root when cwd is outside home).
settings merge from least-specific to most-specific.

```json
{
  "apiKeys": {
    "anthropic": "sk-ant-...",
    "openai": "sk-...",
    "google": "...",
    "parallel": "..."
  },
  "defaultPersona": "gpt-5.2-chat",
  "defaultRisk": "read-write",
  "disableBuiltinPersonas": false,
  "disableBuiltinPrompts": false,
  "defaultTheme": "solarized"
}
```

the `defaultPersona` field specifies which persona to use when starting the app. the `--persona` flag overrides this setting.

the `defaultRisk` field sets the initial risk level (`read-only` or `read-write`). the `--risk` flag overrides this setting. if not specified, defaults to `read-only`.

if `disableBuiltinPersonas` is set to `true`, tau will not load built-in personas. if `disableBuiltinPrompts` is set to `true`, tau will not load built-in prompts. only entries from `~/.config/tau/` and `.tau/` will be available for those categories. you can also set these flags in any `.tau/config.json`; the most specific value wins.

the `sandbox` field configures docker sandboxing. `sandbox.image` is required when you start tau with `--sandbox`. `sandbox.mountPath` defaults to `/workspace`. `sandbox.pruneAfterHours` controls when old containers are auto-pruned (default `24`). `sandbox.extraDockerArgs` lets you pass additional `docker run` flags. `sandbox.environmentInfo` (optional) is injected into the system prompt to describe the container environment to the model.

### project bash commands

define shortcuts for common shell commands in any in-scope config file (`~/.config/tau/config.json` when cwd is under home, or `.tau/config.json` in the cwd ancestry). entries merge by `id` with the most specific level winning:

```json
{
  "bashCommands": [
    { "id": "check", "description": "lint + typecheck", "cmd": "npm run check" },
    { "id": "test", "cmd": "npm test" }
  ]
}
```

run them with `/bash:check` or `/bash:test`.

### additional agents context

you can tell tau to always include extra `AGENTS.md` files by adding an `agentContextFiles` list to a config file in scope:

```json
{ "agentContextFiles": ["packages/pkg1/AGENTS.md"] }
```

paths are resolved relative to the directory containing `.tau/` (or relative to home for the global config when it is in scope). entries must point at `AGENTS.md`.
entries are only included when their directory is an ancestor or descendant of the current working directory (sibling paths are ignored).

### custom personas

create your own personas by adding markdown files to `~/.config/tau/personas/` (global, only when cwd is under home) or `.tau/personas/` (project). `.tau/` directories are discovered by walking up from the current working directory to home (or filesystem root if cwd is outside home):

```markdown
---
id: my-assistant
provider: anthropic
model: claude-opus-4-5
---

you are a helpful assistant specialized in my workflow.
focus on clarity and efficiency.
```

the frontmatter defines the persona. required fields:

- `id`: unique id used by `--persona` and `/persona:<id>`
- `provider`: model provider id (for example `openai`, `anthropic`, `google`)
- `model`: model id for the provider (for example `gpt-5.2`, `claude-opus-4-5`)

optional frontmatter fields:

- `label`: display name shown in the ui (defaults to the base persona label if `extends` is used)
- `description`: human-readable description used in lists/autocomplete
- `extends`: inherit optional fields from a built-in persona id (for example `gpt-5.2-coder`). `provider` and `model` are still required. if the markdown body is empty, the base persona's system prompt is used.
- `reasoning`: one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`
- `allowedReasoningLevels`: list of reasoning levels shown in the ui
- `skills`: list of enabled skill names (matched by `name` in skill frontmatter), or `"*"` to enable all discovered skills
- `subagents`: enable sub-agents (`explore` for multi-turn codebase investigation, `web` for web research). you can specify as a list (`subagents: [explore]`, `subagents: [web]`, or `subagents: [explore, web]`) to use the main persona's model, or as an object to customize each sub-agent's model and reasoning. when specifying a model for a subagent, `provider` and `model` must be provided together. example:
  ```yaml
  subagents:
    explore:
      provider: anthropic
      model: claude-haiku-4-5
      reasoning: medium
  ```
- `tools`: list of tool names to enable for this persona. allowed: `bash`, `write`, `edit`, `task`, `fork`. if omitted, defaults to `bash`, `write`, `edit` (and `task` when subagents are enabled). risk levels still apply.

the markdown body becomes the system prompt.

use it with `--persona my-assistant` or `/persona:my-assistant`. if a project persona id conflicts with a user or built-in persona, the project persona wins.

to clone a built-in persona but swap the provider/model, use `extends`:

```markdown
---
id: my-haiku-coder
extends: gpt-5.2-coder
provider: anthropic
model: claude-haiku-4-5
---

```

when persona ids collide across levels, the most specific level wins (for example, a `.tau/personas/` entry overrides a global or built-in persona).

### custom prompts

save reusable prompt templates in `~/.config/tau/prompts/` (global, only when cwd is under home) or `.tau/prompts/` (project). `.tau/` directories are discovered by walking up from the current working directory to home (or filesystem root if cwd is outside home):

```markdown
---
id: review
---

review this code for bugs, edge cases, and style issues.
suggest specific improvements with code examples.
```

insert them with `/prompt:review`. if a prompt id conflicts across levels (including built-ins), the most specific level wins.

### skills

skills are optional directories discovered at `~/.config/tau/skills/` (only when cwd is under home) and `.tau/skills/` in the cwd ancestry (up to home, or filesystem root if cwd is outside home). each skill is a directory containing `SKILL.md`. tau follows the [agent skills spec](https://agentskills.io/home).

`SKILL.md` must start with yaml frontmatter:

- `name`: 1-64 chars, `a-z0-9-`, must match the directory name
- `description`: 1-1024 chars

optional fields: `license`, `compatibility` (<=500 chars), `metadata` (string map), `allowed-tools` (validated, currently ignored by tau).

enable skills per persona with the `skills` frontmatter field. you can list specific skill names (matched by `name` in skill frontmatter), or use `"*"` to enable all discovered skills. all built-in personas have `skills: "*"` by default. if a project skill conflicts with a user skill by name, the project skill wins. tau injects an index of enabled skills into the system prompt containing only each skill's `name`, `description`, and absolute file path.

use `/reload` to pick up changes to personas, prompts, skills, and themes without restarting.

## how it works

tau connects your terminal to large language models, giving them tools to interact with your filesystem. when you ask the model to explore code or make changes, it decides which tools to use and executes them with your permission (based on risk level).

the model sees your messages, any file contents you've shared, and the results of tool calls. it doesn't have ambient access to your filesystem; it only sees what you show it or what it explicitly requests through tools.

tool calls are displayed in the UI so you can see exactly what the model is doing. use `ctrl+o` to toggle between compact and detailed views.

## creating a release

publishing to npm happens automatically via github actions when a github release is published.

release steps:

- run checks and build:

```sh
npm run check
npm run build
npm test
```

- bump the version (creates a git tag):

```sh
npm version patch
```

- push the commit and tag:

```sh
git push --follow-tags
```

- create a github release (this triggers the publish workflow):

```sh
gh release create v$(node -p "require('./package.json').version") --generate-notes
```
