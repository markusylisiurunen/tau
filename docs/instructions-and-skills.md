# Instructions and skills

| Use | For | How it reaches the agent |
| --- | --- | --- |
| `AGENTS.md` | Standing project instructions | Added to the system prompt |
| Skill | A reusable workflow | The agent opens it when the task calls for it |
| Prompt template | Text you reuse | Fills your editor for you to review and send |
| Persona | Model, base prompt, and tools | See [personas](personas.md) |

All of these are read on the execution environment. Run `/reload` while idle after changing them.

## `AGENTS.md`

Tau includes every `AGENTS.md` from the working directory up to home, or up to the filesystem root when outside home. Nearer files come first, and more specific guidance takes priority.

Nested files below the working directory are listed by path only, so the agent can read the right one before working in that directory. The scan skips common build and dependency directories such as `node_modules` and `dist`.

`tau --no-agent-context-files` turns this off. A subagent started in another directory gets the `AGENTS.md` files and skills of that directory.

## Skills

A skill is a directory with a `SKILL.md` file, and any other files it refers to:

```text
.tau/skills/release-check/
├── SKILL.md
└── scripts/verify.sh
```

```markdown
---
name: release-check
description: Verify a release candidate and summarize blockers. Trigger: explicit.
---

Check the release branch, run scripts/verify.sh, and report only blocking failures.
```

`name` must match the directory name and use lowercase letters, digits, and single dashes. `description` is required and limited to 1,024 characters. Until a skill is activated, the agent sees only its name, description, and path, so the description should say what the skill does and when it applies.

The description also sets when the agent activates the skill:

- `Trigger: eager.` means whenever the skill would help.
- `Trigger: balanced.` means when the request clearly matches. This is the default.
- `Trigger: explicit.` means only when named as `@@skill:release-check` by you, `AGENTS.md`, or an active skill.

Tau looks in these locations, and later ones win:

```text
~/.agents/skills/<name>/                 only when cwd is inside home
~/.config/tau/skills/<name>/
<level>/.agents/skills/<name>/           from broadest to nearest project level
<level>/.tau/skills/<name>/
```

At the same level, `.tau/skills` wins over `.agents/skills`. Every persona can use every discovered skill. `allowed-tools` in frontmatter is ignored, because tools come from the persona. An invalid skill is skipped with a warning.

## Prompt templates

A prompt template is Markdown that fills the editor. Save it as `~/.config/tau/prompts/<id>.md` or `.tau/prompts/<id>.md`:

```markdown
---
label: release summary
---

Summarize the changes since the previous release, and call out any migration steps.
```

In the TUI, `/prompt:release-summary` fills the editor without sending. In Telegram, `/prompt` opens a picker. Tau reads the body each time you use the prompt, but you need `/reload` after adding, removing, or renaming one.

## Hidden system blocks

A `<system>` block at the very start of a user message reaches the model but is hidden from the transcript. Integrations use this to add instructions for one message:

```text
<system>Use the deployment checklist for this response.</system>
Prepare the staging release.
```

The closing tag must be followed by a newline. These blocks are saved with the session and are not secret.
