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
# or OPENAI_API_KEY, or GEMINI_API_KEY, or PARALLEL_API_KEY, or MISTRAL_API_KEY (for /listen, Telegram audio, and tau tool pdf-unpack)
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

for built-in providers and features, use these `apiKeys` entries: `anthropic`, `openai`, `google`, `parallel`, and `mistral`. tau checks the matching `apiKeys.<provider>` entry before environment variables.

`parallel` is only needed for `web_search`/`web_fetch` usage in sub-agents and can be provided through `apiKeys.parallel` or `PARALLEL_API_KEY` (`PARALLEL_API_KEY` takes precedence).

`/listen` and Telegram audio transcription use Mistral by default (`apiKeys.mistral` or `MISTRAL_API_KEY`, with `MISTRAL_API_KEY` taking precedence). set `speechToText.provider` to `gemini` to use Gemini 3.5 Flash instead (`apiKeys.google` or `GEMINI_API_KEY`). `/listen` also requires `ffmpeg` on your system and is currently supported only on macOS.

`tau tool pdf-unpack` uses Mistral OCR (`apiKeys.mistral` or `MISTRAL_API_KEY`) and requires `pdftoppm` from Poppler on your system.

`/speak` uses the Google provider (`apiKeys.google` or `GEMINI_API_KEY`) and is currently supported only on macOS.

### OpenAI Codex subscription (ChatGPT Plus/Pro)

to use the OpenAI Codex subscription provider (`openai-codex`), run:

```sh
tau auth login codex
```

this prints a login URL and starts a local callback server on `127.0.0.1:1455`. complete the login in your browser and tau will store tokens in `~/.config/tau/auth.json`. if port `1455` is already in use, or the browser callback fails, tau will prompt you to paste the redirect URL/code. if you see token refresh errors later, run the login command again to re-authenticate.

to list authenticated accounts and usage:

```sh
tau auth list
```

to remove stored credentials:

```sh
tau auth logout codex --account <email>
```

to force a specific Codex account for this run, set `TAU_CODEX_ACCOUNT` to the account email or account id (same matching as `auth logout`). when set, tau will only use that account and will not fail over.

`openai-codex` does **not** use `OPENAI_API_KEY` or `apiKeys.openai`; it relies on the OAuth tokens in `~/.config/tau/auth.json`.

## usage logging

tau writes JSONL usage logs to `~/.config/tau/logs/usage-YYYY-MM-DD.jsonl` for every assistant response (main and sub-agent). summarize usage with:

```sh
tau usage --since 2025-01-01 --persona gpt-5.5-coder
```

filters: `--since`, `--persona`, `--provider`, `--model`.

## RPC mode (headless stdio)

tau can run without the TUI via NDJSON RPC over stdin/stdout:

```sh
tau rpc --persona gpt-5.5-coder --risk read-only
```

RPC mode reuses the same startup config, persona loading, and risk handling as interactive mode. stdin/stdout are reserved for protocol traffic in this mode (piped stdin is **not** treated as an initial user message). `--caffeinated` is a macOS-only TUI flag and is rejected outside TUI mode.

for protocol details and examples, see [docs/rpc.md](docs/rpc.md).

## protocol TUI attach

tau can host sessions over WebSocket:

```sh
tau serve --host 0.0.0.0 --port 8787 --auth-token "$TAU_WS_AUTH_TOKEN" --risk read-only
```

WebSocket auth tokens authorize full session access. Prefer `wss://` behind a trusted TLS proxy on untrusted networks, avoid putting tokens in URLs or shell history, and treat any proxy/access logs that capture headers, query strings, or WebSocket handshake details as sensitive.

then attach the terminal UI from another machine:

```sh
tau attach --auth-token "$TAU_WS_AUTH_TOKEN" ws://vps:8787
```

Without `--session` or `--new`, attach lists hosted sessions and prompts for the session to open. Use `--session <id>` to attach to an existing persisted session directly:

```sh
tau attach --session 0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3 --auth-token "$TAU_WS_AUTH_TOKEN" ws://vps:8787
```

Use `--new --cwd <path>` to create and attach to a fresh hosted session in an already-provisioned directory on the host:

```sh
tau attach --new --cwd /srv/workspaces/repo --auth-token "$TAU_WS_AUTH_TOKEN" ws://vps:8787
```

For non-local execution environments, add the execution kind and provider ids:

```sh
tau attach --new --execution-kind cloudflare-sandbox --cloudflare-bridge default --cloudflare-sandbox sandbox-1 --cwd /workspace/repo ws://vps:8787
tau attach --new --execution-kind fly-sprite --fly-api default --fly-sprite sprite-1 --cwd /home/sprite/repo ws://vps:8787
```

tau can also run the terminal UI against any command that speaks the same session protocol on stdin/stdout:

```sh
tau attach -- ssh vps 'cd /path/to/repo && tau rpc --risk read-only'
```

For stdio attach, use `--session <id>` before `--`:

```sh
tau attach --session 0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3 -- ssh vps 'cd /path/to/repo && tau rpc --risk read-only'
```

Session attach renders the authoritative session snapshot, streams recoverable `session.delta` updates and independently revisioned, non-persisted `session.pendingUserMessages` replacements, submits normal user input through `session.submit`, `session.queue`, and `session.steer`, supports steering/interruption, runs `!`/`!!` shell commands in the session execution environment, records `/listen` from the local microphone, speaks `/speak` locally, reloads session content with `/reload`, changes the session risk level with `/risk:<level>` or `Ctrl+R`, switches session personas with `/persona:<id>` or `Ctrl+P`, inserts session prompt templates with `/prompt:<id>`, compacts or prunes the session with `/compact:*` and `/prune:*`, creates a new session with `/new`, and exits with `/exit` or `Ctrl+C` twice.

## Telegram runner

tau can run a Telegram bot adapter over local in-process SDK sessions:

```sh
tau telegram --config-file <path>
```

The Telegram command surface is intentionally small:

- `/new` creates a new session for the chat, replacing the previous active session if one exists.
- `/status` returns a short natural-language status paragraph for the active session, including model, reasoning effort, context usage, and cumulative cost when session details are available.
- `/compact` summarizes older conversation context to reduce context usage.
- `/interrupt` interrupts the active run.

The runner keeps tool and lifecycle progress quiet: Telegram receives command acknowledgements/errors and assistant messages, including multiple assistant progress updates from a single active run. While work is active, it shows Telegram's typing indicator in DMs and groups. Assistant messages are sent as Telegram rich markdown.

Telegram DM input supports plain text, voice/audio transcription, and attachment queueing (`image/*`, PDF, `.txt`, `.md`, `.json`, `.csv`, `.yaml`, `.yml`). allowed groups are opt-in via `allowedChatIds`; non-triggering group text/captions, attachments, audio transcripts, and processing errors are buffered as sender-attributed context and the most recent 50 messages since the previous bot-triggering turn are included when a bot mention triggers a turn. group commands accept explicit bot mentions on or around the command, such as `/status@botusername`, `/status @botusername`, or `@botusername /status`.

Telegram config defines `bots`, `projects`, `workspaceRoot`, optional `systemMessage`, and optional `maxSessions`. repositories use persistent bare caches at `<workspaceRoot>-repo-cache/<projectId>.git`; active session records are persisted at `<workspaceRoot>-sessions.json`, their workspaces survive runner restarts, and unreferenced workspace entries are removed on startup. Tau reconnects preserved sessions to their corresponding snapshots. When creating or reconstructing a workspace, `bootstrapCommands` block initial readiness and `backgroundBootstrapCommands` start without blocking; preserved workspaces skip both on restart. for config details, see [docs/telegram.md](docs/telegram.md).

## built-in tool commands

tau also ships a small `tau tool` command family for utility workflows outside the chat UI.

```sh
tau tool pdf-unpack ./docs/spec.pdf
```

`tau tool pdf-unpack` sends the original PDF to Mistral for OCR/Markdown, renders page image patches locally with `pdftoppm`, writes a persistent temp directory with `document.md`, `pages/`, and `images/`, and prints the output paths as plain text for follow-up model use.

## Nook static mini-apps

Nook is Tau's bundled Cloudflare-backed static mini-app platform. It deploys static directories to path-based site URLs and gives each site same-origin JSON KV through an injected `window.nook` browser SDK.

```sh
tau nook setup \
  --domain nook.example.com \
  --zone-name example.com \
  --access-team-domain https://team.cloudflareaccess.com \
  --access-aud <access-application-audience>
tau nook deploy ./dist --site demo
tau nook deploy ./dist --site demo --public
mkdir restored-demo && tau nook copy demo ./restored-demo
tau nook template save starter ./app
tau nook template copy starter ./next-app
tau nook kv put demo settings '{"theme":"dark"}'
```

Add a single configured target to Tau config after deploying the Worker and creating Cloudflare Access service-token credentials:

```json
{
  "nook": {
    "domain": "nook.example.com",
    "accessClientId": "...",
    "accessClientSecretEnv": "NOOK_ACCESS_CLIENT_SECRET"
  }
}
```

Template copies require a destination directory that already exists and is empty. The Worker validates Cloudflare Access JWTs against the Access JWKS with the configured issuer and audience. Tau sends service-token headers to Cloudflare Access for CLI/API calls, but the Worker does not treat those raw headers as authentication. When `nook` is configured, Tau automatically exposes a read-write model tool named `nook`. Detailed setup, deploy, template, Worker, browser SDK, and V0 scope notes live in [src/nook/README.md](src/nook/README.md).

## SDK usage (Node)

tau also ships a Node SDK at `@markusylisiurunen/tau/sdk` that uses the same session protocol. By default it runs against an in-process Tau host; `tau serve` provides the same protocol over WebSocket.

```ts
import { createTauSdkClient } from "@markusylisiurunen/tau/sdk";

const client = await createTauSdkClient();
const session = await client.sessions.create({
  executionEnvironment: {
    kind: "local",
    cwd: process.cwd(),
  },
});
const unsubscribe = session.onDelta((delta) => {
  // stream reconstructable session deltas
});

try {
  const result = await session.submit("summarize this repo");
  console.log(result.userHistoryEntryId, result.turn.aborted);

  const snapshot = await session.snapshot();
  console.log(snapshot.sessionId, snapshot.messages.length);

  await session.unobserve();
} finally {
  unsubscribe();
  await client.close();
}
```

WebSocket clients can connect to a `tau serve` host:

```ts
import { createTauSdkWebSocketClient } from "@markusylisiurunen/tau/sdk";

const client = await createTauSdkWebSocketClient({
  url: "wss://tau.example.com",
  authToken: process.env.TAU_WS_AUTH_TOKEN,
});
```

for full API details (options, methods, events, and errors), see [docs/sdk.md](docs/sdk.md). `client.close()` closes the client transport; for the default in-process client, it also shuts down the owned host after persisting live session snapshots.

## install starter prompts and skills

tau ships starter prompt and skill templates as markdown content in this repository, including guided-review templates for splitting changes into focused review chunks. install them with:

```sh
tau install
```

this writes prompts and skills into `.tau/` under your current working directory. use `--global` to install into `~/.config/tau/` instead, and `--force` to overwrite existing files/directories. use `--prompt <id>` or `--skill <name>` to install only one item (for targeted updates).

## security notice

**the risk level system is a UX guardrail, not a hard security boundary.** it helps prevent accidental writes and guides model behavior, but it has significant limitations:

- **model trust**: the bash tool relies on the model honestly declaring whether a command is a read or write. there's no runtime validation that the command actually matches the declared intent. a model could declare `safetyLevel="read"` while running `rm -rf /`.
- **no command analysis**: the system doesn't inspect command content. it trusts the declared safety level without verifying what the command actually does.
- **full system access**: the model can access any file on your system that your user account can read or write, not just the current working directory. if you need stronger isolation, run Tau inside a VM or container.
- **no tty / non-interactive tools**: tool commands run with stdin ignored and no TTY. anything that prompts for input or opens an editor can hang or fail (for example `sudo`, `ssh` password prompts, `git` credential prompts). tau also forces git into non-interactive mode (no prompt/editor/pager, batch-mode ssh).
- **user bypasses**: the `!` prefix executes shell commands directly and completely bypasses risk level checks. this is intentional for direct use, but means risk levels only constrain the model, not the user.

note that there is no confirmation step before tool execution. the model runs commands immediately, and you can only observe the results after the fact.

## getting started

tau requires Node.js 24.x and runs on macOS and Linux (Windows is unsupported).

for development from source:

```sh
npm install
(cd src/diff_tool/app && npm install)
npm run build
npm start
```

`npm start` launches the interactive TUI and expects a real terminal.

## themes

tau can load custom palette overrides from theme files. create a theme at:

- `.tau/themes/<id>.json` (project)
- `~/.config/tau/themes/<id>.json` (global)

then set `"defaultTheme": "<id>"` in config. any palette token not defined in the file renders as plain text. theme values accept `#rgb`, `#rrggbb`, `rgb(r, g, b)`, or `hsl(h, s%, l%)`. hex without `#` is ignored.

built-in themes are available by default with ids: `crimson`, `ember`, `gold`, `lime`, `grass`, `emerald`, `jade`, `teal`, `cyan`, `azure`, `cobalt`, `violet`, `purple`, `magenta`, `rose`. built-ins auto-adapt to dark/light terminal backgrounds via OSC 11 detection at startup (best effort, dark fallback). set `defaultTheme` to one of these ids, or disable them with `disableBuiltinThemes`.

custom themes loaded from `.tau/themes` or `~/.config/tau/themes` are single-variant and use exactly the tokens you define.

available palette tokens (theme keys):

- core: `brandAccent`, `textMuted`, `textDim`, `linkText`, `thinkingText`, `codeInlineText`, `codeBlockText`
- editor: `editorBorderNone`, `editorBorderMinimal`, `editorBorderLow`, `editorBorderMedium`, `editorBorderHigh`, `editorBorderXhigh`, `editorBorderMax`, `editorSubagentBorder`, `editorBorderRecording`
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

start with a specific risk level (exact values: `read-only` or `read-write`):

```sh
tau --risk read-write
```

or change it during a session with `/risk:read-only` or `/risk:read-write`.

the default is read-only because it lets the model investigate your code and answer questions without risk of unintended changes. bump it to read-write when you're ready to let the model make edits.

## power management (macOS)

start tau with `--caffeinated` to keep macOS awake while an assistant turn is running:

```sh
tau --caffeinated
```

tau uses `caffeinate -i` and only holds the sleep assertion during active assistant turns. it does not keep the display awake, and it does not apply to hosted modes. on Linux, `--caffeinated` is accepted in TUI mode but currently a no-op.

## personas

tau comes with several built-in personas across different models:

- **Claude Opus 4.6** (Anthropic): `opus-4.6-chat`, `opus-4.6-coder`
- **Claude Opus 4.8** (Anthropic): `opus-4.8-chat`, `opus-4.8-coder`
- **GPT-5.5** (OpenAI): `gpt-5.5-chat`, `gpt-5.5-coder`
- **GPT-5.5 Fast (ChatGPT)** and **GPT-5.6 Fast (ChatGPT)** (OpenAI Codex, priority tier): `gpt-5.5-chatgpt-fast-chat`, `gpt-5.5-chatgpt-fast-coder`, `gpt-5.6-sol-chatgpt-fast-chat`, `gpt-5.6-sol-chatgpt-fast-coder`, `gpt-5.6-terra-chatgpt-fast-chat`, `gpt-5.6-terra-chatgpt-fast-coder`
- **GPT-5.5 (ChatGPT)** (OpenAI Codex): `gpt-5.5-chatgpt-chat`, `gpt-5.5-chatgpt-coder`
- **GPT-5.6 Sol** and **GPT-5.6 Terra** (OpenAI): `gpt-5.6-sol-chat`, `gpt-5.6-sol-coder`, `gpt-5.6-terra-chat`, `gpt-5.6-terra-coder`
- **GPT-5.6 Sol (ChatGPT)** and **GPT-5.6 Terra (ChatGPT)** (OpenAI Codex): `gpt-5.6-sol-chatgpt-chat`, `gpt-5.6-sol-chatgpt-coder`, `gpt-5.6-terra-chatgpt-chat`, `gpt-5.6-terra-chatgpt-coder`
- **Gemini 3.1 Pro** and **Gemini 3 Flash** (Google): `gemini-3.1-pro-chat`, `gemini-3-flash-chat`

chat variants are for general-purpose assistance; coder variants are optimized for software engineering. built-in personas include the `default` sub-agent for background tasks unless disabled.

switch personas at startup with `--persona` or mid-session with `/persona:<id>`:

persona id matching is exact/case-sensitive.

```sh
tau --persona opus-4.8-coder
```

## sub-agents

some personas can run isolated sub-agents via the `spawn_agent`, `send_input_to_agent`, `wait_for_agents`, and `terminate_agent` tools. sub-agents report progress in the subagent panel, and `wait_for_agents` returns completed outputs as soon as at least one requested agent finishes.

the built-in `default` sub-agent is available unless disabled. it inherits the main persona's model, settings, tool access (minus sub-agent management tools), risk level, and system prompt. the inherited main prompt is wrapped with default sub-agent-specific rules, and those wrapper rules take precedence on conflicts. custom sub-agents can override model, reasoning, tools, and risk level. a sub-agent configured with `riskLevel: read-write` can perform writes even when the main session is `read-only`.

`spawn_agent` supports an optional launch override string (`model: "<provider>/<model>:<effort>"`) and an optional `workingDirectory`. when `workingDirectory` is set, the sub-agent runs from that directory and its prompt context (cwd, AGENTS.md scope, and skills block) is rebuilt as if tau was started there. launch overrides are allowlisted per subagent. custom subagents can define `launchModels` in persona frontmatter, and the built-in `default` sub-agent uses `subagents.defaultLaunchModels` from config.

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
tau --persona opus-4.8-chat:high
```

reasoning changes made while the assistant is working apply to the next user-message turn. the active turn keeps the reasoning level it captured when that user message started, including any tool-call subturns.

toggle visibility of the model's thinking with `ctrl+t`.

## working with files

reference files in your message with `@<path>` (for example, `@src/tui/session_chat_app.ts`). autocomplete helps you find the right path.

reference skills with `@@skill:<name>` (for example, `@@skill:skill-name`). autocomplete will suggest available skills.

to explicitly target a sub-agent, use `@@agent:<name>` (for example, `@@agent:default`).

you can also pipe content directly:

```sh
cat src/tui/session_chat_app.ts | tau --persona opus-4.8-chat
```

by default, tau injects your AGENTS.md into the system prompt. use `--no-agent-context-files` to disable this behavior. tau searches for AGENTS.md in the current directory and parent directories up to your home folder (or filesystem root if cwd is outside home). tau also includes a paths-only listing of `AGENTS.md` files in child directories under the current working directory, excluding any file already injected in full.

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

| command | description |
| --- | --- |
| `/help` | show available commands |
| `/new` | clear the session and start fresh |
| `/exit` | exit the TUI |
| `/rewind` | open a picker to rewind context from a selected user message |
| `/copy:text` | copy the last assistant message |
| `/copy:code` | copy just the code blocks |
| `/reload` | reload personas, model overrides, prompts, skills, and AGENTS.md |
| `/listen` | start microphone recording and transcribe into the editor (macOS only) |
| `/speak` | speak the last assistant message aloud (macOS only) |
| `/diff [git diff args...]` | open the local diff review tool for the current session; git snapshot and review-agent work run on the session host |
| `/compact:summary-only` | compress history into one synthetic user summary message |
| `/compact:summary-and-last` | compress history and include the last assistant message verbatim when present |
| `/prune:earliest` | prune bash tool results from oldest to newest and compact edit payloads/results |
| `/prune:largest` | prune largest bash tool results first and compact edit payloads/results |
| `/prune:smart` | prune bash tool results via model selection and compact edit payloads/results |
| `/persona:<id>` | switch to a different persona |
| `/prompt:<id>` | insert a saved prompt template |
| `/theme:<id>` | switch to a loaded theme |
| `/risk:read-only` | allow read-only tool calls |
| `/risk:read-write` | allow all tools |
| `!<cmd>` | run a shell command directly (bypasses risk checks) |
| `!!<cmd>` | run a shell command without adding output to the model context |

tau automatically compacts long sessions when provider-reported usage approaches the model context limit. automatic compaction summarizes older context, asks the compaction model to select original user messages to append verbatim inside the summary by history id, retains a recent tail verbatim, and inserts a hidden continuation note so the assistant continues without asking you to repeat context.

the compact commands are manual and useful when you want to force context replacement. they replace prior context with a single synthetic user summary message, including compaction-model-selected original user messages verbatim inside that summary, and do not retain a recent tail. `/compact:summary-and-last` also includes the last assistant message verbatim when present.

the prune commands drop bash tool results from the active context without summarizing and compact edit call payloads/results. all three accept an optional fraction between `0` and `1` (for example, `/prune:largest 0.4`) and default to `0.25` when omitted. `/prune:smart` also accepts optional guidance text, either after a fraction (for example, `/prune:smart 0.3 keep only repetitive output`) or by itself (for example, `/prune:smart keep build logs`).

`/listen` (or `ctrl+y`) starts microphone recording on macOS, including while the assistant is working. while recording, editor typing is disabled, and `ctrl+y` stops recording and starts transcription at the cursor using the configured speech-to-text provider. `esc` stops recording first without interrupting the assistant; press it again to interrupt active work. recording also auto-stops after 5 minutes. on Linux, `/listen` is currently unavailable and tau shows a warning.

`/speak` rewrites the last assistant message into naturally speakable text with Gemini 3.5 Flash, synthesizes audio with Gemini 3.1 Flash TTS, and starts playing on macOS at 1.4x speed as soon as the first speech chunk is ready.

`/rewind` opens a picker over prior user messages in the current context. it truncates history from the selected message onward (including the selected message) and prefills the editor with that message so you can retry from there.

`/diff` starts a TUI-local diff review. The diff tool process runs where the TUI runs, connects back to the TUI over the diff-review protocol, and the TUI captures git snapshots through session execution while driving generic ephemeral review agents over the session protocol. Returned review text is recorded into the session as a review-styled user message without auto-running the assistant. The TUI also advertises `diff_review` as a client-provided model tool, so the assistant can launch the same local diff-review flow when a capable TUI client is attached.

## keyboard shortcuts

| key          | action                                    |
| ------------ | ----------------------------------------- |
| `shift+tab`  | cycle reasoning effort                    |
| `ctrl+r`     | cycle risk level                          |
| `ctrl+p`     | cycle personality                         |
| `ctrl+t`     | toggle thinking visibility                |
| `ctrl+o`     | toggle compact tool display               |
| `ctrl+s`     | stash input to clipboard                  |
| `ctrl+y`     | toggle voice recording (`/listen`)        |
| `ctrl+g`     | terminate selected sub-agent              |
| `ctrl+enter` | steer running assistant with editor input |
| `enter x2`   | retry last response on empty input        |
| `esc x2`     | clear current prompt                      |
| `alt+up`     | cancel pending messages into editor       |
| `alt+down`   | cycle active sub-agents                   |
| `esc`        | interrupt active task                     |
| `ctrl+c`     | press twice to exit                       |

## configuration

### global config

tau loads config from `~/.config/tau/config.json` only when the current working directory is inside your home directory. it also loads any `.tau/config.json` found by walking up from the current working directory to home (or to the filesystem root when cwd is outside home). settings merge from least-specific to most-specific.

model definitions can be extended and overridden through `~/.config/tau/models.json` and `.tau/models.json` with the same discovery and precedence rules as `config.json`. see [docs/models.md](docs/models.md).

```json
{
  "apiKeys": {
    "anthropic": "sk-ant-...",
    "openai": "sk-...",
    "google": "...",
    "parallel": "...",
    "mistral": "..."
  },
  "defaultPersona": "gpt-5.5-chat",
  "defaultRisk": "read-write",
  "disableBuiltinPersonas": false,
  "disableBuiltinThemes": false,
  "defaultTheme": "solarized",
  "diffTool": {
    "command": "./scripts/my-diff-tool",
    "args": ["--browser"],
    "env": { "TAU_DIFF_UI": "browser" }
  },
  "subagents": {
    "defaultLaunchModels": [
      "openai/gpt-5.5:high",
      "anthropic/claude-haiku-4-5:low"
    ]
  },
  "autoCompact": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "speechToText": {
    "provider": "mistral"
  },
  "cloudflareSandbox": {
    "bridges": {
      "default": {
        "url": "https://tau-sandbox-bridge.example.workers.dev",
        "apiKeyEnv": "TAU_CLOUDFLARE_SANDBOX_API_KEY"
      }
    }
  },
  "flySprites": {
    "apis": {
      "default": {
        "baseURL": "https://api.sprites.dev",
        "tokenEnv": "SPRITES_TOKEN"
      }
    }
  },
  "nook": {
    "domain": "nook.example.com",
    "accessClientId": "...",
    "accessClientSecretEnv": "NOOK_ACCESS_CLIENT_SECRET"
  },
  "modelSystemNotices": {
    "openai-codex/gpt-5.5": "avoid apply_patch heredocs, use tau tools directly"
  }
}
```

for built-in providers and features, the `apiKeys` field uses these keys: `anthropic`, `openai`, `google`, `parallel`, and `mistral`. keys are merged across config levels by key name.

the `defaultPersona` field specifies which persona to use when starting the app. it accepts `<id>` or `<id>:<reasoning>`, and matching is exact/case-sensitive. the `--persona` flag overrides this setting.

the `defaultRisk` field sets the initial risk level (`read-only` or `read-write`). the `--risk` flag overrides this setting. if not specified, defaults to `read-only`.

the `defaultTheme` field sets the theme id to load at startup. it must be non-empty, and matching is exact/case-sensitive. if not specified, it defaults to `gold`.

`speechToText.provider` selects the `/listen` and Telegram audio transcription provider. supported values are `mistral` (default, uses Voxtral) and `gemini` (uses Gemini 3.5 Flash with minimal thinking).

`cloudflareSandbox.bridges` configures host-owned Cloudflare Sandbox bridge targets for hosted sessions. session requests refer to a bridge by id and a pre-existing sandbox id; Tau does not create sandboxes, clone repos, install dependencies, inject secrets, or run readiness checks during `session.create`. paths such as `cwd` are real paths inside the sandbox execution environment. Tau resolves session config/content from that execution environment cwd when creating the session and on `/reload`; bridge credentials stay on the host through either `apiKey` or `apiKeyEnv` and are not stored in session snapshots.

`flySprites.apis` configures host-owned Fly Sprites API targets for hosted sessions. session requests refer to an API by id and a pre-existing Sprite name; Tau does not create Sprites, clone repos, install dependencies, inject secrets, or run readiness checks during `session.create`. paths such as `cwd` are real paths inside the Sprite. Tau resolves session config/content from that execution environment cwd when creating the session and on `/reload`; API tokens stay on the host through either `token` or `tokenEnv` and are not stored in session snapshots.

`nook` configures one effective Nook target. `domain` is required. `accessClientId`, `accessClientSecret`, and `accessClientSecretEnv` are optional Cloudflare Access service-token fields; when the env var resolves, it wins over the inline secret. `tau nook setup` takes infrastructure route and Access validation inputs through `--zone-name`, `--access-team-domain`, and `--access-aud` or the `NOOK_ZONE_NAME`, `NOOK_ACCESS_TEAM_DOMAIN`, and `NOOK_ACCESS_AUD` env vars. `tau nook destroy` is an infrastructure flow that takes service-token cleanup credentials through flags or `NOOK_ACCESS_CLIENT_ID` and `NOOK_ACCESS_CLIENT_SECRET`.

tau ships a built-in browser diff review tool as `tau diff-tool`. `/diff` launches the configured diff tool locally from the TUI process. `diffTool` overrides the built-in fallback; `command` is required when `diffTool` is present, `args` and `env` are optional, and relative `command` paths resolve from the config level root (directory containing `.tau`, or home for the global config). set `builtInDiffTool.codeTheme` to choose the built-in diff tool's initial code theme, for example `{ "builtInDiffTool": { "codeTheme": "github-dark-dimmed" } }`. the default is `github-dark-dimmed`.

supported built-in diff tool code themes are: `andromeeda`, `aurora-x`, `ayu-dark`, `ayu-mirage`, `catppuccin-frappe`, `catppuccin-macchiato`, `catppuccin-mocha`, `dark-plus`, `dracula`, `dracula-soft`, `everforest-dark`, `github-dark`, `github-dark-default`, `github-dark-dimmed`, `github-dark-high-contrast`, `gruvbox-dark-hard`, `gruvbox-dark-medium`, `gruvbox-dark-soft`, `horizon`, `horizon-bright`, `houston`, `kanagawa-dragon`, `kanagawa-wave`, `laserwave`, `material-theme`, `material-theme-darker`, `material-theme-ocean`, `material-theme-palenight`, `min-dark`, `monokai`, `night-owl`, `nord`, `one-dark-pro`, `plastic`, `poimandres`, `red`, `rose-pine`, `rose-pine-moon`, `slack-dark`, `solarized-dark`, `synthwave-84`, `tokyo-night`, `vesper`, `vitesse-black`, `vitesse-dark`.

the `subagents.defaultLaunchModels` field configures allowed `spawn_agent` launch overrides for the built-in `default` sub-agent. values must use `<provider>/<model>:<effort>`.

`autoCompact` controls automatic session compaction and merges field-by-field across config levels. it is enabled by default with `reserveTokens: 16384` and `keepRecentTokens: 20000`. tau triggers it only after provider-reported assistant usage crosses the model context window minus the reserve, then summarizes older context, asks the compaction model to select original user messages to append verbatim inside the summary by history id, and retains recent messages verbatim (capped at that threshold). manual `/compact:*` commands remain summary-replacement commands.

the `modelSystemNotices` field maps `<provider>/<model>` to a notice string. provider ids must be known and model ids are exact/case-sensitive against the merged configured model catalog (built-in + layered `models.json`). when a message is sent to that model, tau prepends the notice as a `<system>...</system>` block before the user content. this applies to main-session user messages and sub-agent prompts, regardless of persona id.

session snapshots store raw recoverable user message text. tau-internal metadata is persisted in that text but stripped before model calls and user display. leading exact `<system>...</system>\n` blocks in user messages are hidden from user-facing renderers but remain model-facing instructions.

if `disableBuiltinPersonas` is set to `true`, tau will not load built-in personas. if `disableBuiltinThemes` is set to `true`, tau will not load built-in themes. only entries from `~/.config/tau/` and `.tau/` will be available for those categories. you can also set these flags in any `.tau/config.json`; the most specific value wins.

Telegram runner settings are in a separate config file passed to:

```sh
tau telegram --config-file <path>
```

see [docs/telegram.md](docs/telegram.md) for the config schema (`bots`, `projects`, `workspaceRoot`, optional `systemMessage`, optional `maxSessions`) and GitHub repo requirements (`owner/repo`, cached via `gh repo clone -- --bare`).

### diff review tool

tau ships `tau diff-tool`, a built-in browser diff review tool and reference implementation of the diff-review tool protocol. Configure `builtInDiffTool.codeTheme` to choose the built-in tool's initial code theme; the default is `github-dark-dimmed`.

if you want a different launcher, configure `diffTool` in any in-scope config file. when present, it overrides the built-in fallback:

```json
{
  "diffTool": {
    "command": "./scripts/my-diff-tool",
    "args": ["--browser"],
    "env": { "TAU_DIFF_UI": "browser" }
  }
}
```

`tau diff-tool --help` shows the built-in demo tool's standalone help text. Custom diff tools should follow the built-in tool and treat the explicit `session.close` shutdown request as the canonical way to stop.

### additional agents context

you can tell tau to always include extra `AGENTS.md` files by adding an `agentContextFiles` list to a config file in scope:

```json
{ "agentContextFiles": ["packages/pkg1/AGENTS.md"] }
```

paths are resolved relative to the directory containing `.tau/` (or relative to home for the global config when it is in scope). entries must point at `AGENTS.md`. entries are only included when their directory is an ancestor or descendant of the current working directory (sibling paths are ignored). child `AGENTS.md` files that are not injected in full are still listed by path in the project context.

### custom personas

create your own personas by adding markdown files to `~/.config/tau/personas/` (global, only when cwd is under home) or `.tau/personas/` (project). `.tau/` directories are discovered by walking up from the current working directory to home (or filesystem root if cwd is outside home):

```markdown
---
id: my-assistant
provider: anthropic
model: claude-opus-4-8
---

you are a helpful assistant specialized in my workflow. focus on clarity and efficiency.
```

the frontmatter defines the persona. required fields:

- `id`: unique id used by `--persona` and `/persona:<id>`
- `provider`: model provider id (for example `openai`, `anthropic`, `google`)
- `model`: model id for the provider (for example `gpt-5.4`, `claude-opus-4-8`)

custom personas/subagents can reference model ids that are not bundled yet, as long as the provider is known. built-in personas use the merged model catalog, so `models.json` can override bundled model definitions. see [docs/models.md](docs/models.md).

the persona file name (without the `.md` extension) must match the `id`.

optional frontmatter fields:

- `label`: display name shown in the ui (defaults to the base persona label if `extends` is used)
- `description`: human-readable description used in lists/autocomplete
- `extends`: inherit optional fields from a built-in persona id (for example `gpt-5.5-coder`). `provider` and `model` are still required. if the markdown body is empty, the base persona's system prompt is used.
- `reasoning`: one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`
- `serviceTier`: `priority` or `flex` for providers that support service tiers (currently `openai` and `openai-codex`)
- `allowedReasoningLevels`: list of reasoning levels shown in the ui
- `skills`: list of enabled skill names (matched by `name` in skill frontmatter), or `"*"` to enable all discovered skills. if omitted, custom personas default to `"*"`. set `skills: []` to disable skills completely.
- `tools`: optional list of persona-selected host tools. Nook is not selected here; when effective config contains `nook`, Tau exposes the `nook` tool automatically and gates every operation on read-write risk.
- `subagents`: optional map of subagent definitions. the built-in `default` sub-agent is implicit unless `default: false` is provided. custom subagents must include `systemPrompt` and may include `description`, `provider`+`model`, `reasoning`, `serviceTier`, `tools`, `riskLevel`, and `launchModels` (when specifying a model, `provider` and `model` must be provided together). names must be lowercase with dashes (max 64 chars). `launchModels` entries must use `<provider>/<model>:<effort>` and are used to allowlist launch-time `spawn_agent` overrides. example:
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
        - openai/gpt-5.5:high
        - anthropic/claude-haiku-4-5:medium
  ```
- `tools`: list of tool names to enable for this persona. allowed: `bash`, `write`, `edit`, `view_image`, `spawn_agent`, `send_input_to_agent`, `wait_for_agents`, `terminate_agent`. if omitted, defaults to `bash`, `write`, `edit`, `view_image` (and subagent tools when subagents are enabled). risk levels still apply.

the markdown body becomes the system prompt.

use it with `--persona my-assistant` or `/persona:my-assistant`. if a project persona id conflicts with a user or built-in persona, the project persona wins.

to clone a built-in persona but swap the provider/model, use `extends`:

```markdown
---
id: my-haiku-coder
extends: gpt-5.5-coder
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

review this code for bugs, edge cases, and style issues. suggest specific improvements with code examples.
```

insert them with `/prompt:review`. if a prompt id conflicts across levels, the most specific level wins.

the prompt file name (without the `.md` extension) must match the `id`.

### skills

skills are optional directories discovered at `~/.config/tau/skills/` and `~/.agents/skills/` (global, only when cwd is under home), plus `.tau/skills/` and `.agents/skills/` in the cwd ancestry (up to home, or filesystem root if cwd is outside home). each skill is a directory containing `SKILL.md`. tau follows the [agent skills spec](https://agentskills.io/home). when `.tau/skills/` and `.agents/skills/` both exist at the same level, `.agents/skills/` wins on name conflicts.

`SKILL.md` must start with yaml frontmatter:

- `name`: 1-64 chars, `a-z0-9-`, must match the directory name
- `description`: 1-1024 chars

optional fields: `license`, `compatibility` (<=500 chars), `metadata` (string map), `allowed-tools` (validated, currently ignored by tau).

enable skills per persona with the `skills` frontmatter field. you can list specific skill names (matched by `name` in skill frontmatter), use `"*"` to enable all discovered skills, or set `skills: []` to disable skills completely. built-in personas and custom personas with omitted `skills` default to `skills: "*"`. if a project skill conflicts with a user skill by name, the project skill wins. tau injects an index of enabled skills into the system prompt containing only each skill's `name`, `description`, and file path.

use `/reload` to pick up changes to personas, model overrides, prompts, skills, and AGENTS.md without restarting.

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

publishing to npm happens automatically via GitHub Actions when a GitHub release is published.

release steps:

- install dependencies for the root package and the built-in diff tool app:

```sh
npm ci
(cd src/diff_tool/app && npm ci)
```

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

- create a GitHub release (this triggers the publish workflow):

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
