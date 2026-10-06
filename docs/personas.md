# Personas

A persona defines how the agent works. It chooses a provider and model, supplies the base system prompt, sets reasoning and service tier, and selects tools. Switching persona changes how later turns run, in the same session.

Tau ships built-in personas and loads custom persona files from the execution environment. The available list depends on the Tau version and on where the session runs, so check the current list instead of relying on remembered names.

## Built-in and effective personas

Built-in personas are generated from Tau's current model catalog. Most model families have separate chat and coder variants, and some have only the variants Tau supports. Built-ins come with Tau's own prompts, defaults, tool selections, and subagent tools.

The Opus 5.5 chat and coder personas are available only when `anthropic/claude-opus-5-5` is present in the effective model catalog. The Sonnet 5.5 variants (`sonnet-5.5-chat` and `sonnet-5.5-coder`) likewise require `anthropic/claude-sonnet-5-5`.

GPT-6.1 Sol, GPT-6 Luna, and GPT-6 Astra have API and ChatGPT variants for chat and coding. Fast ChatGPT variants use priority service and are available only for coding. They are available only when the effective catalog contains the matching model ID (`gpt-6.1-sol`, `gpt-6-luna`, or `gpt-6-astra`) for the corresponding provider.

All built-in personas default to medium reasoning. The startup default is `sonnet-5.5-coder`.

After a remote catalog refresh, `/reload` adopts the updated catalog for an existing session.

Built-in personas are always included. A custom persona replaces a built-in by using the same ID.

To see the current list:

```sh
tau --help
tau --debug
```

`tau --debug` also prints the full prompts and project context, so be careful where you share its output.

If no personas are left, session creation fails. Reload also fails, so a running session never ends up without a persona.

## Discovery and precedence

Custom persona files are loaded from:

- `~/.config/tau/personas/<id>.md` when the session `cwd` is inside the execution environment's home;
- every ancestor `.tau/personas/<id>.md` from the broadest project level to the nearest.

Built-ins come first, global custom personas override them, and the nearest project definition wins. IDs are compared case-insensitively when deciding which definition overrides which. The `id` inside a file must still match its filename without `.md` exactly, including case.

For a session in `~/code/ledger/apps/api`, a project file at `~/code/ledger/apps/.tau/personas/release-coder.md` overrides the same ID from `~/code/ledger/.tau/personas/` or `~/.config/tau/personas/`.

These locations are on the execution environment. An attached TUI does not add persona files to a remote session. See [configuration](configuration.md) and [ownership and scope](ownership-and-scope.md).

## Persona file contract

A persona is a Markdown file with YAML frontmatter. `id`, `provider`, and `model` are required. The Markdown body is required, must not be empty, and becomes the persona's base system prompt.

```markdown
---
id: release-coder
label: release coder
description: Prepares and verifies repository releases.
provider: anthropic
model: claude-opus-5-5
reasoning: high
allowedReasoningLevels:
  - medium
  - high
  - xhigh
tools:
  - bash
  - write
  - edit
  - view_image
  - web
  - history
---

Work as a release engineer. Inspect repository policy before changing release state.
```

The frontmatter must be a YAML object between `---` lines. Unknown fields are ignored.

### Required fields

| Field | Contract |
| --- | --- |
| `id` | Non-empty persona ID. It must exactly match the filename without `.md`. |
| `provider` | Non-empty provider ID from the installed [model catalog](models.md). |
| `model` | Non-empty model ID for that provider. It may be an ID missing from the catalog, as long as the provider is known. |

Each custom persona is complete on its own. It does not inherit a provider, model, prompt, or settings from another persona.

### Optional fields

| Field | Contract |
| --- | --- |
| `label` | Display label. A blank or omitted label falls back to `custom`. |
| `description` | Short catalog description. |
| `reasoning` | Default effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `serviceTier` | `priority` or `flex`. Used only by `openai` and `openai-codex`. |
| `allowedReasoningLevels` | Array of reasoning efforts offered by the TUI selector. |
| `tools` | List of persona-selectable tools. |

Every persona can use all discovered skills. If a custom persona omits `tools`, Tau enables the standard tools and the subagent tools. A `tools` list without `spawn_agent` prevents the agent from starting subagents. See [skills](skills.md) and [subagents](subagents.md) for those contracts.

The selectable tool names are:

- `bash`, `write`, `edit`, `view_image`, `web`, `nook`, `history`, `mcp`, and `models`;
- `spawn_agent`, `send_input_to_agent`, `wait_for_agents`, `list_agents`, and `interrupt_agent`.

Names such as `web`, `nook`, `history`, `mcp`, and `models` enable capabilities inside the `code` tool, and `bash` also enables `tau.bash`. Tau builds the `code` tool from whichever of these capabilities are selected and usable.

A `tools` list replaces the defaults. Names are lowercased and duplicates removed. An unknown name makes the persona invalid. `tools: []` gives the persona none of these tools. The built-in `tau_docs` tool is always available, independent of this list. `nook` works only when Nook is configured, and `mcp` only when the host has enabled MCP servers. [Tools](tools.md) explains eligibility and ownership.

## Selecting a persona

`defaultPersona` in `config.json` selects the startup default. It accepts an exact persona ID or an ID plus reasoning override:

```json
{
  "defaultPersona": "release-coder:high"
}
```

The most specific `defaultPersona` wins. The ID must match exactly, including case. An unknown default produces a warning, and Tau uses the first available persona.

Override the default for one TUI launch:

```sh
tau --persona release-coder:xhigh
```

`-p` is the short form. The same `<id>:<effort>` syntax and reasoning enum apply.

Inside the TUI, switch while idle with:

```text
/persona:release-coder
```

This command matches the ID case-insensitively. `Ctrl+P` cycles through the available personas. A switch reloads configuration and content from the execution environment, applies the new persona, rebuilds project and skill context and the tool set, and saves the new session settings. The TUI refuses to switch while a turn is running.

## Reasoning and service tier

`reasoning` is the persona's default effort. A startup suffix, the session reasoning command, or `Shift+Tab` can override it. You can change reasoning while a turn is running, but the running turn keeps the model and tool settings it started with. The new effort applies from the next submitted or queued turn.

`allowedReasoningLevels` sets which values the TUI cycles through for the persona. It limits only the TUI selector; protocol clients can still set other levels. When it is omitted, the TUI offers all standard levels for a model that supports reasoning. For a model whose catalog entry says `reasoning: false`, the selector shows only `none`.

An empty `allowedReasoningLevels` does not create an empty selector. The TUI uses its normal model-aware choices.

`serviceTier` is sent with OpenAI and OpenAI Codex requests. `priority` requests the provider's priority service, and `flex` requests flex service. Whether the tier is available, how it is billed, and whether requests are rejected depend on your provider account. Other providers ignore this setting.

## Reloading changes

After editing personas, skills, or project context, run `/reload` while the session is idle. Reload finds personas again and rebuilds the session's prompt and tools.

If the current persona ID still exists, Tau applies its newly loaded definition. This can reset settings such as reasoning or service tier to the definition's values. If the ID is gone, Tau selects the first available persona. Existing messages stay as they are; a persona change never rewrites earlier history.

The TUI refuses to reload while a turn is running. Subagents that are already running keep the setup they started with. Subagents started after the reload use the reloaded persona. See [subagents](subagents.md).

## Validation and common mistakes

An invalid persona is skipped and reported as a configuration warning. Other valid personas still load. Frequent causes are:

- malformed YAML, missing frontmatter delimiters, or frontmatter that is not an object;
- missing `id`, `provider`, `model`, or a non-empty prompt body;
- an `id` that does not exactly match the filename;
- an unknown provider or an unresolved model;
- an invalid reasoning effort or service tier;
- an unknown persona tool.

`/reload` shows warnings, with file paths, in the transcript. For a new local session, `tau --debug --persona <id>` shows the selected model, settings, skills, subagents, tools, and the complete prompt. If an edit seems to have no effect in a remote session, confirm the session's execution environment and `cwd` before editing another copy of the file. [Troubleshooting](troubleshooting.md) covers that check in more detail.
