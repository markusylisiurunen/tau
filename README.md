# tau

Minimal terminal chat app built on `@mariozechner/pi-ai` + `@mariozechner/pi-tui`.

## Run

```sh
npm install
npm run dev
```

Requires Node 20+. macOS only (clipboard uses `pbcopy`).

Set an API key via environment variable:

```sh
export ANTHROPIC_API_KEY=...
# or
export OPENAI_API_KEY=...
# or
export GOOGLE_API_KEY=...
```

Or store it in a config file at `~/.config/tau/config.json`:

```json
{
  "apiKeys": {
    "anthropic": "sk-ant-...",
    "openai": "sk-...",
    "google": "..."
  },
  "userPreferences": "Prefer concise responses. Use TypeScript for code examples. Always explain trade-offs."
}
```

Environment variables take precedence over the config file. The `userPreferences` field is optional; when provided as a non-empty string, it is automatically injected into the system prompt wrapped in `<user_preferences>` tags, allowing you to specify consistent guidance (style, constraints, defaults) without re-prompting each session.

## User-Defined Personas and Prompts

Add custom personas and prompt templates by creating markdown files in `~/.config/tau/personas/` and `~/.config/tau/prompts/`, respectively.

### Custom Personas

Create a file like `~/.config/tau/personas/my-persona.md`:

```markdown
---
id: my-custom-id
label: my custom persona
provider: anthropic
model: claude-opus-4-5
description: A specialized assistant for my workflow
reasoning: medium
allowedReasoningLevels:
  - low
  - medium
  - high
---

You are a specialized assistant tailored to my workflow.
Focus on clarity and efficiency. Always explain trade-offs.
```

Required fields: `id`, `provider`, `model`.
Optional fields: `label`, `description`, `reasoning`, `allowedReasoningLevels`.
The markdown body becomes the system prompt.

User personas are loaded at startup and merged with built-ins (built-ins take precedence on ID collision). Use `--persona my-custom-id` at startup or `/persona:my-custom-id` in the app.

### Custom Prompts

Create a file like `~/.config/tau/prompts/my-prompt.md`:

```markdown
---
id: my-workflow
label: my workflow
description: Structured approach for my project
---

Follow these steps for my project:
1. Understand the requirements
2. Plan the implementation
3. Execute and test
4. Document decisions
```

Required field: `id`.
Optional fields: `label`, `description`.
The markdown body becomes the prompt template.

Use `/prompt:my-workflow` to insert the template into the editor.

### Reloading

Use `/reload` to refresh personas and prompts from disk without restarting. Useful when adding or modifying custom files during a session.

## Commands

- `/help`
- `/new` (clear session)
- `/fork` (summarize session and start new)
- `/reload` (reload personas and prompts from disk)
- `/copy` (copy last assistant message)
- `/copy:code` (copy code block from last assistant message)
- `/persona:<id>` (switch persona)
- `/prompt:<id>` (insert prompt template)
- `/risk:none|read-only|read-write` (configure model risk level; default: `read-only`)
- `!<cmd>` (run immediate shell command)

## Keys

- `shift+tab`: cycle reasoning effort (low/medium/high)
- `ctrl+t`: toggle thought chain visibility
- `ctrl+e`: expand @file mentions (materializes file contents via bash)
- `esc`: interrupt generation
- `ctrl+c`: exit

## CLI Options

```sh
tau --help
tau --persona opus --reasoning high
tau --risk read-write --with-context
```

- `--help`
- `--persona <id>`: see `tau --help` for available personas.
- `--reasoning <level>`: `minimal`, `low`, `medium`, `high`, `xhigh`.
- `--risk <level>`: `none`, `read-only`, `read-write` (default: `read-only`).
- `--with-context`: inject `AGENTS.md` context into the system prompt.

Piping input works as expected:

```sh
cat file.ts | tau --persona opus
```
