# Prompts and project context

Tau has several ways to provide instructions or reusable text, and they enter a session at different points. Prompt templates fill the editor on demand. `AGENTS.md` files provide standing project instructions. Additional context files extend that `AGENTS.md` set. Leading hidden system blocks attach model-facing instructions to one user message.

These mechanisms do not choose models or tool access. [Personas](personas.md) own the base system prompt, model settings, skill selection, and tool allowlist. Model-specific system notices are configured separately in the [configuration reference](config-reference.md).

## Prompt templates fill the editor

A prompt template is saved Markdown that Tau inserts into the TUI editor for review and submission. It is not added to the system prompt and does not run automatically.

Tau discovers prompt files from:

| Scope   | Location                        |
| ------- | ------------------------------- |
| Global  | `~/.config/tau/prompts/<id>.md` |
| Project | `<level>/.tau/prompts/<id>.md`  |

The global location is in scope only when the execution-environment working directory is inside its home directory. Tau walks project levels from the working directory toward home, or toward the filesystem root when outside home. The nearest project definition wins over parent and global definitions. Prompt IDs are compared case-insensitively for precedence and lookup.

A prompt file needs YAML frontmatter with an `id` that exactly matches its filename without `.md`:

```markdown
---
id: release-summary
label: release summary
description: Summarize changes for a release announcement.
---

Summarize the changes since the previous release. Separate user-visible changes from internal maintenance, and call out any migration steps.
```

The fields are:

- `id`: required, non-empty, and exactly equal to the filename stem.
- `label`: optional display label.
- `description`: optional catalog and autocomplete description.

Unknown fields are discarded. The Markdown body is the text inserted into the editor.

Only files ending in lowercase `.md` are discovered. Invalid YAML, non-object frontmatter, a missing `id`, or an ID/filename mismatch causes Tau to skip the file and report a warning.

### Invoke a prompt

In the TUI, invoke a prompt by ID:

```text
/prompt:release-summary
```

Tau replaces the current editor text with the template body. It does not submit the text, so it can be edited before sending. Prompt lookup is case-insensitive.

The session catalog stores only prompt metadata. Tau loads the body lazily from the execution environment when `/prompt:<id>` runs. This has two practical effects:

- Editing the body of an already-cataloged prompt can affect its next invocation without embedding that body in the session snapshot.
- Adding, removing, renaming, or changing the metadata of a prompt requires `/reload` before the TUI catalog and autocomplete reflect it.

If the file is missing or invalid when Tau resolves it, invocation fails instead of using a stale body. Remote clients ask the host to resolve the prompt from the session's execution environment; they do not read a same-named file on the client machine.

### Install starter prompts

Use `tau install` to copy Tau's starter content:

```bash
tau install --prompt commit-staged
```

The default target is `.tau/prompts/` under the current directory. Add `--global` for `~/.config/tau/prompts/`. Existing prompt files are skipped unless `--force` is supplied. Running `tau install` without `--prompt` or `--skill` installs all starter prompts and skills.

## `AGENTS.md` provides standing context

`AGENTS.md` is project context injected into the effective system prompt. It is suitable for repository conventions, architectural boundaries, verification commands, and instructions that should apply to every relevant request.

Tau resolves `AGENTS.md` through the execution environment. Client and host filesystem access is not used as a shortcut, even for a local session.

### Ancestor files are included in full

Starting at the session working directory, Tau checks each ancestor for `AGENTS.md`. When the working directory is inside home, the walk stops at home and includes home itself. Otherwise it stops at the filesystem root.

Existing eligible files are included in full. The nearest file is injected first, followed by its ancestors. This lets the agent see both local and broader instructions; when instructions conflict, the active instruction hierarchy and the more specific project guidance determine behavior.

A candidate must resolve to a real file whose basename is exactly `AGENTS.md`. Its directory must be either an ancestor or a descendant of the current working directory. When the working directory is inside home, the canonical file must also remain inside home. These checks prevent a symlink from silently importing unrelated context outside the session's path boundary.

### Descendant files are listed by path

Tau also scans below the current working directory for nested `AGENTS.md` files. Their contents are not injected automatically. Tau includes only their paths so the agent knows that more specific instructions exist and can read the relevant file before working in that subtree.

The scan is breadth-first, visits at most 8,192 directories, and descends at most 16 levels below the working directory. It follows only directory paths that canonically remain under that directory and avoids symlink cycles.

Tau skips these directory names at every level:

```text
.cache  .git  .hg  .jj  .next  .nuxt  .parcel-cache  .svn  .turbo
.venv  .vite  __pycache__  build  coverage  dist  node_modules  out
target  vendor  venv
```

When scanning directly from the execution home, Tau also skips direct children managed by common tools:

```text
.bun  .cargo  .config  .deno  .gradle  .local  .m2  .npm  .nvm
.pnpm-store  .rustup  .sdkman  .yarn
```

It additionally skips the direct `Library` child on macOS and `snap` on Linux. A project directory with one of these names is still scanned when it is not a direct child of home.

The limits and exclusions apply only to automatic descendant discovery. They do not constrain explicitly configured context files.

## Add explicit `AGENTS.md` files

`agentContextFiles` adds specific `AGENTS.md` files to the full injected context. The setting is an array of non-empty path strings:

```json
{
  "agentContextFiles": ["docs/AGENTS.md", "services/api/AGENTS.md"]
}
```

Paths are resolved from the level that declares them:

- A global path in `~/.config/tau/config.json` is relative to home.
- A project path in `<project>/.tau/config.json` is relative to `<project>`, the directory containing `.tau/`.
- Absolute paths remain absolute.

Values are additive across configuration levels, from global through the nearest project level. Tau resolves them to paths and removes exact duplicates while preserving order.

An explicit file still has to meet the context boundary: it must resolve to a real file named `AGENTS.md`, its directory must be an ancestor or descendant of the working directory, and an in-home session cannot escape home through a path or symlink. Sibling files are ignored. Missing and ineligible files are not injected.

Explicit descendants are included in full and are removed from the paths-only nested list. Explicit files bypass the automatic child scan's depth, directory-count, and excluded-directory rules.

`agentContextFiles` is useful when important instructions live below the current working directory but should apply to the whole session. Do not use it as a general arbitrary-file include mechanism; only `AGENTS.md` is accepted.

## Disable project context

Start Tau with:

```bash
tau --no-agent-context-files
```

This disables ancestor `AGENTS.md` injection, configured `agentContextFiles`, and the descendant paths-only scan. It does not disable personas, prompt templates, or [skills](skills.md).

The option applies to local TUI sessions and to hosts started with `tau rpc` or `tau serve`. For the Node SDK, `noAgentContextFiles: true` provides the same host-level behavior. An attached client cannot retroactively change how an existing remote host session was created.

## Alternate subagent working directories

A subagent normally inherits the parent session's working directory and composed context. When `spawn_agent` specifies a different `workingDirectory`, Tau rebuilds the subagent's target-dependent context from that directory.

The alternate directory controls:

- target environment and repository metadata,
- target applicable `AGENTS.md` and `agentContextFiles`,
- target-discovered skills filtered by the parent persona.

The parent session remains the source of truth for the selected persona, subagent definition, model catalog, model settings, and tool policy. Tau filters skills discovered at the alternate directory through the parent persona's skill selection. It does not replace the source persona with a persona found in the target directory. See [subagents](subagents.md) for the full launch contract.

## Leading hidden system blocks

Tau recognizes one or more exact `<system>...</system>` blocks only when they begin a user message and each closing tag is followed by a newline:

```text
<system>Use the deployment checklist for this response.</system>
Prepare the staging release.
```

The complete raw message is persisted and remains model-visible, while Tau's user-message display omits the recognized leading blocks and shows the remaining text. A block elsewhere in the message, a malformed block, or a closing tag without the required newline is ordinary visible text.

This mechanism is useful for integrations that need per-message model instructions without presenting them as user prose. It is not a secret channel or a substitute for access control: the content is durable session data and is sent to the model. Project-wide guidance belongs in `AGENTS.md`; stable persona behavior belongs in the persona system prompt.

## Reload and verify context

Run `/reload` in an idle TUI session after changing prompts, skills, personas, configuration, or `AGENTS.md`. Reload re-resolves content and rebuilds the active persona's system context. It reports configuration warnings and the resulting counts. Reload is refused while a session turn is active.

For a new local TUI session, debug mode prints discovered content, loaded `AGENTS.md` paths, tool schemas, and the effective system prompt, then exits:

```bash
tau --debug --persona release-coder
```

Add `--no-agent-context-files` to verify the context-free variant. Debug mode is TUI startup functionality and is not available with `tau rpc` or `tau serve`.

If expected context is missing, verify the execution-environment `cwd` and `home`, not just the attached client's current directory. Then check exact filenames, canonical path eligibility, configuration-level path bases, scan exclusions, and reload warnings. See [troubleshooting](troubleshooting.md) for broader diagnostics.
