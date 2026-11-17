# Personas

A persona defines how the agent works: model, base system prompt, default reasoning, and tools. Tau ships chat and coder personas for its supported models, and `tau --help` lists what is available. GPT models have variants for the API and for a ChatGPT subscription. A built-in persona appears only when its model is in the catalog. The default is `sonnet-5.5-coder`.

## Writing a persona

A persona is a Markdown file whose body is the system prompt. For example, `.tau/personas/release-coder.md`:

```markdown
---
id: release-coder
label: release coder
description: Prepares and verifies repository releases.
provider: anthropic
model: claude-opus-5-5
reasoning: high
tools: [bash, write, edit, web, history]
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
  tools?: ToolName[]; // default: all of them
  autoCompactThresholdTokens?: number; // at least 50000
  subagentAutoCompactThresholdTokens?: Record<string, number>; // keyed by "<provider>/<model>"
};

type Reasoning =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ToolName =
  | "bash"
  | "write"
  | "edit"
  | "view_image"
  | "web"
  | "history"
  | "mcp"
  | "models"
  | "agents";
```

A `tools` list replaces the defaults, and `tools: []` turns all of them off. `tau_docs` and client tools are always unaffected. See [tools](tools.md).

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
