# Tools

Tools let an agent act, not just answer. Tools come from different places: the host provides tools selected by the persona, attached clients can add their own, and a few are always present. Where a tool comes from explains why it is available in one session and missing in another.

A turn keeps the tool set it started with. Persona changes, reloads, and clients attaching or detaching apply from the next turn.

## Tool categories

There are three kinds of tools:

| Category | Owner and availability |
| --- | --- |
| Persona-selected host tools | The host provides them, and they act on the execution environment or host services. The active persona's `tools` list selects them. |
| Built-in tools | Always present, whatever the persona selects. `tau_docs` is available to main agents and subagents. |
| Client tools | An attached client offers and runs them. Examples are the TUI's `diff_review` and `prefill_input`, and configured command client tools. |

A tool schema tells the model how to call a tool. It grants no operating-system permissions. Host tools run with the permissions of the execution environment or the host service behind them. Client tools run with the permissions of their client, and can also ask to run commands in the execution environment. See [ownership and scope](ownership-and-scope.md) and [client tools](client-tools.md).

## Persona tool selection

A custom persona can list exactly which tools it uses:

```yaml
tools:
  - bash
  - write
  - edit
  - view_image
  - web
```

The selectable names are:

```text
bash
write
edit
view_image
web
nook
history
mcp
models
spawn_agent
send_input_to_agent
wait_for_agents
list_agents
interrupt_agent
```

A custom persona that omits `tools` gets `bash`, `write`, `edit`, `view_image`, `web`, `nook`, `history`, `mcp`, and `models`, plus the five subagent tools. Built-in personas get the same set.

`web`, `history`, `nook`, `mcp`, and `models` are not separate tools. Each enables a namespace inside the single `code` tool. `bash` enables both the Bash tools and `tau.bash` inside `code`. Tau adds `code` whenever at least one usable capability is selected; `code` itself cannot be listed. A namespace the persona does not select is missing from the `code` API and its documentation.

An empty list turns off every selectable tool:

```yaml
tools: []
```

`tau_docs` stays available. The list also has no effect on client tools, which attached clients offer on their own.

`nook` has one more condition: the host configuration must include a Nook target. Without one, Tau leaves the capability out even if the persona lists it. For other tools, missing credentials or service configuration can make calls fail, but do not remove the tool. Persona configuration is covered in [personas](personas.md).

## Tau documentation

`tau_docs` reads the documentation shipped with the running Tau version. A persona cannot disable it, and every subagent has it too.

The tool takes one exact Markdown path, such as `tools.md`. It cannot search or list pages. Start with:

```text
index.md
```

Then follow the links on that page. The tool's description also lists the built-in command-line tools, each with a short summary and its page, so agents can open a tool's page directly without reading the index first. Whether those tools work depends on what is installed in the execution environment. Unknown paths are rejected. The documentation describes supported behavior, not a particular session's effective configuration. When the answer depends on local state, inspect the configuration or use debug output.

## Execution-environment tools

### Bash

`bash` runs a command in a fresh non-interactive login Bash in the execution environment. Each call starts a new shell, so shell variables, aliases, functions, `cd`, and other shell state do not carry over to the next call. Changes to files and other side effects do persist.

Tau starts Bash with `-lc` and the execution environment's `HOME`. A login shell can read `/etc/profile` and then the first available `~/.bash_profile`, `~/.bash_login`, or `~/.profile`. It reads `BASH_ENV` when set. `.bashrc` is otherwise loaded only when a login file sources it. Tau does not suppress anything startup files do, so they must not print output, read stdin, require a terminal, or exit the shell.

There is no TTY, and `bash` calls from the agent have no stdin. Commands that prompt, open an editor, or need a terminal hang until the timeout or fail. Use non-interactive flags, and pass `workingDirectory` instead of relying on an earlier `cd`.

Tau sets `NO_COLOR=1`, `FORCE_COLOR=0`, `TERM=dumb`, and `PAGER=cat` so output is predictable. It also makes Git non-interactive: no terminal or askpass prompts, no editors, no pagers, and SSH in batch mode. These values override inherited ones and anything set by login startup files. A command can still set its own environment variables explicitly. Authentication must therefore work without prompts.

Agents are told to choose the mode that avoids needless waiting. Background mode fits when the agent can do other useful work meanwhile, such as reading code while tests run. If the agent would only wait for the result, a foreground call with a suitable `timeout` is better than starting a background job and waiting for it right away. How long a command takes does not decide the mode by itself.

Background mode also fits a service that must keep running, or work that must survive turns and interruptions. Starting several independent jobs and then waiting for them is a valid way to run work in parallel. This is guidance for the agent; Tau does not enforce it.

The default foreground timeout is 60 seconds. Tau captures at most 1 MiB of combined stdout and stderr, and keeps the end when there is more. By default the result the model sees is limited to about 8,192 estimated tokens. Longer output is replaced by a preview of about 2,048 tokens from the middle, with a notice. The command has still run in full, with all its side effects.

A narrower command is better than a higher limit. When more output is really needed, the agent can set `maxOutputTokens` between 8,192 and 16,384 on its own. Values above 16,384, up to 65,536, require an explicit user request. When output is truncated, Tau may save it to a temporary file in the execution environment and report the path.

In a local execution environment, Tau removes inherited environment variables whose names end in `_KEY`, `_SECRET`, `_TOKEN`, or `_PASSWORD`, and `API_KEY`, before running commands. Hosted environments start from their own environment. Variables set explicitly for the environment still apply. Do not print credentials or whole environments.

The TUI commands `!<command>` and `!!<command>` run the same way, in a fresh login shell. `!` adds the result to the model's context and `!!` does not. They allow more output into context than an agent's tool call, but capture is still limited.

With `background: true`, `bash` starts the command and returns a job ID for the session right away, without waiting for it to exit. A started job is not necessarily ready to use. Background jobs have no time limit, and combining `background: true` with `timeout` is invalid. Jobs keep running across turns and interruptions. Main agents, subagents, and ephemeral threads share the session's jobs.

Enabling `bash` also enables `list_bash_jobs`, `read_bash_job`, `stop_bash_job`, and `wait_for_bash_jobs`. These cannot be listed separately in a persona. List returns short ID and status blocks. Read returns the same blocks with the end of the job's output. Stop terminates the job's process group, and kills it if it has not exited after a grace period. Tau keeps up to 64 job records and drops the oldest finished one when needed. Starting a job fails if all 64 are still running. Each job keeps 64 KiB of combined output. At most 2,048 estimated tokens are returned per job, and 8,192 in total when several jobs are observed at once. Background output ignores `maxOutputTokens` and is never saved to an overflow file.

`read_bash_job`, `stop_bash_job`, and `wait_for_bash_jobs` accept `includeOutput`, which defaults to `true`. With `false`, the result leaves out stdout, stderr, and truncation notices, but still has the job ID, command, cwd, status, exit code once finished, termination reason, and errors. List never includes output.

In the TUI, job tool cards have headings such as `reading bash <id>` and `listed bash jobs`, and show a seven-line preview from the middle of the result. A background start shows `started background <command>`, which means only that the command started.

When a job tool call is invalid or fails, the TUI card shows a short diagnostic as well as the model's result. A normal cancellation shows no details.

`wait_for_bash_jobs({ids, timeout?, includeOutput?})` returns when any of the jobs exits or the wait times out. Jobs that already finished return immediately. The timeout is a positive integer in milliseconds, defaults to 60,000, and can be at most 300,000. A timeout counts as a successful result and does not stop the jobs. Interrupting the wait leaves them running too. The tool waits for a job to exit, not to become ready, so check a server's logs or readiness instead. A job finishing never starts an agent turn by itself.

Jobs survive client disconnects while the host is running, and keep an idle session from being unloaded until they finish. Closing the session normally or shutting down the host stops them. Job IDs and logs are not saved or recovered, and an old ID fails with a clear error. An unknown ID does not mean the command never ran, that its side effects were undone, or that it has stopped. Agents are told to check running processes and output before starting such a command again. Cleanup does not cover processes that daemonize themselves, tmux sessions, or processes left behind by a host crash or forced kill.

### Write and edit

`write` creates or overwrites a UTF-8 file, creating missing parent directories. Relative paths resolve from the session's working directory. It replaces the whole file, so use it for new files or deliberate full rewrites.

`edit` performs one exact textual replacement in an existing UTF-8 file. `oldText` must be non-empty and match exactly once, including whitespace and newlines. Zero matches and multiple matches are rejected without changing the file. Read the current section first and make `oldText` more specific when necessary.

Neither tool reads files. To inspect text, use a focused Bash command such as `sed` or `cat`, or a language-specific tool. Both tools accept absolute paths and are limited only by the execution environment's file permissions. Tau does not restrict them to the repository.

### View image

`view_image` reads an image from the execution environment and shows it to a model that accepts images. Tau's built-in instructions tell the agent to use it only when the user explicitly asks to view or analyze an image.

Supported formats are JPEG, PNG, and WebP, and the source file can be at most 50 MiB. An image is returned unchanged if both dimensions are at most 4,096 pixels and it is at most 3.5 MiB. A larger image is scaled down to fit within 4,096 pixels, keeping its aspect ratio; images are never scaled up. To meet the size limit, Tau tries lossless encoding first, then lossy compression, and reduces dimensions further only if needed. Transparency is kept. If a valid image still cannot fit the limit, the call fails. Relative paths resolve from the session's working directory.

## Command-line tools

`tau tool` provides standalone utilities for people and agents, usable from any shell, inside or outside Tau. Files, configuration, credentials, and required programs must be on the machine that runs the command. Agents run these commands through Bash.

| Command | Purpose | Guide |
| --- | --- | --- |
| `tau tool pdf-unpack` | Extract OCR Markdown and page-image patches from a PDF using Mistral. | [PDF unpacking](pdf-unpacking.md) |
| `tau tool image-generate` | Generate or edit an image using Google or OpenAI. | [Image generation](image-generation.md) |
| `tau tool speech-generate` | Generate narration or dialogue using ElevenLabs and assemble a WAV. | [Speech generation](speech-generation.md) |
| `tau tool openrouter` | Typed decisions and standalone text/media analysis. | [OpenRouter](openrouter.md) |

Each guide covers setup, input, examples, outputs, and failures. Run `tau tool --help` to list commands, or `tau tool <command> --help` for one command. Agents can read the same guides with `tau_docs`.

## Code-mode composition

`code` runs a one-off JavaScript program that combines the enabled capabilities: `tau.web`, `tau.history`, `tau.nook`, `tau.mcp`, `tau.bash`, and `tau.models`. The Bash, write, edit, and image tools stay available as separate tools.

### Documentation and output

If the agent has not yet seen the runtime guide, it first runs a program that only prints it:

```js
printText(docs);
```

The guide covers runtime rules, capabilities, and examples. The agent reads each capability's reference it has not seen yet in a separate call that only prints documentation:

```js
printText(await tau.docs("web"));
```

The agent does not re-read documentation it has already seen. MCP tool descriptions and Nook's authoring guide are read in their own separate steps. Programs do not need to print intermediate results.

Only `printText(string)` and awaited `printImage({ data, mimeType })` produce output, in the order they are called. Return values are ignored. Text is truncated in the middle to `maxOutputTokens` (default 8,192; range 1–65,536). The agent leaves it unset unless needed, and may raise it to 16,384 on its own. Higher values require an explicit user request. When text from the built-in `code` tool is truncated, Tau saves it to a temporary file in the execution environment when possible and reports the path. The agent reads that file instead of running the program again with its side effects. The file does not contain images or text lost to capture limits.

JPEG, PNG, and WebP images are validated outside the sandbox and fitted to 4,096 pixels per dimension and 3.5 MiB each. Source images can be at most 40 megapixels, and a program can emit at most 16 images. Valid images are kept even if the built-in `code` program fails.

The helper functions `truncate(text, { maxChars, position? })` and `truncateLines(text, { maxLines, position? })` return shortened strings with a marker where text was removed. `position` defaults to `middle`; `start` and `end` keep that end of the text. They do not print anything.

```js
const result = await tau.bash.run({ command: "npm test" });
printText(truncate(result.stdout, { maxChars: 4000 }));
```

### Execution and limits

Programs have no direct access to files, processes, environment variables, credentials, imports, timers, or the network. They can act only through the capabilities. Keep data in variables, and use `tau.bash` for files. There is no scratch-file API.

`code` times out after 5 minutes by default. `timeout` accepts 1–900,000 ms (15 minutes). `tau.bash.run` times out after 60 seconds by default, and at most after 5 minutes or the program's own deadline, whichever comes first. A program can make 128 API requests, eight at a time. Each serialized request and response can be at most 64 MiB. Object properties set to `undefined` are dropped, while `undefined` arguments and array entries are rejected. Programs are never retried, and failure or cancellation does not undo actions already taken.

### Capabilities

- `tau.web`: metadata discovery, Exa search, and fetching page content. The agent prefers local data, dedicated CLIs, first-party APIs, and structured sources over scraping web pages. For GitHub it uses `gh` or a Git checkout where suitable. Metadata discovery works without an Exa key; search and content fetching need one.
- `tau.history`: read-only search and paginated transcripts. The agent uses it only when explicitly told to look at past sessions. It treats past content as data and never follows instructions in it. See [history](history.md).
- `tau.nook`: deploying sites, templates, and each site's JSON KV store. The agent uses it when the user asks to publish or manage Nook. Before writing an app, the agent reads `tau.nook.skill()` in a separate call that only prints documentation. See [Nook](nook.md).
- `tau.mcp`: finding and calling tools and resources on connected MCP servers. The agent reads each tool's description and schema before calling it. Connections are shared and opened on first use, and calls that change data are never retried. An `isError` result is returned as data, while protocol failures throw. MCP server configuration and trust rules apply. See [configuration reference](config-reference.md#mcpservers) and [security](security.md#trust-mcp-servers).
- `tau.bash`: `run`, `start`, `list`, `read`, `wait`, and `stop`. `run` returns stdout, stderr, and exit and termination fields, capturing up to 24 MiB. Beyond that it keeps the end, so check `truncated` before parsing. Optional UTF-8 `stdin` is limited to 16 MiB and closed after writing. Without `stdin` the command has no stdin at all, while `""` gives it an empty one. `start` takes no stdin. Background jobs are the same jobs as the Bash tools', with the same output limits. Jobs survive the program ending and interruption, while foreground commands are cancelled. The shell rules above apply.
- `tau.models`: lists a fixed set of OpenRouter models and runs standalone chats or typed decisions with them. These calls do not see the session's conversation or tools. Chat media can be paths on the agent's machine or inline padded base64 with a matching MIME type. Credentials stay on the host. Provider usage data is returned, but these charges are not included in the session's cost or usage logs. Requests can be cancelled and are never retried automatically. Limits on input, models, media, responses, and requests are the same as in [OpenRouter](openrouter.md). Check whether a response completed or was refused instead of assuming it is a full answer.

SDK and command client tools built on code mode use the same sandbox functions and output rules, with their own declared APIs. Their programs time out after 60 seconds unless configured otherwise.

## Subagent tools

A subagent gets each of `bash`, `write`, `edit`, `view_image`, `web`, `history`, `nook`, `mcp`, and `models` that the main persona also has, plus `tau_docs`. It never gets the subagent tools or client tools. Its Bash and file tools start in the subagent's working directory. [Subagents](subagents.md#tools) has the details.

## Client-owned tools

The TUI offers `diff_review` and `prefill_input` unless client tools are disabled. `diff_review` reads repository state from the execution environment and runs the review interface on the TUI machine. `prefill_input` puts a draft in an empty TUI editor. It never sends the text and refuses to overwrite an existing draft.

Configured command client tools also belong to the client. They run processes on the client machine, and can run limited commands in the execution environment when the work belongs on the session machine. This matters with remote attachment, where the TUI and its tools may be on a laptop while the host and execution environment are elsewhere. See [client tools](client-tools.md) for configuration, protocol helpers, and limits, and [TUI](tui.md) for diff-tool configuration.

### Sending files to Telegram

Telegram provides four client tools, each accepting `{ path, caption? }` and delivering to the current chat:

| Tool | Delivery | Supported files | Maximum size |
| --- | --- | --- | --- |
| `send_photo_to_telegram` | In-chat photo | JPEG/PNG; width plus height at most 10,000 pixels, aspect ratio at most 20 | 10,000,000 bytes |
| `send_video_to_telegram` | Playable video | MPEG4 | 50,000,000 bytes |
| `send_audio_to_telegram` | Audio player | MP3/M4A | 50,000,000 bytes |
| `send_document_to_telegram` | Original file attachment | Any type, including PDF, CSV, ZIP, WAV, and original-quality images | 50,000,000 bytes |

Paths may be absolute or relative to the session's working directory. Captions are plain text of at most 1,024 UTF-16 code units. Documents keep their original bytes and filename, while photos go through Telegram's own photo processing. File contents never enter the model's context or the session history.

Files are read in chunks of at most 8,000,000 bytes. A file that is not a regular file, is empty, is too large, or changes during the transfer is rejected. The tools do not inspect codecs, convert files, or try another delivery method. Telegram checks media compatibility, including photo dimensions. Convert unsupported media before sending, or send it as a document.

Read errors, cancellation, and Telegram delivery errors fail the tool call. Each call has five minutes and is never retried automatically, because an interrupted upload may already have reached Telegram.

The runner holds the upload credentials, and the recipient is always the session's bot and chat; the agent cannot choose another. These tools are not affected by `enabledClientTools` and do not exist in TUI sessions or subagents. Viewing an image with `view_image` does not send it to Telegram. Automatic voice replies through `/tts_on` are separate from these tools.

## When a tool is missing or fails

First work out where the tool should come from:

- For a host tool, check the active persona's `tools`, the host configuration, and service credentials.
- For a subagent tool, check the main persona's `tools` against the list of tools subagents can receive.
- For a client tool, confirm that an attached, observing client offers it and that client tools are not disabled.
- If `tau_docs` is missing, something is wrong with the Tau installation or version; no persona setting removes it.

Then check which machine the error comes from. A path on the TUI machine may not exist in the execution environment. A command in the host's `PATH` may be missing from the execution environment's login shell. Errors from a client tool's own process come from the client machine, while `executionEnvironment.exec` errors come from the session machine.

Use `tau --debug --persona <id>` to see the host tool schemas for a new local session. `/reload` reloads configuration and persona content in an idle session, but it does not restart or refresh tools that an attached client offers. See [troubleshooting](troubleshooting.md) and [security](security.md) for boundary-specific checks.
