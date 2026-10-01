# Skills

Skills are local packages of instructions and supporting material that teach an agent how to handle a particular kind of work. Tau discovers them from the execution environment, shows all discovered skills to every persona, and lets the agent open a skill only when the task calls for it.

A skill is not a prompt template, a persona, or project context. A [prompt template](prompts-and-project-context.md) is text placed in the input editor. A [persona](personas.md) chooses the model, system prompt, and tools for a session. `AGENTS.md` gives standing instructions for a directory tree. A skill is a reusable, selectively activated workflow with its own directory.

## Where Tau discovers skills

Tau looks for skill directories at global and project levels:

| Scope | Locations |
| --- | --- |
| Global | `~/.config/tau/skills/<name>/SKILL.md` and `~/.agents/skills/<name>/SKILL.md` |
| Project | `<level>/.tau/skills/<name>/SKILL.md` and `<level>/.agents/skills/<name>/SKILL.md` |

The global level is in scope only when the session working directory is inside the execution environment's home directory. For project discovery, Tau walks from the working directory toward home, or toward the filesystem root when the working directory is outside home. A directory participates as a project level when it contains `.tau/` or `.agents/skills/`.

Skills are keyed by name. Precedence runs from broadest to most specific:

1. Global skills are the base layer.
2. Parent project levels override global and more distant parent levels.
3. The nearest project level wins.
4. At the same level, `.tau/skills/` overrides `.agents/skills/`.

For example, with a session in `~/code/atlas/apps/api`, these definitions of `release-check` resolve to the last one listed:

```text
~/.config/tau/skills/release-check/SKILL.md
~/code/atlas/.tau/skills/release-check/SKILL.md
~/code/atlas/apps/.agents/skills/release-check/SKILL.md
```

`~/.config/tau/skills/` also overrides `~/.agents/skills/` for a same-named global skill.

All discovery happens in the execution environment. A remote host does not inspect the attached client's filesystem for skills.

## The skill directory contract

Each skill is a directory containing an exact uppercase `SKILL.md` filename:

```text
.tau/skills/release-check/
├── SKILL.md
├── references/
│   └── environments.md
├── scripts/
│   └── verify.sh
└── assets/
    └── checklist.txt
```

Only `SKILL.md` is required. `references/`, `scripts/`, and `assets/` are conventional optional directories, not separately registered content. The instructions in `SKILL.md` decide when and how to use them. Paths mentioned by a skill are relative to the skill directory unless the skill says otherwise.

`SKILL.md` starts with YAML frontmatter followed by Markdown instructions:

```markdown
---
name: release-check
description: Verify a release candidate and summarize blockers. Trigger: explicit.
license: MIT
compatibility: Requires Git and npm.
metadata:
  owner: platform
  maturity: stable
allowed-tools: bash, view_image
---

Check the release branch, run the repository verification commands, and report only blocking failures.
```

The frontmatter contract is:

| Field | Requirement |
| --- | --- |
| `name` | Required. Between 1 and 64 characters, using lowercase letters, digits, and single dashes between segments. It must exactly match the containing directory name. |
| `description` | Required. A non-empty string of at most 1,024 characters. Tau includes it in the discovered skill index, so it should say what the skill does and when it applies. |
| `license` | Optional non-empty string. |
| `compatibility` | Optional non-empty string of at most 500 characters. |
| `metadata` | Optional map whose keys and values are strings. |
| `allowed-tools` | Optional non-empty string. It is accepted for skills-format compatibility but currently ignored by Tau. |

Unknown frontmatter fields are discarded. `allowed-tools` does not enable, disable, or restrict any tool. Tool availability comes from the active persona; subagents inherit its eligible tools. See [tools](tools.md) and [subagents](subagents.md).

Keep the description useful without copying the full workflow into it. Tau initially exposes the name, description, and `SKILL.md` path. The agent opens the file after activation, then reads only the referenced resources needed for the task.

## Skill availability

Every persona exposes all discovered skills. Discovery does not run a skill on every turn; it makes the skill available to the agent under its activation policy.

## Activation and trigger sensitivity

A skill declares trigger sensitivity in its `description`. The supported policy levels are:

- **eager**: activate proactively whenever the capability would help.
- **balanced**: activate when the request clearly matches the skill. This is the default when no trigger is stated.
- **explicit**: activate only when the skill is explicitly named by an active instruction.

Use a clear phrase such as `Trigger: eager.`, `Trigger: balanced.`, or `Trigger: explicit.` in the description. Trigger sensitivity is an agent-facing convention carried by the description, not a separate frontmatter field.

An exact skill reference has this form:

```text
@@skill:release-check
```

A reference in the current user request, active `AGENTS.md` instructions, or an already-active skill explicitly activates that skill. Generic wording or a coincidental keyword does not activate an explicit skill.

Skill references compose. If `release-check` instructs the agent to use `@@skill:dependency-audit`, Tau's activation policy allows the second skill to activate transitively. Each skill activates at most once per request, so repeated references and cycles do not reopen it.

After activation, the agent reads `SKILL.md` from the path in the discovered index. It should load only relevant files from `references/` or `assets/`, and prefer provided scripts when they implement the required workflow. Skills are treated as read-only unless the user explicitly asks to edit them.

## Applying changes and checking discovery

A running TUI session keeps its current content catalog and prompt context until it reloads. Run:

```text
/reload
```

Reloading re-discovers skills and rebuilds the effective skill index. Tau refuses to reload while a session turn is running. If the active persona disappeared, reload selects the first available persona; if no personas remain, reload fails.

For a new local TUI session, `tau --debug` prints the discovered skills and the effective system prompt without starting the TUI. Combine it with `--persona` to inspect its effective prompt:

```bash
tau --debug --persona release-coder
```

Invalid skills are skipped and reported as configuration warnings. Common causes are malformed YAML, non-object frontmatter, a missing required field, an invalid name, a directory/name mismatch, an unreadable file, or an unreadable skills directory. A subdirectory without `SKILL.md` is simply not a skill.

When troubleshooting precedence, check the session's execution-environment working directory first. Discovery is based on that path, not necessarily the filesystem where the TUI is running. Broader configuration diagnostics are covered in [troubleshooting](troubleshooting.md).
