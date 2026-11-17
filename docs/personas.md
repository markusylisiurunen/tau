# Personas

A persona defines how the agent works: model, base system prompt, and default reasoning. Every persona has the same [tools](tools.md). Tau ships chat and coder personas for its supported models: chat personas are general assistants for any kind of task, and coder personas are for software development. `tau --help` lists what is available. GPT models have variants for the API and for a ChatGPT subscription. A built-in persona appears only when its model is in the catalog. The default is `sonnet-5.5-coder`.

Select `claude-code-opus-5.5-low`, `claude-code-opus-5.5-medium`, or `claude-code-opus-5.5-high` to choose Opus’s reasoning effort. GPT-6.1 Terra relays messages at medium effort in all three. [Set up Claude Code](subagents.md#claude-code-subagents) and allow the matching `claude-code/claude-opus-5-5:<effort>` launch model first. The relay forwards text and returns only the final reply. With completion notifications enabled you can send more messages while Opus works; without them the relay waits within the turn.

## Writing a persona

A persona is a Markdown file whose body starts the system prompt. Tau follows it with its own instructions, which every persona gets: how hidden `<system>` blocks work, the boundaries on irreversible actions, how updates and the final reply reach the user, and the terminal reply format. Skills, the environment, `AGENTS.md` files, and subagent settings come after that. For example, `.tau/personas/release-coder.md`:

```markdown
---
id: release-coder
label: release coder
description: Prepares and verifies repository releases.
provider: anthropic
model: claude-opus-5-5
reasoning: high
---

Work as a release engineer. Check the repository's release policy before changing anything.
```

Each persona stands alone and inherits nothing from another persona.

```ts
type Frontmatter = {
  id: string; // must match the filename without .md
  provider: string;
  model: string;
  label?: string;
  description?: string;
  reasoning?: Reasoning; // default effort
  allowedReasoningLevels?: Reasoning[]; // what Shift+Tab cycles through
  serviceTier?: "priority" | "flex"; // openai and openai-codex only
  autoCompactThresholdTokens?: number; // at least 50000
  subagentAutoCompactThresholdTokens?: Record<string, number>; // keyed by "<provider>/<model>"
};

type Reasoning =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
```

An invalid persona is skipped with a warning.

## Where personas load from

Tau looks in these locations on the execution environment, and later ones win. A persona with a built-in's ID replaces it.

```text
built-in personas
~/.config/tau/personas/<id>.md       only when cwd is inside home
<ancestor>/.tau/personas/<id>.md     from broadest to nearest
```

## Selecting a persona

```sh
tau --persona release-coder:xhigh
```

```json
{ "defaultPersona": "release-coder:high" }
```

Inside the TUI, use `/persona:release-coder` or Ctrl+P while idle. A switch applies to later turns and keeps the conversation. Shift+Tab changes reasoning, which applies from the next turn.

## Changing a persona file

Run `/reload` while idle. If the current ID still exists, Tau applies its new definition and keeps the session's reasoning and service tier. Otherwise Tau selects the first available persona. Running subagents keep the setup they started with.
