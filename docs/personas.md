# Personas

A persona is Tau's complete model-facing working profile. It chooses a provider and model, supplies the base system prompt, sets reasoning and service behavior, and selects tools. Changing persona changes how future turns run without creating a new session.

Tau ships generated built-in personas and discovers custom persona Markdown from the execution environment. The effective list is version-specific and scope-specific, so inspect the current catalog rather than relying on a memorized list of names.

## Built-in and effective personas

Built-in personas are generated from Tau's current model catalog. Most model families have separate chat and coder variants; some families expose only the variants Tau supports. Built-ins carry Tau-maintained prompts, defaults, tool selections and subagent supervision tools.

The Opus 5.5 chat and coder personas are available only when `anthropic/claude-opus-5-5` is present in the effective model catalog. The Sonnet 5.5 variants (`sonnet-5.5-chat` and `sonnet-5.5-coder`) likewise require `anthropic/claude-sonnet-5-5`.

GPT-6.1 Sol, GPT-6 Luna, and GPT-6 Astra have API and ChatGPT variants for chat and coding. Fast ChatGPT variants use priority service and are available only for coding. They are available only when the effective catalog contains the matching model ID (`gpt-6.1-sol`, `gpt-6-luna`, or `gpt-6-astra`) for the corresponding provider.

All built-in personas default to medium reasoning. The startup default is `sonnet-5.5-coder`.

After a remote catalog refresh, `/reload` adopts the updated catalog for an existing session.

Built-in personas are always included in the catalog. Custom personas can replace a built-in by using the same ID.

Use one of these to inspect the current effective list:

```sh
tau --help
tau --debug
```

`tau --debug` also prints full effective prompts and project context. Use it only where that output is appropriate.

If no personas remain, session creation fails. Reload also fails rather than leaving a running session without a persona.

## Discovery and precedence

Custom persona files are loaded from:

- `~/.config/tau/personas/<id>.md` when the session `cwd` is inside the execution environment's home;
- every ancestor `.tau/personas/<id>.md` from the broadest project level to the nearest.

Personas are keyed case-insensitively for overlay precedence. Built-ins form the base, global custom personas override them, and the nearest project definition wins. The `id` inside each file must still exactly match its case-sensitive filename without `.md`.

For a session in `~/code/ledger/apps/api`, a project file at `~/code/ledger/apps/.tau/personas/release-coder.md` overrides the same ID from `~/code/ledger/.tau/personas/` or `~/.config/tau/personas/`.

These locations belong to the execution environment. An attached TUI does not contribute persona files to a remote session. See [configuration](configuration.md) and [ownership and scope](ownership-and-scope.md).

## Persona file contract

A persona is Markdown with YAML frontmatter. `id`, `provider`, and `model` are required. A non-empty Markdown body is required and supplies the persona's own base system prompt.

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

The frontmatter must be a YAML object between valid delimiters. Unknown fields are discarded.

### Required fields

| Field | Contract |
| --- | --- |
| `id` | Non-empty persona ID. It must exactly match the filename without `.md`. |
| `provider` | Non-empty provider ID from the installed [model catalog](models.md). |
| `model` | Non-empty model ID for that provider. The ID may be unbundled when the provider is known. |

Each custom persona is self-contained: it supplies its provider, model, prompt, and optional settings.

### Optional fields

| Field | Contract |
| --- | --- |
| `label` | Display label. A blank or omitted label falls back to `custom`. |
| `description` | Short catalog description. |
| `reasoning` | Default effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `serviceTier` | `priority` or `flex`. Currently meaningful for `openai` and `openai-codex`. |
| `allowedReasoningLevels` | Array of reasoning efforts offered by the TUI selector. |
| `tools` | Explicit list of persona-controlled tools. |

Every persona exposes all discovered skills. If a custom persona omits `tools`, Tau enables the ordinary host tools plus subagent supervision tools. An explicit `tools` list without `spawn_agent` prevents subagent launches. See [skills](skills.md) and [subagents](subagents.md) for those contracts.

The persona-controlled tool names are:

- `bash`, `write`, `edit`, `view_image`, `web`, `nook`, `history`, `mcp`, and `models`;
- `spawn_agent`, `send_input_to_agent`, `wait_for_agents`, `list_agents`, and `interrupt_agent`.

The service selectors enable capabilities within `code`; `bash` also enables `tau.bash`. The `code` tool is assembled automatically from selected eligible capabilities. An explicit `tools` array replaces defaults. Names are normalized to lowercase, duplicates are removed, and unknown names reject the persona. `tools: []` leaves the persona without these persona-controlled tools. Some host capabilities, such as goal management, are supplied independently of this list. Listing `nook` does not make it usable without effective Nook configuration. Listing `mcp` requires enabled MCP servers configured on the host. [Tools](tools.md) explains eligibility and ownership.

## Selecting a persona

`defaultPersona` in `config.json` selects the startup default. It accepts an exact persona ID or an ID plus reasoning override:

```json
{
  "defaultPersona": "release-coder:high"
}
```

The most specific configured `defaultPersona` wins. Startup references are exact and case-sensitive. An unknown configured default produces a warning and Tau falls back to the first effective persona.

Override the default for one TUI launch:

```sh
tau --persona release-coder:xhigh
```

`-p` is the short form. The same `<id>:<effort>` syntax and reasoning enum apply.

Inside the TUI, switch while idle with:

```text
/persona:release-coder
```

The TUI resolves that command against the session catalog case-insensitively. `Ctrl+P` cycles effective personas. A persona switch reloads runtime content from the execution environment, selects the requested definition, rebuilds project and skill context, updates the tool registry, and persists the new session settings. The TUI refuses to switch while a turn is running.

## Reasoning and service tier

`reasoning` is the persona's default effort. A startup suffix, the session reasoning command, or `Shift+Tab` can override it. Reasoning changes are allowed while a turn is running, but the active logical turn keeps the complete model and tool specification captured when it began. The new effort applies to the next independently submitted or queued turn.

`allowedReasoningLevels` controls which values the TUI cycles for that persona. It is a presentation allowlist, not a protocol-level prohibition. When omitted, the TUI offers the standard reasoning enum for a reasoning-capable model. For a model whose catalog entry says `reasoning: false`, the selector resolves to `none`.

An empty `allowedReasoningLevels` does not create an empty selector. The TUI uses its normal model-aware choices.

`serviceTier` is passed with supported OpenAI and OpenAI Codex requests. `priority` requests the provider's priority service and `flex` requests flex service. Availability, billing, and rejection behavior remain provider-account concerns. Other providers do not currently use this setting.

## Reloading changes

Run `/reload` while the TUI session is idle after editing personas, skills, or project context. Reload re-discovers the effective catalog and rebuilds the current session prompt and tools.

If the current persona ID still exists, Tau applies its newly loaded definition. This can reset runtime settings such as reasoning or service tier to the definition's values. If the ID disappeared, Tau selects the first effective persona. Existing session messages remain; changing a persona does not rewrite prior model-facing history.

A reload does not alter a turn already in progress, and the TUI refuses the operation while one is running. Existing live subagent threads retain the runtime with which they were created; newly spawned subagents inherit the reloaded persona. See [subagents](subagents.md).

## Validation and common mistakes

An invalid persona is skipped and reported as a configuration warning. Other valid personas still load. Frequent causes are:

- malformed YAML, missing frontmatter delimiters, or frontmatter that is not an object;
- missing `id`, `provider`, `model`, or a non-empty prompt body;
- an `id` that does not exactly match the filename;
- an unknown provider or an unresolved model;
- an invalid reasoning effort or service tier;
- an unknown persona tool.

`/reload` surfaces warning paths directly in the transcript. For a new local TUI session, `tau --debug --persona <id>` shows the selected model, settings, skills, subagents, tools, and complete effective prompt. If a remote edit appears to have no effect, confirm the session execution environment and `cwd` before changing another copy of the file. [Troubleshooting](troubleshooting.md) covers that check in more detail.
