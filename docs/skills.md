# Skills

A skill is a directory of instructions and supporting files that teaches an agent how to handle one kind of work. Tau finds skills on the execution environment and lists all of them for every persona. The agent opens a skill only when the task calls for it.

Skills differ from Tau's other content:

- A [prompt template](prompts-and-project-context.md) is text you insert into the input editor.
- A [persona](personas.md) chooses the model, system prompt, and tools for a session.
- `AGENTS.md` gives standing instructions for a directory tree.
- A skill is a reusable workflow that the agent loads only when it applies.

## Where Tau discovers skills

Tau looks for skill directories at global and project levels:

| Scope | Locations |
| --- | --- |
| Global | `~/.config/tau/skills/<name>/SKILL.md` and `~/.agents/skills/<name>/SKILL.md` |
| Project | `<level>/.tau/skills/<name>/SKILL.md` and `<level>/.agents/skills/<name>/SKILL.md` |

The global level applies only when the session's working directory is inside the execution environment's home directory. For project levels, Tau searches from the working directory up to home, or up to the filesystem root when the working directory is outside home. A directory counts as a project level when it contains `.tau/` or `.agents/skills/`.

Skills are identified by name. When two levels define the same name, the more specific one wins:

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

Discovery happens only on the execution environment. Skills on an attached client's machine are never used.

## The skill directory contract

Each skill is a directory that contains a file named exactly `SKILL.md`, in uppercase:

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

Only `SKILL.md` is required. `references/`, `scripts/`, and `assets/` are optional directories by convention; Tau does not treat them specially. The instructions in `SKILL.md` say when and how to use them. Paths in a skill are relative to the skill directory unless the skill says otherwise.

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

The frontmatter fields are:

| Field | Requirement |
| --- | --- |
| `name` | Required. Between 1 and 64 characters, using lowercase letters, digits, and single dashes between segments. It must exactly match the containing directory name. |
| `description` | Required. A non-empty string of at most 1,024 characters. Tau includes it in the discovered skill index, so it should say what the skill does and when it applies. |
| `license` | Optional non-empty string. |
| `compatibility` | Optional non-empty string of at most 500 characters. |
| `metadata` | Optional map whose keys and values are strings. |
| `allowed-tools` | Optional non-empty string. Accepted so that skills written for other tools load, but Tau ignores it. |

Unknown frontmatter fields are ignored. `allowed-tools` does not enable, disable, or restrict any tool. Tools come from the active persona, and subagents inherit the eligible ones. See [tools](tools.md) and [subagents](subagents.md).

Keep the description short and useful, without the full workflow. Until a skill is activated, the agent sees only its name, description, and `SKILL.md` path. After activation the agent opens the file and reads only the referenced files the task needs.

## Skill availability

Every persona can use all discovered skills. A discovered skill does not run on every turn. The agent activates it according to its trigger sensitivity.

## Activation and trigger sensitivity

A skill declares trigger sensitivity in its `description`. The supported policy levels are:

- **eager**: activate proactively whenever the capability would help.
- **balanced**: activate when the request clearly matches the skill. This is the default when no trigger is stated.
- **explicit**: activate only when the skill is explicitly named by an active instruction.

Put a clear phrase such as `Trigger: eager.`, `Trigger: balanced.`, or `Trigger: explicit.` in the description. There is no separate frontmatter field; the agent reads the policy from the description.

An exact skill reference has this form:

```text
@@skill:release-check
```

A reference in the current user request, active `AGENTS.md` instructions, or an already-active skill explicitly activates that skill. Generic wording or a coincidental keyword does not activate an explicit skill.

A skill can activate another skill. If `release-check` tells the agent to use `@@skill:dependency-audit`, that second skill activates too. Each skill activates at most once per request, so repeated references and cycles do not open it again.

After activation, the agent reads `SKILL.md` from the listed path. It loads only the relevant files from `references/` or `assets/`, and uses the skill's scripts when they do what the workflow needs. The agent does not edit skills unless the user explicitly asks.

## Applying changes and checking discovery

A running session keeps its current skills and prompt context until it reloads. Run:

```text
/reload
```

Reload finds skills again and rebuilds the list the agent sees. Tau refuses to reload while a turn is running. If the active persona no longer exists, reload selects the first available persona. If no personas remain, reload fails.

For a new local session, `tau --debug` prints the discovered skills and the system prompt without starting the TUI. Add `--persona` to see the prompt for a specific persona:

```bash
tau --debug --persona release-coder
```

Invalid skills are skipped and reported as configuration warnings. Common causes are malformed YAML, frontmatter that is not an object, a missing required field, an invalid name, a name that differs from the directory name, or a file or skills directory that cannot be read. A subdirectory without `SKILL.md` is not a skill and produces no warning.

When a skill does not resolve as expected, first check the session's working directory on the execution environment. Discovery starts from that path, which may be on a different machine from the TUI. Broader configuration diagnostics are covered in [troubleshooting](troubleshooting.md).
