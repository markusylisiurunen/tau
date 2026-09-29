# Tools

Tools let an agent act beyond plain model output, but not every tool comes from the same machine or policy. Tau binds host tools to a session, accepts selected tools from an attached client, and always supplies a small set of intrinsic capabilities. Understanding that ownership explains why a tool can be available in one session and absent in another.

Tool availability is captured when a logical turn starts. Persona changes, configuration reloads, and client attachment changes apply to the next independently started turn rather than changing the tool set halfway through an active turn.

## Tool categories

Tau uses four distinct categories:

| Category | Owner and availability |
| --- | --- |
| Persona-controlled host tools | The host binds implementations that operate against the session execution environment or host services. The active persona's `tools` list selects them. |
| Intrinsic tools | Tau binds these outside persona allowlists. `tau_docs` is available to main agents and subagents. |
| Main-session goal tools | `get_goal`, `create_goal`, and `update_goal` are always available to the main session, independently of the persona. They are not subagent tools. |
| Client-provided tools | An attached client advertises and executes these. TUI-owned `diff_review` and `prefill_input` are examples. Configured command client tools use the same boundary. |

A tool schema tells the model how to call a tool. It does not grant operating-system permissions. Host tools execute with the authority of the execution environment or the configured host service. Client tools execute with the authority of their owning client and may separately request commands in the execution environment. See [ownership and scope](ownership-and-scope.md) and [client tools](client-tools.md).

## Persona tool selection

A custom persona can set an exact list of persona-controlled tools:

```yaml
tools:
  - bash
  - write
  - edit
  - view_image
  - web
```

The supported persona-controlled names are:

```text
bash
write
edit
view_image
web
nook
history
spawn_agent
send_input_to_agent
wait_for_agents
list_agents
interrupt_agent
```

When a custom persona extends another persona and omits `tools`, it inherits the base persona's list. A non-extending custom persona that omits `tools` enables `bash`, `write`, `edit`, `view_image`, `web`, `nook`, and `history`. If that persona has any enabled subagents, Tau also enables the five subagent-management tools. Built-in personas enable the same base and subagent tool sets.

An empty list disables every persona-controlled host tool:

```yaml
tools: []
```

It does not remove intrinsic `tau_docs` or the main-session goal tools. It also does not select client-provided tools, which are advertised independently by an observing client.

The `nook` name has an additional eligibility check: the effective host configuration must contain a Nook target. Without one, Tau does not register the tool even if the persona lists it. Other credentials and service configuration can affect what an enabled tool can do, but not whether its schema is selected. Persona configuration is covered in [personas](personas.md).

## Intrinsic Tau documentation

`tau_docs` reads the exact version-matched documentation shipped with the running Tau package. It is intrinsic, so a persona cannot disable it, and Tau also includes it in every subagent registry.

The tool accepts one exact flat Markdown path. It has no search or list operation. Start with:

```text
index.md
```

Then follow paths linked by that page. The tool description also advertises built-in command-line tools with capability summaries and dedicated documentation paths. Agents may read those pages directly when a tool is relevant, without first loading the index. Use of these utilities is optional and depends on the execution environment's prerequisites. Unknown paths are rejected. The corpus describes supported Tau contracts, not the current effective configuration of a particular session, so use configuration inspection or debug output when the answer depends on local state.

## Main-session goal tools

The main agent always receives:

- `get_goal`, which reads the persisted session goal or returns no goal.
- `create_goal`, which creates an active goal only when the user or an active instruction explicitly requests one.
- `update_goal`, which changes, completes, or blocks the current goal.

These tools are outside persona allowlists because goal lifecycle is a session capability. They are not included in subagent registries or advertised by clients. Goal behavior is described in [sessions](sessions.md).

## Execution-environment tools

### Bash

`bash` runs a command in a fresh non-interactive login Bash in the execution environment. Each call starts a new shell, so shell variables, aliases, functions, `cd`, and other shell state do not carry into the next call. Files and process side effects do persist.

Tau starts Bash with `-lc` and the execution environment's `HOME`. A login shell can read `/etc/profile` and then the first available `~/.bash_profile`, `~/.bash_login`, or `~/.profile`. It reads `BASH_ENV` when set. `.bashrc` is otherwise loaded only when a login file sources it. Startup files must not print output, read stdin, require a terminal, or terminate the shell unexpectedly because Tau does not suppress their effects.

There is no TTY and assistant `bash` calls have no stdin. Commands that prompt, open an interactive editor, or require terminal control will hang until timeout or fail. Use non-interactive flags and pass a `workingDirectory` rather than relying on a previous `cd`.

Tau sets `NO_COLOR=1`, `FORCE_COLOR=0`, `TERM=dumb`, and `PAGER=cat` for predictable non-interactive command output. It also forces Git into non-interactive mode: terminal prompts and askpass interaction are disabled, editors are replaced, pagers are disabled, and SSH uses batch mode. These fixed values override inherited and execution-environment values after login startup. A command can still assign its own environment explicitly. Authentication therefore needs to be available non-interactively.

Agents are instructed to choose the mode that avoids unnecessary waiting. Background mode is appropriate when it enables useful independent progress, for example inspecting code while a test suite runs. If the agent would only wait for completion, a foreground call with an appropriate `timeout` is preferred over launching a background job and immediately waiting for it. Runtime alone does not determine the mode.

Background mode is also appropriate for a service that must remain running or execution that needs to survive turns or interruptions. Launching several independent jobs and then waiting for them is valid concurrency. This is tool guidance, not a runtime restriction on waiting.

The default foreground timeout is 60 seconds. Tau captures at most 1 MiB of merged stdout and stderr, preserving the tail when raw capture overflows. The default model-facing result limit is roughly 8,192 estimated tokens. When output exceeds it, Tau returns a roughly 2,048-token middle preview and a gating notice. The command has already run and its side effects have already happened.

Prefer a narrower command over raising the result limit. When more output is genuinely needed, `maxOutputTokens` can request 8,192 through 16,384 tokens autonomously. Values above 16,384, up to 65,536, are reserved for an explicit user request. Tau may save captured output to a temporary execution-environment file when model-context truncation occurs; the result reports that path when available.

On a local execution backend, Tau removes inherited environment variables whose names end in `_KEY`, `_SECRET`, `_TOKEN`, or `_PASSWORD`, plus `API_KEY`, before running execution-environment commands. Hosted backends begin from their own target environment. Explicit execution-environment overrides still apply. Do not print credentials or broad environment dumps.

Direct TUI commands, `!<command>` and `!!<command>`, use the same fresh login-shell execution boundary. `!` adds the result to model context; `!!` does not. Their user-facing context limit is larger than an ordinary assistant tool result, but raw process capture is still bounded.

With `background: true`, `bash` returns a session-owned job ID after launch rather than waiting for exit. Launch does not establish application readiness. Background jobs have no execution deadline. Combining `background: true` with `timeout` is invalid; execution timeouts are foreground-only. They keep running across turns and interruptions. Main agents, subagents, and ephemeral threads share the session's job registry.

Enabling `bash` also enables `list_bash_jobs`, `read_bash_job`, `stop_bash_job`, and `wait_for_bash_jobs`. These names are not separate persona configuration entries. List returns compact ID/status blocks; read returns the same blocks with a bounded output tail. Stop terminates the managed process group, with forced termination after a grace period. Up to 64 job records are retained, evicting the oldest completed record when needed; starting another job fails if all 64 are still running. Each job retains 64 KiB of merged output, with at most 2,048 estimated tokens returned per job and an 8,192-token shared output budget for multi-job observations. Background output does not use `maxOutputTokens` or save overflow files.

`read_bash_job`, `stop_bash_job`, and `wait_for_bash_jobs` accept `includeOutput`, defaulting to `true`. Setting it to `false` omits captured stdout/stderr and output-truncation notices, but retains job ID, command, cwd, status, exit code when finished, termination reason, and operational errors. List always omits captured output.

Management tool cards use operation-specific Bash-scoped headings such as `reading bash <id>` and `listed bash jobs`, with stable subjects and a seven-line middle-truncated preview of the model-facing result. Background launch uses `started background <command>`; this indicates launch, not readiness or eventual success.

Job-management validation and operational failures include bounded diagnostics in the TUI tool card as well as the model-facing result. Ordinary cancellation leaves the card details empty.

`wait_for_bash_jobs({ids, timeout?, includeOutput?})` returns when any requested job exits or the wait deadline expires. Already-finished jobs return immediately. Its timeout is a positive integer in milliseconds, defaults to 60,000, and cannot exceed 300,000. Expiry is a successful observation and does not stop jobs; interrupting the wait also leaves them running. This waits for exit, not readiness: servers need log or readiness checks instead. Completion does not automatically start an agent turn.

Jobs survive client disconnects while the host remains alive and prevent idle-session eviction until they finish. Orderly session disposal or host shutdown stops them. Job IDs and logs are not persisted or recovered; stale IDs fail clearly. An unknown job ID does not establish that the command never ran, that its side effects were undone, or that it is no longer running. Agents are instructed to check current process and output state before restarting such a command. Cleanup does not cover independently daemonized processes, arbitrary tmux sessions, or processes orphaned by a host crash or forced kill.

### Write and edit

`write` creates or overwrites a UTF-8 file and creates missing parent directories. Relative paths resolve from the execution environment's current working directory. Because it replaces the complete file, it is best for new files or intentional full rewrites.

`edit` performs one exact textual replacement in an existing UTF-8 file. `oldText` must be non-empty and match exactly once, including whitespace and newlines. Zero matches and multiple matches are rejected without changing the file. Read the current section first and make `oldText` more specific when necessary.

Neither tool provides a general read operation. Use a scoped non-interactive Bash command such as `sed`, `cat`, or a language-specific utility to inspect text. Both tools can accept absolute paths, subject to the execution environment's filesystem permissions. They are not confined to the repository root by Tau.

### View image

`view_image` reads an image from the execution environment and returns it to a multimodal model. Tau's built-in instruction limits use to cases where the user explicitly asks to view or analyze an image.

The supported formats are JPEG, PNG, and WebP. Source reads are capped at 50 MiB. Images larger than 2,000 pixels in either dimension or 2.5 MiB of model payload are resized or re-encoded while preserving aspect ratio. If Tau cannot reduce a valid image below the model payload limit, the call fails. Relative paths resolve from the execution-environment working directory.

## Command-line tools

`tau tool` provides standalone utilities that agents can invoke through Bash. They are not separate agent-callable host tools. Files, configuration, credentials, and required executables belong to the machine running the command, including the execution environment when invoked through agent Bash.

| Command | Purpose | Guide |
| --- | --- | --- |
| `tau tool pdf-unpack` | Extract OCR Markdown and page-image patches from a PDF using Mistral. | [PDF unpacking](pdf-unpacking.md) |
| `tau tool image-generate` | Generate or edit an image using Google or OpenAI. | [Image generation](image-generation.md) |
| `tau tool speech-generate` | Generate narration or dialogue using ElevenLabs and assemble a WAV. | [Speech generation](speech-generation.md) |

Each guide covers setup, input, examples, outputs, and failure behavior. Use `tau tool --help` to list commands or `tau tool <command> --help` for command-specific help. The same guides are packaged for `tau_docs` and linked from its `index.md`.

## Code-mode service tools

`web`, `history`, and `nook` each run a one-shot JavaScript program in Tau's restricted code-mode runtime. They intentionally disclose their exact API at use time rather than embedding signatures in this page.

Tau exposes each service tool with agent-facing guidance that requires its documentation to be visible before API use. When the documentation is absent, the first useful call is a documentation-only program:

```js
console.log(docs);
```

After reading that result, the agent uses the documented API in later calls. While the documentation remains visible, it is reused rather than reloaded. The guidance prohibits guessed signatures and signatures copied from another code-mode tool. Program return values are ignored; only console output is returned.

Code-mode programs have no direct process, environment, credential, import, timer, network, or `fetch` access. They can call only the named API and use agent-scoped scratch files exposed by the runtime. Calls default to a 60-second deadline, allow at most 128 API requests with no more than eight unresolved at once, and limit each serialized request or response to 1 MiB. Undefined object properties are omitted from API arguments; undefined arguments and array entries are invalid. Console output is middle-truncated above roughly 8,192 estimated tokens.

Scratch files are real UTF-8 files in an execution-environment temporary directory shared by code-mode tools for the same agent. Writes are limited to 128 regular files and 64 MiB total. Scratch state is not stored in the session snapshot. The progressively disclosed documentation gives the exact file API.

### Web

`web` is for open-web search and webpage extraction when repository data, a purpose-built CLI, a first-party API or SDK, or another structured source cannot answer the task. For GitHub issues, pull requests, releases, and repository metadata, use `gh`; for checked-out source and history, use Git.

Web discovery can inspect an ordinary URL through the execution environment without an Exa credential. Search and content extraction require an effective Exa API key. The tool's documentation explains the discovery-first flow and when to retrieve advertised agent-friendly resources with Bash instead of webpage extraction. See [credentials](credentials.md) for key resolution.

### History

`history` searches and reads durable Tau transcripts. It is read-only and can have visibility across repositories and execution environments, so use it only when the user or another active instruction directly asks to consult prior sessions. Do not invoke it merely because old context might be useful.

The effective history query may be machine-local or backed by a configured remote collection. See [history](history.md) for storage, replication, and access scope.

### Nook

`nook` manages the configured Nook static mini-app platform. It is available only to a main-session persona that lists `nook` and only when Nook is configured. Subagents cannot receive it.

The tool is intended for explicit requests to inspect or manage Nook, publish a static artifact or mini-app, or work with Nook KV. Once the built-in documentation is visible, app-authoring work requires a second separate documentation-only call that prints the Nook authoring skill. The agent reads that guide before creating or modifying app files. Nook setup and platform behavior are covered in [Nook](nook.md).

## Subagent tool eligibility

A subagent can receive only:

```text
bash  write  edit  view_image  web  history
```

A subagent definition may list an exact subset. If it omits `tools`, Tau inherits the intersection of the main persona's tools and those six eligible names. Duplicate names are normalized. `tau_docs` is then added intrinsically regardless of the subset.

Subagents do not receive Nook, goal tools, subagent-management tools, or client-provided tools. Their Bash and file tools are scoped to the subagent working directory, including an alternate directory selected at launch. See [subagents](subagents.md) for configuration and working-directory context rebuilding.

## Client-owned tools

The TUI advertises `diff_review` and `prefill_input` unless client tools are disabled. `diff_review` captures repository state through session execution and runs the review interface on the TUI machine. `prefill_input` places a draft in an empty TUI editor; it does not submit text and refuses to overwrite an existing draft.

Configured command client tools are also client-owned. They can run local client processes and use a bounded execution-environment facade when work belongs on the session machine. Remote attachment makes this distinction visible: the TUI process and its tools may be on a laptop while the host and execution environment are elsewhere. See [client tools](client-tools.md) for configuration, protocol helpers, and limits, and [TUI](tui.md) for diff-tool configuration.

### Sending files to Telegram

Telegram provides four client tools, each accepting `{ path, caption? }` and delivering to the current chat:

| Tool | Delivery | Supported files | Maximum size |
| --- | --- | --- | --- |
| `send_photo_to_telegram` | In-chat photo | JPEG/PNG; width plus height at most 10,000 pixels, aspect ratio at most 20 | 10,000,000 bytes |
| `send_video_to_telegram` | Playable video | MPEG4 | 50,000,000 bytes |
| `send_audio_to_telegram` | Audio player | MP3/M4A | 50,000,000 bytes |
| `send_document_to_telegram` | Original file attachment | Any type, including PDF, CSV, ZIP, WAV, and original-quality images | 50,000,000 bytes |

Paths may be absolute or relative to the session working directory. Captions are plain text, limited to 1,024 UTF-16 code units. Document delivery preserves original bytes and filenames; photo delivery uses Telegram's native photo processing. File bytes do not enter model context or session history.

Transfers read at most 8,000,000 bytes per execution-environment request and reject non-regular, empty, oversized, or changing files. Tools do not inspect codecs, convert files, or fall back to another delivery method. Telegram validates media compatibility, including photo dimensions. Unsupported media can be explicitly converted before sending or delivered as a document instead.

Reading, cancellation, and Telegram delivery failures fail the tool call. Calls allow five minutes and are not automatically retried, since an interrupted upload may already have reached Telegram.

The runner owns upload credentials and binds the recipient to the session's bot and chat; the agent cannot select a recipient. These built-in tools are independent of configured command-tool selection and do not appear in TUI sessions or subagents. Inspecting an image with `view_image` does not send it to Telegram. Automatic voice responses through `/tts_on` are separate from these tools.

## When a tool is missing or fails

First identify which owner should provide it:

- For a host tool, inspect the active persona's `tools`, effective host configuration, and service credentials.
- For a subagent tool, inspect both the subagent's explicit list and the eligible inherited set.
- For a client tool, confirm that an observing client advertises it and that client tools were not disabled.
- For `tau_docs` or main-session goal tools, a missing schema indicates a runtime or version problem rather than a persona setting.

Then check the execution boundary named in the error. A path that exists on the TUI client may not exist in the execution environment. A command available in the host's `PATH` may not be available in the execution environment's login shell. Client process errors belong to the client machine, while `executionEnvironment.exec` errors belong to the session machine.

Use `tau --debug --persona <id>` for the host-tool schemas of a new local TUI session. `/reload` refreshes host configuration and persona content for an idle session, but it does not restart or re-advertise tools owned by an attached client. See [troubleshooting](troubleshooting.md) and [security](security.md) for boundary-specific checks.
