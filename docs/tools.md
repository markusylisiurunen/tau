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

Then follow paths linked by that page. Unknown paths are rejected. The corpus describes supported Tau contracts, not the current effective configuration of a particular session, so use configuration inspection or debug output when the answer depends on local state.

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

The default timeout is 60 seconds. Tau captures at most 1 MiB of merged stdout and stderr, preserving the tail when raw capture overflows. The default model-facing result limit is roughly 8,192 estimated tokens. When output exceeds it, Tau returns a roughly 2,048-token middle preview and a gating notice. The command has already run and its side effects have already happened.

Prefer a narrower command over raising the result limit. When more output is genuinely needed, `maxOutputTokens` can request 8,192 through 16,384 tokens autonomously. Values above 16,384, up to 65,536, are reserved for an explicit user request. Tau may save captured output to a temporary execution-environment file when model-context truncation occurs; the result reports that path when available.

On a local execution backend, Tau removes inherited environment variables whose names end in `_KEY`, `_SECRET`, `_TOKEN`, or `_PASSWORD`, plus `API_KEY`, before running execution-environment commands. Hosted backends begin from their own target environment. Explicit execution-environment overrides still apply. Do not print credentials or broad environment dumps.

Direct TUI commands, `!<command>` and `!!<command>`, use the same fresh login-shell execution boundary. `!` adds the result to model context; `!!` does not. Their user-facing context limit is larger than an ordinary assistant tool result, but raw process capture is still bounded.

### Write and edit

`write` creates or overwrites a UTF-8 file and creates missing parent directories. Relative paths resolve from the execution environment's current working directory. Because it replaces the complete file, it is best for new files or intentional full rewrites.

`edit` performs one exact textual replacement in an existing UTF-8 file. `oldText` must be non-empty and match exactly once, including whitespace and newlines. Zero matches and multiple matches are rejected without changing the file. Read the current section first and make `oldText` more specific when necessary.

Neither tool provides a general read operation. Use a scoped non-interactive Bash command such as `sed`, `cat`, or a language-specific utility to inspect text. Both tools can accept absolute paths, subject to the execution environment's filesystem permissions. They are not confined to the repository root by Tau.

### View image

`view_image` reads an image from the execution environment and returns it to a multimodal model. Tau's built-in instruction limits use to cases where the user explicitly asks to view or analyze an image.

The supported formats are JPEG, PNG, and WebP. Source reads are capped at 50 MiB. Images larger than 2,000 pixels in either dimension or 2.5 MiB of model payload are resized or re-encoded while preserving aspect ratio. If Tau cannot reduce a valid image below the model payload limit, the call fails. Relative paths resolve from the execution-environment working directory.

## Unpack a PDF from the command line

`tau tool pdf-unpack` is a standalone utility for turning a PDF into OCR Markdown and page-image patches. It is not an agent-callable host tool. Run it from the machine that owns the input file:

```bash
tau tool pdf-unpack ./docs/architecture.pdf
```

The path is resolved from the command's current working directory and must name a readable file. The command requires `pdftoppm` from Poppler on `PATH`. On macOS, install it with `brew install poppler`; Debian-based Linux distributions provide it through `apt install poppler-utils`.

PDF OCR requires `MISTRAL_API_KEY` or `apiKeys.mistral`, with the environment variable taking precedence. Tau loads configuration for the command's current working directory. The credential and local executable therefore belong to the process running `tau tool`, not to an attached TUI, remote host, or session execution environment unless that is where the command itself runs. See [credentials](credentials.md) for credential ownership.

On success, Tau prints the persistent temporary output directory and a complete artifact list. The directory contains:

- `document.md`, the complete OCR document with recognized tables inlined;
- `pages/page-0001.md` and later numbered files, one Markdown file per PDF page; and
- `images/page-0001/patch-0001.png` and later numbered patches for visual verification.

OCR text can contain recognition mistakes. Embedded visuals that are not represented in Markdown are marked with placeholders pointing to the corresponding page patches. Read `document.md` for the whole document, use `pages/` for page-level work, and inspect `images/` before trusting or correcting uncertain OCR.

The command uploads the PDF to Mistral and attempts to delete the remote upload after OCR. A deletion failure is reported in the command output. Successful local artifacts remain on disk for follow-up use; delete them when they are no longer needed. If processing fails, Tau attempts to remove the partial local output directory. Do not use the command for a sensitive document unless sending it to Mistral and retaining derived local artifacts are both permitted.

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

## When a tool is missing or fails

First identify which owner should provide it:

- For a host tool, inspect the active persona's `tools`, effective host configuration, and service credentials.
- For a subagent tool, inspect both the subagent's explicit list and the eligible inherited set.
- For a client tool, confirm that an observing client advertises it and that client tools were not disabled.
- For `tau_docs` or main-session goal tools, a missing schema indicates a runtime or version problem rather than a persona setting.

Then check the execution boundary named in the error. A path that exists on the TUI client may not exist in the execution environment. A command available in the host's `PATH` may not be available in the execution environment's login shell. Client process errors belong to the client machine, while `executionEnvironment.exec` errors belong to the session machine.

Use `tau --debug --persona <id>` for the host-tool schemas of a new local TUI session. `/reload` refreshes host configuration and persona content for an idle session, but it does not restart or re-advertise tools owned by an attached client. See [troubleshooting](troubleshooting.md) and [security](security.md) for boundary-specific checks.
