# Subagents

Subagents are background agents that the main agent starts and the host supervises. They help when part of the work can run independently or benefits from a separate context. A subagent belongs to its parent session. It is not a session of its own and has no persona file.

## Background workers

Subagents are general-purpose workers. There are no named types. Several can run at once, each with its own task and conversation.

A native Tau subagent behaves like the active main persona, wrapped in instructions that Tau maintains. Those instructions and the subagent's description cannot be configured. Put task-specific instructions, including any relevant skill guidance, in the launch prompt.

Whether the agent can start subagents depends on the main persona's tool list. Built-in personas, and custom personas that omit `tools`, enable all five subagent tools. A custom persona with a `tools` list that lacks `spawn_agent` cannot start subagents. Leave out all five subagent tools when no subagent interaction is wanted. There is no other setting to turn subagents on or off. See [personas](personas.md).

## Trigger sensitivity

The main agent starts subagents only when the user or active instructions explicitly ask for delegation. Ask in ordinary language; no special tag is needed. The request itself does not create a subagent: the main agent still has to call `spawn_agent`.

The agent follows this rule itself. Tau checks that a launch is valid, but it does not judge whether the request really asked for delegation.

## Tools

A native Tau subagent can receive these tools. [Claude Code subagents](#claude-code-subagents) use the corresponding Claude Code tools instead:

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

Every native Tau subagent also gets the built-in `tau_docs` tool, and a persona's `tools` list cannot remove it. Subagents never get the subagent tools, client tools, or TUI tools, so a subagent cannot start subagents of its own. See [tools](tools.md) for how tool availability works in general.

## Models and settings

By default, a new subagent uses the active persona's model and all of its settings, including reasoning and service tier. These are fixed when the subagent starts. Later persona or reasoning changes do not affect it.

A model override uses this exact form:

```text
<provider>/<model>:<effort>
```

The provider is lowercased. The model ID is kept exactly as written and is case-sensitive. Effort is one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

The configured list of launch models is an allowlist. It does not choose a default. The main agent should normally omit the `model` argument to `spawn_agent`, and the subagent then uses the active persona's model and reasoning. When `model` is given, it must exactly match an allowlist entry after normalization. For native Tau subagents, the override changes the provider, model, and reasoning, and keeps the other settings.

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

## Claude Code subagents

The `claude-code` launch provider runs Claude Code through Anthropic's Agent SDK. The main agent uses the usual spawn, list, wait, follow-up, and interrupt tools to manage these workers. Claude Code models are available only as explicit subagent launch overrides.

Install Claude Code on the session's execution environment, put `claude` on its login-shell `PATH`, and sign in there with a Claude subscription. A login on the host or attached laptop does not reach a separate execution environment. Tau includes Agent SDK 0.3.308, so no separate SDK installation is needed.

Add the desired model/effort combinations to the launch allowlist:

```json
{
  "subagents": {
    "launchModels": [
      "claude-code/claude-opus-5-5:medium",
      "claude-code/claude-sonnet-5-5:medium",
      "claude-code/claude-haiku-5-5:low"
    ]
  }
}
```

These are the three supported model IDs. Effort may be `low`, `medium`, `high`, `xhigh`, or `max`. Each permitted combination needs its own allowlist entry. Model availability also depends on the Claude account and installed Claude Code version. If Claude Code rejects a model, Tau reports the failure.

Claude Code manages its conversation, retries, and compaction. Each run allows up to 1,024 agentic turns. Tau passes the selected model, effort, working directory, and task. Other Tau model settings, such as service tier, do not apply. Follow-ups resume the same Claude session.

The worker uses Claude Code's native system prompt with a short addition: complete the task autonomously, preserve other agents' work, and return a self-contained result. It cannot ask the parent or user for clarification. Tau does not copy the parent conversation, persona prompt, project instructions, or skill descriptions. The worker is instructed to follow applicable project instructions itself.

Claude Code loads its user, project, and local settings and discovers its own instructions and skills. The `Skill` tool is always available. Other native tools follow the parent persona's selection:

| Inherited Tau tool | Claude Code tools      |
| ------------------ | ---------------------- |
| `bash`             | Bash, Read, Glob, Grep |
| `view_image`       | Read, Glob, Grep       |
| `write`            | Write                  |
| `edit`             | Edit                   |
| `web`              | WebSearch, WebFetch    |

Workers receive no Tau `code` capabilities, host MCP connections, `tau_docs`, or client tools. Nested agents and interactive questions are disabled. Hooks and automatic memory are disabled too. Claude Code discovers its own MCP servers from its normal configuration sources, including project and user configuration on the execution environment. These connections are independent of the parent persona's `mcp` tool selection; Tau does not map or forward its host MCP connections. Managed Claude Code policies still apply.

Selected tools use `bypassPermissions`, with Claude Code's sandbox disabled. They run with the execution environment's operating-system authority, like Tau's tools. Review the local Claude settings, skills, and MCP configuration before enabling these workers.

Tau displays short assistant updates and tool completion summaries. Full tool output stays in Claude Code's conversation files. Tau records SDK-reported assistant token usage as it arrives, so interruption preserves counts already received. Repeated message blocks and resumed messages are counted once. Final SDK totals reconcile these counts and supply cost estimates, including earlier usage when a session resumes. Cost from an interrupted run remains unavailable until the SDK reports it. The latest assistant usage supplies a context-token estimate; after a successful run, the SDK's context summary supplies the window size and a fuller measurement.

Before sending the task, Tau checks that the SDK reports a subscription login without API-key authentication. Claude Code keeps its own credentials. Tau removes API and cloud-provider routing overrides from the child environment and provides no API fallback. Fast mode is disabled. Account-level extra usage can still incur charges; disable it in Claude to use only the included subscription allowance. The SDK's dollar estimates do not report subscription charges.

Claude workers share the eight-worker limit and the usual subagent lifetime. Interrupting a worker terminates its process group. A follow-up can resume its Claude session while the parent session remains alive. Host restart, session disposal, and rewind remove workers under the same rules as native Tau subagents. Claude's transcript files remain on disk, but Tau does not use them to restore workers after a restart.

## Working directory

`spawn_agent` normally runs the subagent in the main session's `cwd`. The optional `workingDirectory` may be absolute or relative to that `cwd`. Tau resolves it to an absolute path on the execution environment.

For native Tau subagents, when that path differs from the parent's `cwd`, Tau rebuilds the subagent's context for the new directory. It detects the platform and repository there, reads the applicable `AGENTS.md` files, and discovers that directory's skills.

For native Tau subagents, the new directory does not change the persona, model catalog, runtime configuration, credentials, or tool policy. Those come from the parent session. Configuration in the new directory is read only where context needs it, such as for skill discovery.

`workingDirectory` is always a path on the execution environment, which matters in monorepos and hosted environments. The host and attached clients never resolve it against their own filesystems.

A native Tau launch fails if Tau cannot build context for the directory, if the directory is invalid for the environment, or if the environment cannot resolve working directories. A path that resolves to the parent's `cwd`, such as `.`, reuses the parent's context. Claude Code workers load context themselves in the selected directory; an invalid directory fails when the worker starts.

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

Subagents do not survive the end of a session on the host or a host restart. Their status may be saved while the session is live, but recovery removes those records, because their runtimes no longer exist. A recovered session cannot send input to an old subagent ID.

Rewind also removes subagents that were started by an assistant message the rewind removed. Host shutdown or session disposal interrupts and removes all subagents.

Plan long work with this in mind. Important results should reach the main agent and end up in the session history or in project files before the session on the host goes away. [Sessions](sessions.md) covers saving and recovery in general.

## Reloading and validation

Changes to persona tools or to the launch allowlist apply after `/reload` in an idle session, or in a new session. Reload affects only new launches. Running subagents, and follow-ups to them, keep their existing setup.

`subagents.launchModels` must be an array of valid `<provider>/<model>:<effort>` strings. Unknown providers, invalid efforts, and malformed entries produce configuration warnings.

A launch can fail because of invalid arguments, a model outside the allowlist, the concurrency limit, a prompt that cannot be built, or a working directory whose context cannot be built. Follow-up, wait, and interrupt calls reject unknown IDs. A follow-up also fails while the subagent is still running.

Before starting a local TUI, `tau --debug --persona <id>` shows which tools are available, the model and settings subagents inherit, and the subagents' tool list. In a running session, `/reload` reports file warnings and `list_agents` shows live subagent state.
