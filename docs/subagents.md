# Subagents

Subagents are host-supervised background agent threads created by the main agent. They are useful when work can proceed independently or needs a separate context. A subagent is not a second session and does not have its own persona file.

## Background workers

Subagents are general-purpose background workers with no named types. Multiple instances can run concurrently, each with its own task and conversation.

The worker inherits the active main persona's model-facing behavior through Tau's maintained wrapper. Its instructions and description are not configuration surfaces. Supply task-specific instructions in the launch prompt, including any relevant skill guidance.

Availability follows the main persona's tool list. Built-in personas and standalone custom personas that omit `tools` enable the five supervision tools. A custom persona can prevent launches by providing an explicit `tools` list without `spawn_agent`; omit all five supervision tools when no subagent interaction is wanted. There is no separate subagent enable or disable setting. See [personas](personas.md).

## Trigger sensitivity

The main agent launches subagents only when the user or active instructions explicitly request delegation. Ask for a subagent in ordinary language; no named agent tag is needed. A request does not itself create a thread: the main agent still calls `spawn_agent`.

This is agent-facing policy. The host validates launches but does not infer whether a prompt semantically authorized delegation.

## Tool inheritance and restriction

The eligible inherited tools are:

- `bash`
- `write`
- `edit`
- `view_image`
- `web`
- `history`
- `nook`, when Nook is configured
- `mcp`, when the host has enabled MCP servers

Tau then adds intrinsic `tau_docs` to every subagent registry, independently of this subset. A persona’s `tools` list cannot disable it. Apart from `tau_docs`, subagents do not receive goal controls, subagent supervision tools, client tools, or TUI-local tools.

The worker inherits the intersection of the main persona's tools and those eight eligible names. MCP uses the parent's shared host connections, independent of the child's working directory. For example, a main persona with `bash`, `edit`, `history`, and `spawn_agent` gives the child `bash`, `edit`, and `history`, plus intrinsic `tau_docs`. There is no separate child tool allowlist.

Subagents cannot launch other subagents: supervision tools are never included in a child's registry. See [tools](tools.md) for the broader availability contract.

## Models and settings

By default, a new subagent inherits the active persona's model and complete settings, including reasoning and service tier. This inheritance is captured when the thread is created. Later persona or reasoning changes do not reconfigure that existing thread.

A launch override must use exact form:

```text
<provider>/<model>:<effort>
```

The provider is normalized to lowercase. The model ID remains exact and case-sensitive. Effort is one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

The configured launch-model list is an allowlist, not a default selection. The main agent should normally omit the `model` argument to `spawn_agent`; when omitted, the subagent inherits the active persona model and reasoning. When supplied, the normalized value must exactly match an entry in the configured allowlist. The override changes provider, model, and reasoning. Other inherited settings remain.

Model IDs may be unbundled when their provider is known, following the synthesis rules in [models](models.md). Invalid provider, model, effort, or format rejects the configuration field. Duplicate normalized entries are removed.

### Allowing model overrides

Configure the built-in worker’s launch allowlist through `subagents.launchModels` in `config.json`:

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

This list is layered configuration. The nearest defined `launchModels` array replaces the broader array rather than appending to it. Tau applies the effective list to every persona that exposes `spawn_agent`.

## Working-directory context

`spawn_agent` normally runs the child in the main session's `cwd`. Its optional `workingDirectory` may be absolute or relative to that `cwd`; Tau resolves it to an absolute execution-environment path.

When the resolved path differs from the parent `cwd`, Tau rebuilds prompt context from that target directory. It discovers the target platform and repository metadata, reads applicable `AGENTS.md` and configured context files, discovers target skills, and filters those skills through the parent persona's skill selection.

The target directory does **not** select a different persona, model catalog, runtime configuration, credential source, or tool policy for the child. Those remain under parent-session authority. Target configuration is consulted only where needed to rebuild target prompt context, such as target `agentContextFiles` and skill discovery.

This distinction matters in monorepos and hosted environments. `workingDirectory` is an execution-environment path. The host and attached client must not reinterpret it against their own filesystems.

A launch is blocked if Tau cannot build target context, the directory is invalid for the backend, or working-directory resolution is unavailable. Passing `.` or another path that resolves to the existing parent `cwd` reuses the already composed parent context.

## Lifecycle and supervision tools

Subagent threads are addressed by host-generated IDs. IDs identify individual live thread records.

### Spawn

`spawn_agent` accepts a title, prompt, optional launch model, and optional working directory. The prompt is the child's only initial user input, so it should be self-contained. A successful call returns immediately with the new ID while the child continues in the background.

At most eight subagent runs may be active concurrently within one main session. Completed or interrupted idle threads do not consume active capacity.

### Observe and wait

`list_agents` returns every retained thread with its ID, name, title, runtime model and reasoning, working directory, run state, context usage, cost, and response availability. Use it to rediscover an ID or inspect progress.

`wait_for_agents` accepts one or more IDs. It returns as soon as at least one requested thread finishes, and includes current state for all requested IDs. A completed response remains readable through later waits until a follow-up run replaces that retained response.

The host also publishes bounded live subagent activity to observing clients. That activity is presentation state, not a replacement for the final response returned by supervision tools.

### Follow up

`send_input_to_agent` starts another run on an existing idle thread. The thread retains its conversation state, model, settings, tools, and working directory. It must finish or be interrupted before another input is accepted.

Starting a follow-up replaces the previously retained response in the thread's latest-run state. Read any needed result before sending the next input. Follow-ups do not reread a changed persona definition or adopt a newly reloaded launch allowlist.

### Interrupt

`interrupt_agent` requests interruption of the current run and waits for its latest state. The thread remains available for follow-up input. Calling it on an already idle thread simply returns that state.

The TUI can also interrupt the selected running subagent with `Ctrl+G`. Interrupting the main session and interrupting a child are separate actions.

## Detach, rewind, and recovery

Subagents are owned by the live host session, not by an observing TUI. Detaching a client or losing an attach transport does not by itself stop children while the hosted session remains alive. Another observer can reconnect to that live session and see current projected state.

Subagent runtimes are not recoverable across host-session disposal or process recovery. Tau may persist projected agent status while the session is live, but recovery removes those records and agent-owned presentation because the underlying conversation runtimes no longer exist. A recovered session cannot send follow-up input to an old subagent ID.

Rewind also removes subagent threads whose spawning assistant message is no longer in active history. Host shutdown or session disposal interrupts and disposes all child runtimes.

Plan durable work accordingly. Important conclusions should be returned to the main agent and committed to ordinary session history or project files before the live host disappears. [Sessions](sessions.md) explains persistence and recovery more broadly.

## Reloading and validation

Persona tool selections and launch-policy changes take effect after `/reload` in an idle TUI session or in a newly created session. Reload updates new launches without reconfiguring already spawned threads. Follow-ups continue on their captured runtime.

`subagents.launchModels` must be a string array of valid `<provider>/<model>:<effort>` values. Unknown providers, invalid efforts, and malformed entries produce configuration diagnostics.

At execution time, launches can be blocked by invalid arguments, a model outside the allowlist, exhausted concurrency, missing prompt composition, or target-context failure. Follow-up, wait, and interrupt calls reject unknown IDs; follow-up also rejects a thread that is still running.

Use `tau --debug --persona <id>` before starting a local TUI to inspect effective tool availability, inherited model and settings, and the child tool list. In a running session, `/reload` reports file warnings and `list_agents` shows live thread state.
