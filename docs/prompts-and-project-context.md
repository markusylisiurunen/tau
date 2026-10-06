# Prompts and project context

Tau has three ways to add instructions or reusable text to a session, and each enters at a different point:

- Prompt templates fill the editor when you ask for them.
- `AGENTS.md` files give standing project instructions.
- Hidden system blocks at the start of a user message add instructions for that one message.

None of these choose models or tools. [Personas](personas.md) set the base system prompt, model settings, and tools. Model-specific system notices are configured separately in the [configuration reference](config-reference.md).

## Prompt templates fill the editor

A prompt template is saved Markdown that Tau inserts into the TUI editor, where you can review and send it. It is never added to the system prompt and never runs by itself.

Tau discovers prompt files from:

| Scope   | Location                        |
| ------- | ------------------------------- |
| Global  | `~/.config/tau/prompts/<id>.md` |
| Project | `<level>/.tau/prompts/<id>.md`  |

The global location applies only when the session's working directory is inside the execution environment's home directory. Tau searches project levels from the working directory up to home, or up to the filesystem root when outside home. The nearest project definition wins over parent and global ones. Prompt IDs are compared case-insensitively, both for precedence and for lookup.

A prompt's ID is its filename without `.md`. Each file needs YAML frontmatter with a non-empty `label`. For example, `release-summary.md`:

```markdown
---
label: release summary
---

Summarize the changes since the previous release. Separate user-visible changes from internal maintenance, and call out any migration steps.
```

The `label` appears in TUI autocomplete and in the Telegram prompt picker. Unknown frontmatter fields are ignored. The Markdown body is the text inserted into the editor.

Only files ending in lowercase `.md` are found. Tau skips a file with a warning if its YAML is invalid, its frontmatter is not an object, or its label is missing or invalid.

### Invoke a prompt

In the TUI, invoke a prompt by ID:

```text
/prompt:release-summary
```

Tau replaces the editor text with the template body. It does not send the text, so you can edit it first. Lookup is case-insensitive.

The session stores only each prompt's ID and label. Tau reads the body from the execution environment each time `/prompt:<id>` runs. As a result:

- An edit to the body of a known prompt takes effect on its next use, without `/reload`.
- After adding, removing, or renaming a prompt, or changing its label, run `/reload` before autocomplete shows the change.

If the file is missing or invalid when Tau reads it, the command fails. Tau never falls back to an older copy of the body. An attached client always gets the prompt from the session's execution environment, never from a file with the same name on the client machine.

### Telegram prompt picker

In [Telegram](telegram.md), `/prompt` lists the active session's saved prompts, split into pages when there are many. Selecting one reads its current body and adds it to the session as a user message, without starting a turn. You can select a prompt only while the session is idle. Otherwise, wait for Tau to finish or use `/interrupt` first.

After a prompt is added, the picker's buttons stop working and it shows the prompt text, split across more messages if needed. Send a normal message, such as details or “go”, to start the next turn with the prompt in context. In groups, that message must mention the bot as usual. Selecting another prompt adds another message; it does not replace the first. Added prompts survive session recovery.

Only the newest picker in a chat works. A picker belongs to the session that opened it and expires after a selection, when the session is replaced, or when the runner restarts. Tapping twice does not add the prompt twice. Selecting a prompt does not use up pending attachments or group context.

## `AGENTS.md` provides standing context

`AGENTS.md` files are added to the system prompt as project context. Use them for repository conventions, architecture boundaries, verification commands, and other instructions that apply to every request in the project.

Tau always reads `AGENTS.md` from the execution environment, also in a local session.

### Ancestor files are included in full

Starting at the session working directory, Tau checks each ancestor for `AGENTS.md`. When the working directory is inside home, the walk stops at home and includes home itself. Otherwise it stops at the filesystem root.

Each file found is included in full, nearest first, followed by those in parent directories. The agent sees both local and broader instructions. When they conflict, the more specific project guidance takes priority, within the agent's overall instruction hierarchy.

A file is included only if it resolves to a real file named exactly `AGENTS.md`, in a directory that is a parent or a subdirectory of the working directory. When the working directory is inside home, the resolved file must also be inside home. These checks stop a symlink from pulling in unrelated instructions from outside the session's directories.

### Descendant files are listed by path

Tau also looks below the working directory for nested `AGENTS.md` files. Their contents are not added automatically. Tau lists only their paths, so the agent knows more specific instructions exist and can read the right file before working in that subdirectory.

The scan is breadth-first, visits at most 8,192 directories, and goes at most 16 levels deep. It follows only directories whose resolved path stays under the working directory, and it does not loop on symlink cycles.

Tau skips these directory names at every level:

```text
.cache  .git  .hg  .jj  .next  .nuxt  .parcel-cache  .svn  .turbo
.venv  .vite  __pycache__  build  coverage  dist  node_modules  out
target  vendor  venv
```

When the scan starts at the home directory itself, Tau also skips these tool-managed directories directly under home:

```text
.bun  .cargo  .config  .deno  .gradle  .local  .m2  .npm  .nvm
.pnpm-store  .rustup  .sdkman  .yarn
```

It also skips `Library` directly under home on macOS, and `snap` on Linux. A directory with one of these names elsewhere is still scanned.

## Disable project context

Start Tau with:

```bash
tau --no-agent-context-files
```

This turns off both the included `AGENTS.md` files and the list of nested ones. Personas, prompt templates, and [skills](skills.md) still work.

The option works for local TUI sessions and for hosts started with `tau serve`. In the Node SDK, `noAgentContextFiles: true` does the same for the host. An attached client cannot change this for a session that already exists on a remote host.

## Alternate subagent working directories

A subagent normally uses the parent session's working directory and context. When `spawn_agent` sets a different `workingDirectory`, Tau rebuilds the parts of the context that depend on the directory:

- environment and repository details
- the applicable `AGENTS.md` files
- the skills found from that directory

The persona, model catalog, model settings, and tool policy still come from the parent session. A persona file in the other directory is not used. See [subagents](subagents.md) for details.

## Leading hidden system blocks

Tau recognizes one or more `<system>...</system>` blocks only when they start a user message and each closing tag is followed by a newline:

```text
<system>Use the deployment checklist for this response.</system>
Prepare the staging release.
```

The whole message is saved and sent to the model. When Tau displays the message, it hides the recognized blocks and shows the rest. A block anywhere else in the message, a malformed block, or a closing tag without the newline is shown as ordinary text.

Integrations can use this to give the model instructions for one message without showing them as the user's words. The blocks are not secret and do not control access: they are saved in the session and sent to the model. Put project-wide guidance in `AGENTS.md` and lasting persona behavior in the persona's system prompt.

## Reload and verify context

Run `/reload` in an idle session after changing prompts, skills, personas, configuration, or project context files. Reload reads everything again and rebuilds the system prompt for the active persona. It reports configuration warnings and how much content it loaded. Reload is refused while a turn is running.

For a new local session, debug mode prints the discovered content, the paths of loaded context files, tool schemas, and the system prompt, then exits:

```bash
tau --debug --persona release-coder
```

Add `--no-agent-context-files` to see the result without project context. Debug mode works only for TUI startup, not with `tau serve`.

If expected context is missing, check the `cwd` and `home` of the execution environment, not the attached client's current directory. Then check exact filenames, the path rules above, scan exclusions, and reload warnings. See [troubleshooting](troubleshooting.md) for broader diagnostics.
