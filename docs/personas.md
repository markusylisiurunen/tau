# Personas

A persona is Tau's complete model-facing working profile. It chooses a provider and model, supplies the base system prompt, sets reasoning and service behavior, and selects tools, skills, and subagents. Changing persona changes how future turns run without creating a new session.

Tau ships generated built-in personas and discovers custom persona Markdown from the execution environment. The effective list is version-specific and scope-specific, so inspect the current catalog rather than relying on a memorized list of names.

## Built-in and effective personas

Built-in personas are generated from Tau's current model catalog. Most model families have separate chat and coder variants; some families expose only the variants Tau supports. Built-ins carry Tau-maintained prompts, defaults, tool selections, skills, and the built-in `default` subagent.

Set `disableBuiltinPersonas: true` in `config.json` to omit built-ins from the effective catalog. Custom personas can also replace a built-in by using the same ID. A shipped built-in is therefore not necessarily available in a particular session.

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

A persona is Markdown with YAML frontmatter. `id`, `provider`, and `model` are required. The Markdown body is the persona's base system prompt.

```markdown
---
id: release-coder
label: release coder
description: Prepares and verifies repository releases.
provider: anthropic
model: claude-opus-5
reasoning: high
allowedReasoningLevels:
  - medium
  - high
  - xhigh
skills:
  - release-check
tools:
  - bash
  - write
  - edit
  - view_image
  - web
  - history
subagents:
  default: false
  verifier:
    description: Verify release state independently. Trigger: balanced.
    systemPrompt: Verify the requested release state and report concrete blockers.
    tools:
      - bash
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

`provider` and `model` are required even when the persona extends a built-in. Tau does not inherit them because selecting a model is the persona's central explicit contract.

### Optional fields

| Field | Contract |
| --- | --- |
| `extends` | ID of a shipped built-in persona whose optional behavior is used as a base. |
| `label` | Display label. A blank or omitted label falls back to the base label or `custom`. |
| `description` | Short catalog description. |
| `reasoning` | Default effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `serviceTier` | `priority` or `flex`. Currently meaningful for `openai` and `openai-codex`. |
| `allowedReasoningLevels` | Array of reasoning efforts offered by the TUI selector. |
| `skills` | `"*"`, a list of discovered skill names, or `[]`. |
| `tools` | Explicit list of persona-controlled tools. |
| `subagents` | Map of enabled subagent definitions. |

If a standalone custom persona omits `skills`, Tau selects all discovered skills with `"*"`. If it omits `subagents`, Tau enables the built-in `default` subagent. Tool defaults then include the ordinary host tools plus subagent supervision tools. See [skills](skills.md) and [subagents](subagents.md) for those contracts.

The persona-controlled tool names are:

- `bash`, `write`, `edit`, `view_image`, `web`, `nook`, and `history`;
- `spawn_agent`, `send_input_to_agent`, `wait_for_agents`, `list_agents`, and `interrupt_agent`.

An explicit `tools` array replaces defaults. Names are normalized to lowercase, duplicates are removed, and unknown names reject the persona. `tools: []` leaves the persona without these persona-controlled tools. Some host capabilities, such as goal management, are supplied independently of this list. Listing `nook` does not make it usable without effective Nook configuration. [Tools](tools.md) explains eligibility and ownership.

## Extending a built-in

`extends` reuses one shipped built-in persona as a base while still requiring an explicit provider and model:

```markdown
---
id: concise-haiku-coder
extends: opus-5-coder
provider: anthropic
model: claude-haiku-4-5
reasoning: low
---
```

Because the body is empty, this persona inherits the built-in's base prompt. It also inherits the base label, description, settings not explicitly overridden, allowed reasoning levels, skills, tools, and subagent map.

Important boundaries are:

- `extends` resolves shipped built-ins, not another custom persona.
- Lookup of the built-in ID is case-insensitive.
- It remains available as an inheritance base even when `disableBuiltinPersonas` hides built-ins from the effective catalog.
- A non-empty Markdown body replaces the inherited base prompt.
- Explicit `skills` or `tools` replaces the inherited selection.
- Explicit `subagents` builds a new subagent map rather than merging custom entries into the inherited map. Unless that map contains `default: false`, Tau adds the built-in `default` subagent.
- `reasoning` and `serviceTier` override their individual inherited settings; omitted settings remain inherited.

Extending a built-in is useful when Tau's maintained behavior is the desired base. A standalone body is more stable when the persona must not change as Tau updates its built-in prompts.

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

An empty `allowedReasoningLevels` does not create an empty selector. For an extending persona it falls back to inherited levels; otherwise the TUI uses its normal model-aware choices.

`serviceTier` is passed with supported OpenAI and OpenAI Codex requests. `priority` requests the provider's priority service and `flex` requests flex service. Availability, billing, and rejection behavior remain provider-account concerns. Other providers do not currently use this setting.

## Reloading changes

Run `/reload` while the TUI session is idle after editing personas, `models.json`, skills, or project context. Reload re-discovers the effective catalog and rebuilds the current session prompt and tools.

If the current persona ID still exists, Tau applies its newly loaded definition. This can reset runtime settings such as reasoning or service tier to the definition's values. If the ID disappeared, Tau selects the first effective persona. Existing session messages remain; changing a persona does not rewrite prior model-facing history.

A reload does not alter a turn already in progress, and the TUI refuses the operation while one is running. Existing live subagent threads retain the runtime with which they were created; newly spawned subagents use the reloaded persona definition. See [subagents](subagents.md).

## Validation and common mistakes

An invalid persona is skipped and reported as a configuration warning. Other valid personas still load. Frequent causes are:

- malformed YAML, missing frontmatter delimiters, or frontmatter that is not an object;
- missing `id`, `provider`, or `model`;
- an `id` that does not exactly match the filename;
- an unknown provider or an unresolved model;
- an `extends` target that is not a shipped built-in;
- an invalid reasoning effort or service tier;
- `skills` that is neither `"*"` nor a string list, or contains a blank entry;
- an unknown persona tool;
- an invalid subagent name, missing custom `systemPrompt`, unsupported subagent tool, or invalid launch model; and
- attempting to override the built-in `default` subagent instead of using `default: false`.

`/reload` surfaces warning paths directly in the transcript. For a new local TUI session, `tau --debug --persona <id>` shows the selected model, settings, skills, subagents, tools, and complete effective prompt. If a remote edit appears to have no effect, confirm the session execution environment and `cwd` before changing another copy of the file. [Troubleshooting](troubleshooting.md) covers that check in more detail.
