# tau

a terminal-based AI chat client for working with code. tau gives you access to Claude, GPT, and Gemini models, each equipped with tools to explore, read, write, and edit files in your project, plus optional sub-agents for background tasks.

![tau](https://raw.githubusercontent.com/markusylisiurunen/tau/main/assets/tau.png)

## installation

```sh
npm install -g @markusylisiurunen/tau@latest
```

you'll need an API key from at least one provider. set it via environment variable:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
# or OPENAI_API_KEY, or GEMINI_API_KEY, or PARALLEL_API_KEY, or MISTRAL_API_KEY (for /speak)
```

or store keys in `~/.config/tau/config.json`:

```json
{
  "apiKeys": {
    "anthropic": "sk-ant-...",
    "openai": "sk-...",
    "google": "...",
    "parallel": "...",
    "mistral": "..."
  }
}
```

for provider keys (`anthropic`, `openai`, `google`), tau checks `~/.config/tau/config.json` before environment variables.

`parallel` is only needed for `web_search`/`web_fetch` usage in sub-agents and can be provided through `apiKeys.parallel` or `PARALLEL_API_KEY` (`PARALLEL_API_KEY` takes precedence).

`/speak` uses `apiKeys.mistral` or `MISTRAL_API_KEY` for transcription (`MISTRAL_API_KEY` takes precedence) and requires `ffmpeg` on your system.

### OpenAI Codex subscription (ChatGPT Plus/Pro)

to use the OpenAI Codex subscription provider (`openai-codex`), run:

```sh
tau auth login codex
```

this prints a login URL and starts a local callback server on `127.0.0.1:1455`. complete the
login in your browser and tau will store tokens in `~/.config/tau/auth.json`. if port `1455`
is already in use, or the browser callback fails, tau will prompt you to paste the redirect
URL/code. if you see token refresh errors later, run the login command again to re-authenticate.

to list authenticated accounts and usage:

```sh
tau auth list
```

to remove stored credentials:

```sh
tau auth logout codex --account <email>
```

to force a specific Codex account for this run, set `TAU_CODEX_ACCOUNT` to the
account email or account id (same matching as `auth logout`). when set, tau will
only use that account and will not fail over.

`openai-codex` does **not** use `OPENAI_API_KEY` or `apiKeys.openai`; it relies on the OAuth
tokens in `~/.config/tau/auth.json`.

## usage logging

tau writes JSONL usage logs to `~/.config/tau/logs/usage-YYYY-MM-DD.jsonl` for every assistant
response (main and sub-agent). summarize usage with:

```sh
tau usage --since 2025-01-01 --persona gpt-5.2-coder
```

filters: `--since`, `--persona`, `--provider`, `--model`.

## rpc mode (headless stdio)

tau can run without the TUI via NDJSON RPC over stdin/stdout:

```sh
tau rpc --persona gpt-5.2-coder --risk read-only
```

RPC mode reuses the same startup config/persona/risk/sandbox loading as interactive mode. stdin/stdout are reserved for protocol traffic in this mode (piped stdin is **not** treated as an initial user message). `--caffeinated` is a macOS-only TUI flag and is rejected in RPC mode.

for protocol details and examples, see [docs/rpc.md](docs/rpc.md).

## async daemon (http + telegram)

tau also supports an async daemon for queued/background sessions:

```sh
tau async daemon --config-file <path>
```

client command surface:

```sh
tau async --project <id> <prompt...>
tau async <prompt...>
tau async -- <prompt...>
tau async list
tau async status <id>
tau async logs <id>
tau async send <id> <text...>
tau async cancel <id>
```

project id for `tau async <prompt...>` resolves from `--project <id>` first, then
`async.client.defaultProjectId` from config.

use `tau async -- <prompt...>` when prompt text starts with a reserved command word (for example,
`list`).

for daemon/api/telegram details, see [docs/async.md](docs/async.md).

daemon config also supports `systemMessage`, which prepends a `<system>...</system>` block to each submitted user message.

## sdk usage (node)

tau also ships a Node SDK at `@markusylisiurunen/tau/sdk` that talks to the same rpc subprocess (`tau rpc`) behind the scenes.

```ts
import { createTauSdkClient } from "@markusylisiurunen/tau/sdk";

const client = await createTauSdkClient();
const unsubscribe = client.onEvent((event) => {
  // stream core events
});

try {
  const result = await client.submit("summarize this repo");
  console.log(result.userHistoryEntryId, result.turn.aborted);

  const snapshot = await client.snapshot();
  console.log(snapshot.sessionId, snapshot.historyLength);

  await client.shutdown();
} finally {
  unsubscribe();
  await client.close();
}
```

for full api details (options, methods, events, and errors), see [docs/sdk.md](docs/sdk.md).

## install starter prompts and skills

tau ships starter prompt and skill templates as markdown content in this repository. install them with:

```sh
tau install
```

this writes prompts and skills into `.tau/` under your current working directory. use `--global` to
install into `~/.config/tau/` instead, and `--force` to overwrite existing files/directories.
use `--prompt <id>` or `--skill <name>` to install only one item (for targeted updates).

## security notice

**the risk level system is a UX guardrail, not a hard security boundary.** it helps prevent accidental writes and guides model behavior, but it has significant limitations:

- **model trust**: the bash tool relies on the model honestly declaring whether a command is a read or write. there's no runtime validation that the command actually matches the declared intent. a model could declare `safetyLevel="read"` while running `rm -rf /`.
- **no command analysis**: the system doesn't inspect command content. it trusts the declared safety level without verifying what the command actually does.
- **full system access (by default)**: without sandboxing, the model can access any file on your system that your user account can read or write, not just the current working directory. use `--sandbox` to run tool calls inside a docker container with the project mounted.
- **no tty / non-interactive tools**: tool commands run with stdin ignored and no TTY. anything that prompts for input or opens an editor can hang or fail (for example `sudo`, `ssh` password prompts, `git` credential prompts). tau also forces git into non-interactive mode (no prompt/editor/pager, batch-mode ssh).
- **user bypasses**: the `!` prefix executes shell commands directly and completely bypasses risk level checks. this is intentional for direct use, but means risk levels only constrain the model, not the user. when `--sandbox` is enabled, these commands still run inside the sandbox.

note that there is no confirmation step before tool execution. the model runs commands immediately, and you can only observe the results after the fact.

## getting started

tau requires Node.js 24.x and runs on macOS and Linux (Windows is unsupported).

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

built-in themes are available by default with ids: `crimson`, `ember`, `gold`, `lime`, `grass`, `emerald`, `jade`, `teal`, `cyan`, `azure`, `cobalt`, `violet`, `purple`, `magenta`, `rose`. built-ins auto-adapt to dark/light terminal backgrounds via OSC 11 detection at startup (best effort, dark fallback). set `defaultTheme` to one of these ids, or disable them with `disableBuiltinThemes`.

custom themes loaded from `.tau/themes` or `~/.config/tau/themes` are single-variant and use exactly the tokens you define.

available palette tokens (theme keys):

- core: `brandAccent`, `textMuted`, `textDim`, `linkText`, `thinkingText`, `codeInlineText`, `codeBlockText`
- editor: `editorBorderNone`, `editorBorderMinimal`, `editorBorderLow`, `editorBorderMedium`, `editorBorderHigh`, `editorBorderXhigh`, `editorSubagentBorder`, `editorBorderRecording`
- status: `statusWarn`, `statusError`, `modeMemory`, `modeBash`
- action: `actionRunning`, `actionSuccess`, `actionError`, `actionOutput`
- diff: `diffAdd`, `diffRemove`
- toasts: `toastSuccess`, `toastWarn`, `toastError`
- user: `userSurface`, `userMemorySurface`, `userMemoryText`
- risk: `riskReadOnlyText`, `riskReadWriteText`

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

sub-agents inherit the session risk level unless overridden in persona config. a sub-agent configured with `riskLevel: read-write` can write even when the main session is `read-only`.

start with a specific risk level:

```sh
tau --risk read-write
```

or change it during a session with `/risk:read-only` or `/risk:read-write`.

the default is read-only because it lets the model investigate your code and answer questions without risk of unintended changes. bump it to read-write when you're ready to let the model make edits.

## sandboxing

when started with `--sandbox`, tau runs all tool calls inside a session-scoped docker container. the project root (git root or cwd) is mounted into the container, and the working directory matches your current subdirectory. only `/workspace` is bound to the host; absolute paths outside `/workspace` refer to the container filesystem.

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
    "pruneAfterHours": 72,
    "extraDockerArgs": ["--network=none"],
    "environmentInfo": "tools run inside a container. project mounted at /workspace."
  }
}
```

note: when `--sandbox` is enabled, `!` commands also run inside the container.

## power management (macOS)

start tau with `--caffeinated` to keep macOS awake while an assistant turn is running:

```sh
tau --caffeinated
```

tau uses `caffeinate -i` and only holds the sleep assertion during active assistant turns. it does not keep the display awake, and it does not apply to `tau rpc` mode.

## personas

tau comes with several built-in personas across different models:

- **Claude Opus 4.6** (Anthropic): chat and coder variants
- **GPT-5.2** (OpenAI): chat and coder variants
- **GPT-5.3-Codex** (OpenAI): coder-only variant for ChatGPT Plus/Pro subscriptions (`gpt-5.3-codex-chatgpt`)
- **GPT-5.2-Codex** (OpenAI API): coder-only variant for direct API access (`gpt-5.2-codex-api`)
- **Gemini 3 Pro** and **Gemini 3 Flash** (Google): chat variants only

chat variants are for general-purpose assistance; coder variants are optimized for software engineering. built-in personas include the `default` sub-agent for background tasks unless disabled.

switch personas at startup with `--persona` or mid-session with `/persona:<id>`:

```sh
tau --persona opus-4.6-coder
```

## sub-agents

some personas can run isolated sub-agents via the `spawn_agent`, `send_input_to_agent`, `wait_for_agent`, and `terminate_agent` tools. sub-agents return their output through the subagent-only `emit_output` tool, which is collected by `wait_for_agent`.

the built-in `default` sub-agent is available unless disabled. it inherits the main persona's model, settings, tool access (minus sub-agent management tools), and the session risk level. custom sub-agents can override model, reasoning, tools, and risk level. a sub-agent configured with `riskLevel: read-write` can perform writes even when the main session is `read-only`.

`spawn_agent` also supports an optional launch override string: `model: "<provider>/<model>:<effort>"`. overrides are allowlisted per subagent. custom subagents can define `launchModels` in persona frontmatter, and the built-in `default` sub-agent uses `subagents.defaultLaunchModels` from config.

sub-agent progress appears in a sticky panel. use `alt+down` to cycle active subagents and `ctrl+g` to terminate the selected one. tau caps active subagents at 8.

to use `web_search`/`web_fetch` in a sub-agent, set `apiKeys.parallel` in `~/.config/tau/config.json` (see above) or export `PARALLEL_API_KEY`. tau will only make web calls when you explicitly ask for web research.

## trigger sensitivity

sub-agents and skills define when they should be activated via trigger sensitivity levels:

- **eager**: use proactively whenever the capability would help, even if not explicitly requested. example: a dedicated codebase investigation sub-agent.
- **balanced**: use when the request clearly matches the capability. this is the default if not specified. good for skills that solve specific problems but shouldn't be assumed.
- **explicit**: use only when the user specifically names or requests it. example: a web research sub-agent that should only run when asked.

when you write custom skills, you can specify trigger sensitivity in the skill description. if not specified, the default is balanced. the model respects these levels and won't trigger a skill or sub-agent inappropriately.

## reasoning

some models support extended thinking, where they reason through problems before responding. cycle through reasoning levels with `shift+tab`, or set one at startup:

```sh
tau --persona opus-4.6-chat:high
```

toggle visibility of the model's thinking with `ctrl+t`.

## working with files

reference files in your message with `@<path>` (for example, `@src/tui/app.ts`). autocomplete helps you find the right path. press `ctrl+f` to expand file contents into the conversation, letting the model see the actual code.

reference skills with `@@skill:<name>` (for example, `@@skill:skill-name`). autocomplete will suggest available skills. press `ctrl+f` to expand the skill's `SKILL.md` into the conversation.

to explicitly target a sub-agent, use `@@agent:<name>` (for example, `@@agent:default`).

you can also pipe content directly:

```sh
cat src/tui/app.ts | tau --persona opus-4.6-chat
```

by default, tau injects your AGENTS.md into the system prompt. use `--no-agent-context-files` to disable this behavior. tau searches for AGENTS.md in the current directory and parent directories up to your home folder (or filesystem root if cwd is outside home).

you can also include additional `AGENTS.md` files via config (when that config is in scope for the current working directory):

```json
{ "agentContextFiles": ["packages/pkg1/AGENTS.md"] }
```

paths are resolved relative to the directory containing `.tau/` (or relative to home for the global config when it is in scope). entries are only included when their directory is an ancestor or descendant of the current working directory (sibling paths are ignored).

run `tau --help` to see all available options, or `tau --debug` to inspect loaded personas, prompts, skills, and the full system prompt for debugging configuration issues.

## memory mode

prefix a single-line message with `#` to update AGENTS.md. this is useful for capturing decisions, conventions, and context as you work.

```
# prefer explicit error messages with context about what operation failed
```

tau updates the nearest `AGENTS.md` in your current directory ancestry (or creates one in the current directory if none exists). it integrates the new information into the existing structure. this file is loaded automatically in future sessions unless you pass `--no-agent-context-files`.

## commands

tau supports slash commands for common actions:

| command                     | description                                                                     |
| --------------------------- | ------------------------------------------------------------------------------- |
| `/help`                     | show available commands                                                         |
| `/new`                      | clear the session and start fresh                                               |
| `/rewind`                   | open a picker to rewind context from a selected user message                    |
| `/copy:text`                | copy the last assistant message                                                 |
| `/copy:code`                | copy just the code blocks                                                       |
| `/checkpoint`               | save a checkpoint file for loading later                                        |
| `/reload`                   | reload personas, prompts, skills, themes, bash commands, and AGENTS.md          |
| `/speak`                    | toggle microphone recording and transcribe into the editor                      |
| `/cd`                       | change the working directory                                                    |
| `/compact:summary-only`     | compress history into one synthetic user summary message                        |
| `/compact:summary-and-last` | compress history and include the last assistant message verbatim when present   |
| `/prune:earliest`           | prune bash tool results from oldest to newest and compact edit payloads/results |
| `/prune:largest`            | prune largest bash tool results first and compact edit payloads/results         |
| `/prune:smart`              | prune bash tool results via model selection and compact edit payloads/results   |
| `/persona:<id>`             | switch to a different persona                                                   |
| `/prompt:<id>`              | insert a saved prompt template                                                  |
| `/theme:<id>`               | switch to a loaded theme                                                        |
| `/bash:<id>`                | run a saved shell command                                                       |
| `/risk:read-only`           | allow read-only tool calls                                                      |
| `/risk:read-write`          | allow all tools                                                                 |
| `!<cmd>`                    | run a shell command directly (bypasses risk checks; uses sandbox if enabled)    |
| `!!<cmd>`                   | run a shell command without adding output to the model context                  |

use `tau -l <file>` to resume from a checkpoint created by `/checkpoint`.

the compact commands are manual and useful when conversations get long. they replace prior context with a single synthetic user message, so the model keeps continuity without carrying full history. `/compact:summary-and-last` also includes the last assistant message verbatim when present.

the prune commands drop bash tool results from the active context without summarizing and compact edit call payloads/results. all three accept an optional fraction between `0` and `1` (for example, `/prune:largest 0.4`) and default to `0.25` when omitted. `/prune:smart` also accepts optional guidance text, either after a fraction (for example, `/prune:smart 0.3 keep only repetitive output`) or by itself (for example, `/prune:smart keep build logs`).

`/speak` (or `ctrl+y`) starts microphone recording. while recording, editor typing is disabled, and `ctrl+y` stops recording and starts transcription at the cursor. recording also auto-stops after 5 minutes.

`/rewind` opens a picker over prior user messages in the current context. it truncates history from the selected message onward (including the selected message) and prefills the editor with that message so you can retry from there.

## keyboard shortcuts

| key         | action                                     |
| ----------- | ------------------------------------------ |
| `shift+tab` | cycle reasoning effort                     |
| `ctrl+r`    | cycle risk level                           |
| `ctrl+p`    | cycle personality                          |
| `ctrl+t`    | toggle thinking visibility                 |
| `ctrl+o`    | toggle compact tool display                |
| `ctrl+f`    | expand @<file> and @@skill:<name> mentions |
| `ctrl+s`    | stash input to clipboard                   |
| `ctrl+y`    | toggle voice recording                     |
| `ctrl+g`    | terminate selected sub-agent               |
| `enter x2`  | retry last response on empty input         |
| `esc x2`    | clear current prompt                       |
| `alt+up`    | pop queued message                         |
| `alt+down`  | cycle active sub-agents                    |
| `esc`       | interrupt generation                       |
| `ctrl+c`    | press twice to exit                        |

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
    "parallel": "...",
    "mistral": "..."
  },
  "defaultPersona": "gpt-5.2-chat",
  "defaultRisk": "read-write",
  "disableBuiltinPersonas": false,
  "disableBuiltinThemes": false,
  "defaultTheme": "solarized",
  "subagents": {
    "defaultLaunchModels": [
      "openai/gpt-5.2:high",
      "anthropic/claude-haiku-4-5:low"
    ]
  }
}
```

the `defaultPersona` field specifies which persona to use when starting the app. the `--persona` flag overrides this setting.

the `defaultRisk` field sets the initial risk level (`read-only` or `read-write`). the `--risk` flag overrides this setting. if not specified, defaults to `read-only`.

the `defaultTheme` field sets the theme id to load at startup. if not specified, it defaults to `gold`.

the `subagents.defaultLaunchModels` field configures allowed `spawn_agent` launch overrides for the built-in `default` sub-agent. values must use `<provider>/<model>:<effort>`.

if `disableBuiltinPersonas` is set to `true`, tau will not load built-in personas. if `disableBuiltinThemes` is set to `true`, tau will not load built-in themes. only entries from `~/.config/tau/` and `.tau/` will be available for those categories. you can also set these flags in any `.tau/config.json`; the most specific value wins.

the `sandbox` field configures docker sandboxing. `sandbox.image` is required when you start tau with `--sandbox`. `sandbox.mountPath` defaults to `/workspace`. `sandbox.pruneAfterHours` controls when old containers are auto-pruned (default `72`). `sandbox.extraDockerArgs` lets you pass additional `docker run` flags. `sandbox.environmentInfo` (optional) is injected into the system prompt to describe the container environment to the model.

the `async` field in normal tau config is client-side only:

- `async.client.defaultTarget` + `async.client.targets`: client-side URL/token target definitions for `tau async ...` commands.
- `async.client.defaultProjectId`: default project id used by `tau async <prompt...>` when `--project` is omitted.

example (`~/.config/tau/config.json` or `.tau/config.json`):

```json
{
  "async": {
    "client": {
      "defaultTarget": "local",
      "defaultProjectId": "tau",
      "targets": {
        "local": {
          "url": "http://127.0.0.1:7788",
          "token": "replace-me"
        }
      }
    }
  }
}
```

daemon-side async settings are in a separate config file passed to:

```sh
tau async daemon --config-file <path>
```

see [docs/async.md](docs/async.md) for daemon config schema (`host`, `port`, `authToken`, `telegram`, `projects`, `workspaceRoot`) and GitHub repo requirements (`owner/repo`, cloned via `gh repo clone`).

### project bash commands

define shortcuts for common shell commands in any in-scope config file (`~/.config/tau/config.json` when cwd is under home, or `.tau/config.json` in the cwd ancestry). entries merge by `id` with the most specific level winning:

```json
{
  "bashCommands": [
    {
      "id": "check",
      "description": "lint + typecheck",
      "cmd": "npm run check"
    },
    {
      "id": "test",
      "cmd": "npm test"
    }
  ]
}
```

run them with `/bash:check` or `/bash:test`.

commands run with cwd set to the config level root (directory containing `.tau`, or home for the global config).

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

the persona file name (without the `.md` extension) must match the `id`.

optional frontmatter fields:

- `label`: display name shown in the ui (defaults to the base persona label if `extends` is used)
- `description`: human-readable description used in lists/autocomplete
- `extends`: inherit optional fields from a built-in persona id (for example `gpt-5.2-coder`). `provider` and `model` are still required. if the markdown body is empty, the base persona's system prompt is used.
- `reasoning`: one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`
- `allowedReasoningLevels`: list of reasoning levels shown in the ui
- `skills`: list of enabled skill names (matched by `name` in skill frontmatter), or `"*"` to enable all discovered skills
- `subagents`: optional map of subagent definitions. the built-in `default` sub-agent is implicit unless `default: false` is provided. custom subagents must include `systemPrompt` and may include `description`, `provider`+`model`, `reasoning`, `tools`, `riskLevel`, and `launchModels` (when specifying a model, `provider` and `model` must be provided together). names must be lowercase with dashes (max 64 chars). `launchModels` entries must use `<provider>/<model>:<effort>` and are used to allowlist launch-time `spawn_agent` overrides. example:
  ```yaml
  subagents:
    default: false
    web-research:
      systemPrompt: |
        you are a focused web research sub-agent.
      description: web research using web_search/web_fetch.
      provider: anthropic
      model: claude-haiku-4-5
      reasoning: medium
      tools: [web_search, web_fetch, bash]
      riskLevel: read-only
      launchModels:
        - openai/gpt-5.2:high
        - anthropic/claude-haiku-4-5:medium
  ```
- `tools`: list of tool names to enable for this persona. allowed: `bash`, `write`, `edit`, `view_image`, `spawn_agent`, `send_input_to_agent`, `wait_for_agent`, `terminate_agent`. if omitted, defaults to `bash`, `write`, `edit`, `view_image` (and subagent tools when subagents are enabled). risk levels still apply.

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

tau does not include prompt templates by default. run `tau install` to bootstrap starter templates, or save your own in `~/.config/tau/prompts/` (global, only when cwd is under home) or `.tau/prompts/` (project). `.tau/` directories are discovered by walking up from the current working directory to home (or filesystem root if cwd is outside home):

```markdown
---
id: review
---

review this code for bugs, edge cases, and style issues.
suggest specific improvements with code examples.
```

insert them with `/prompt:review`. if a prompt id conflicts across levels, the most specific level wins.

the prompt file name (without the `.md` extension) must match the `id`.

### skills

skills are optional directories discovered at `~/.config/tau/skills/` (only when cwd is under home) and `.tau/skills/` in the cwd ancestry (up to home, or filesystem root if cwd is outside home). each skill is a directory containing `SKILL.md`. tau follows the [agent skills spec](https://agentskills.io/home).

`SKILL.md` must start with yaml frontmatter:

- `name`: 1-64 chars, `a-z0-9-`, must match the directory name
- `description`: 1-1024 chars

optional fields: `license`, `compatibility` (<=500 chars), `metadata` (string map), `allowed-tools` (validated, currently ignored by tau).

enable skills per persona with the `skills` frontmatter field. you can list specific skill names (matched by `name` in skill frontmatter), or use `"*"` to enable all discovered skills. all built-in personas have `skills: "*"` by default. if a project skill conflicts with a user skill by name, the project skill wins. tau injects an index of enabled skills into the system prompt containing only each skill's `name`, `description`, and absolute file path.

use `/reload` to pick up changes to personas, prompts, skills, themes, bash commands, and AGENTS.md without restarting.

## how it works

tau connects your terminal to large language models, giving them tools to interact with your filesystem. when you ask the model to explore code or make changes, it decides which tools to use and executes them subject to the active risk level.

the model sees your messages, any file contents you've shared, and the results of tool calls. it doesn't have ambient access to your filesystem; it only sees what you show it or what it explicitly requests through tools.

tool calls are displayed in the UI so you can see exactly what the model is doing. use `ctrl+o` to toggle between compact and detailed views.

## tool output truncation

tool output is truncated using a `bytes / 6` token heuristic (shown as `…N tokens truncated…`).

- **bash (assistant)**: 8,192 token limit. if output exceeds this and `maxOutputTokens` is unset, output is middle-truncated to a 2,048-token gated preview. re-run with `maxOutputTokens` set to 8,192-16,384; if the user explicitly requests more, it may be set up to 65,536 (user requests are checked). bash captures the last 1MB of output.
- **bash (user `!`)**: 65,536 token limit.
- **web_search/web_fetch**: large responses are middle-truncated to their token limits (8,192 / 16,384 tokens).

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

alpha prereleases are published under the npm `alpha` tag (not `latest`):

```sh
if node -p "require('./package.json').version.includes('-alpha.')"; then
  npm version prerelease --preid alpha
else
  npm version preminor --preid alpha
fi
gh release create v$(node -p "require('./package.json').version") --generate-notes --prerelease
```
