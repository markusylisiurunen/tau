# Subagents

Subagents are background agents that the main agent starts and the host supervises. They help when part of the work can run independently or benefits from a separate context. A subagent belongs to its parent session. It is not a session of its own and has no persona file.

## Background workers

Subagents are general-purpose workers. There are no named types. Several can run at once, each with its own task and conversation.

A subagent behaves like the active main persona, wrapped in instructions that Tau maintains. Those instructions and the subagent's description cannot be configured. Put task-specific instructions, including any relevant skill guidance, in the launch prompt.

Whether the agent can start subagents depends on the main persona's tool list. Built-in personas, and custom personas that omit `tools`, enable all five subagent tools. A custom persona with a `tools` list that lacks `spawn_agent` cannot start subagents. Leave out all five subagent tools when no subagent interaction is wanted. There is no other setting to turn subagents on or off. See [personas](personas.md).

## Trigger sensitivity

The main agent starts subagents only when the user or active instructions explicitly ask for delegation. Ask in ordinary language; no special tag is needed. The request itself does not create a subagent: the main agent still has to call `spawn_agent`.

The agent follows this rule itself. Tau checks that a launch is valid, but it does not judge whether the request really asked for delegation.

## Tools

A subagent can receive these tools:

- `bash`
- `write`
- `edit`
- `view_image`
- `web`
- `history`
- `nook`, when Nook is configured
- `mcp`, when the host has enabled MCP servers
- `models`

A subagent gets each of these that the main persona also has. For example, a main persona with `bash`, `edit`, `history`, and `spawn_agent` gives its subagents `bash`, `edit`, and `history`. Names such as `web` and `history` enable the matching capability in the subagent's `code` tool. MCP uses the host's existing connections, whatever the subagent's working directory. There is no separate tool list for subagents.

Every subagent also gets the built-in `tau_docs` tool, and a persona's `tools` list cannot remove it. Subagents never get the subagent tools, client tools, or TUI tools, so a subagent cannot start subagents of its own. See [tools](tools.md) for how tool availability works in general.

## Models and settings

By default, a new subagent uses the active persona's model and all of its settings, including reasoning and service tier. These are fixed when the subagent starts. Later persona or reasoning changes do not affect it.

A model override uses this exact form:

```text
<provider>/<model>:<effort>
```

The provider is lowercased. The model ID is kept exactly as written and is case-sensitive. Effort is one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

The configured list of launch models is an allowlist. It does not choose a default. The main agent should normally omit the `model` argument to `spawn_agent`, and the subagent then uses the active persona's model and reasoning. When `model` is given, it must exactly match an allowlist entry after normalization. The override changes the provider, model, and reasoning, and keeps the other settings.

A model ID may be missing from the catalog if its provider is known (see [models](models.md)). An entry with an invalid provider, model, effort, or format makes the configuration field invalid. Duplicate entries are removed.

### Allowing model overrides

Configure the allowlist with `subagents.launchModels` in `config.json`:

```json
{
  "subagents": {
    "launchModels": [
      "anthropic/claude-haiku-4-5:low",
      "openai/gpt-6.1-sol:high"
    ]
  }
}
```

The nearest `launchModels` list replaces broader ones; lists are not combined. The resulting list applies to every persona that has `spawn_agent`.

## Working directory

`spawn_agent` normally runs the subagent in the main session's `cwd`. The optional `workingDirectory` may be absolute or relative to that `cwd`. Tau resolves it to an absolute path on the execution environment.

When that path differs from the parent's `cwd`, Tau rebuilds the subagent's context for the new directory. It detects the platform and repository there, reads the applicable `AGENTS.md` files, and discovers that directory's skills.

The new directory does **not** change the subagent's persona, model catalog, runtime configuration, credentials, or tool policy. Those always come from the parent session. Configuration in the new directory is read only where context needs it, such as for skill discovery.

`workingDirectory` is always a path on the execution environment, which matters in monorepos and hosted environments. The host and attached clients never resolve it against their own filesystems.

A launch fails if Tau cannot build context for the directory, if the directory is invalid for the environment, or if the environment cannot resolve working directories. A path that resolves to the parent's `cwd`, such as `.`, reuses the parent's context.

## Lifecycle and subagent tools

Each subagent has an ID that the host generates.

### Spawn

`spawn_agent` takes a title, a prompt, an optional model, and an optional working directory. The prompt is the subagent's only initial input, so it should be self-contained. The call returns right away with the new ID, and the subagent keeps working in the background.

At most eight subagents can be running at once in one main session. Subagents that have finished or been interrupted do not count toward this limit.

### Observe and wait

`list_agents` returns every subagent with its ID, name, title, model and reasoning, working directory, run state, context usage, cost, and whether a response is ready. Use it to find an ID again or to check progress.

`wait_for_agents` takes one or more IDs. It returns as soon as at least one of them finishes, with the current state of all of them. A finished response stays readable through later waits until a follow-up run replaces it.

The host also sends live subagent activity to attached clients for display. It is a summary for display, and the final response from these tools remains the real result.

### Follow up

`send_input_to_agent` starts another run on an idle subagent. The subagent keeps its conversation, model, settings, tools, and working directory. It must finish or be interrupted before it accepts more input.

A follow-up replaces the subagent's previous response, so read anything you need first. Follow-ups do not pick up a changed persona definition or a reloaded allowlist.

### Interrupt

`interrupt_agent` asks the current run to stop and waits for the subagent's latest state. The subagent stays available for follow-up input. On an idle subagent, the call just returns its state.

In the TUI, `Ctrl+G` interrupts the selected running subagent. Interrupting the main session does not interrupt subagents, and interrupting a subagent does not interrupt the main session.

## Detach, rewind, and recovery

Subagents belong to the running session on the host, not to an attached TUI. Detaching a client, or losing the connection, does not stop them while the session stays alive. Another client can attach to the session and see their current state.

Subagents do not survive the end of a session on the host or a host restart. Their status may be saved while the session is live, but recovery removes those records, because the subagents' conversations no longer exist. A recovered session cannot send input to an old subagent ID.

Rewind also removes subagents that were started by an assistant message the rewind removed. Host shutdown or session disposal interrupts and removes all subagents.

Plan long work with this in mind. Important results should reach the main agent and end up in the session history or in project files before the session on the host goes away. [Sessions](sessions.md) covers saving and recovery in general.

## Reloading and validation

Changes to persona tools or to the launch allowlist apply after `/reload` in an idle session, or in a new session. Reload affects only new launches. Running subagents, and follow-ups to them, keep their existing setup.

`subagents.launchModels` must be an array of valid `<provider>/<model>:<effort>` strings. Unknown providers, invalid efforts, and malformed entries produce configuration warnings.

A launch can fail because of invalid arguments, a model outside the allowlist, the concurrency limit, a prompt that cannot be built, or a working directory whose context cannot be built. Follow-up, wait, and interrupt calls reject unknown IDs. A follow-up also fails while the subagent is still running.

Before starting a local TUI, `tau --debug --persona <id>` shows which tools are available, the model and settings subagents inherit, and the subagents' tool list. In a running session, `/reload` reports file warnings and `list_agents` shows live subagent state.
