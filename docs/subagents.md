# Subagents

Subagents are host-supervised background agent threads created by the main agent. They are useful when work can proceed independently, needs a separate context, or benefits from a deliberately narrower tool set. A subagent is not a second session and does not have its own persona file. Its definition belongs to the active persona.

The persona decides which subagent names exist. The host enforces launch models, tools, working directory, concurrency, follow-up state, interruption, and cleanup.

## The built-in `default` subagent

Tau provides one built-in subagent named `default`. It is a general-purpose background worker and has explicit trigger sensitivity. Built-in personas enable it, and a standalone custom persona also enables it when `subagents` is omitted.

The `default` subagent inherits the active main persona's model-facing behavior through Tau's maintained wrapper. Its wrapper and built-in prompt are implementation-owned and are not configuration surfaces. It cannot be overridden in persona frontmatter.

Disable it explicitly when a persona should expose only named custom workers or no subagents:

```yaml
subagents:
  default: false
```

If `subagents` is omitted by a persona that extends a built-in, Tau inherits the base persona's entire subagent map. If a persona supplies a `subagents` map, Tau builds a new map from it and adds `default` unless the map says `default: false`.

## Defining custom subagents

Custom definitions live under `subagents` in a [persona](personas.md):

```yaml
subagents:
  default: false
  dependency-auditor:
    description: Audit dependency changes and report concrete risks. Trigger: explicit.
    systemPrompt: >-
      Inspect the requested dependency change. Verify lockfile and release implications,
      then return prioritized findings with paths.
    tools:
      - bash
      - history
    launchModels:
      - anthropic/claude-haiku-4-5:low
      - openai/gpt-5.6-sol:high
```

A custom subagent name must:

- contain 1 to 64 characters;
- use lowercase letters and digits;
- use single dashes between segments; and
- begin and end with a letter or digit.

`dependency-auditor` and `review2` are valid. `DependencyAuditor`, `dependency_auditor`, and `-review` are not.

Each custom definition accepts:

| Field | Contract |
| --- | --- |
| `systemPrompt` | Required non-empty string containing the subagent's base instructions. |
| `description` | Optional non-empty catalog description. Include trigger sensitivity here when needed. |
| `tools` | Optional list of eligible subagent tools. Omission inherits eligible tools from the main persona. |
| `launchModels` | Optional allowlist of exact model overrides accepted by `spawn_agent`. |

Unknown fields are discarded. In particular, `provider`, `model`, `reasoning`, and `serviceTier` inside a subagent definition do not configure its runtime. Use `launchModels` for approved launch-time model changes.

A custom entry cannot be `false`; only `default: false` has disable semantics. Every custom entry requires `systemPrompt`.

## Trigger sensitivity

Trigger sensitivity is expressed in the `description`, not in a separate field:

- **eager**: use proactively whenever the capability would help;
- **balanced**: use when the request clearly matches, which is the default when no trigger is stated;
- **explicit**: use only when an active instruction names the subagent.

Use a clear phrase such as `Trigger: explicit.`. An exact user reference looks like:

```text
@@agent:dependency-auditor
```

An exact reference in the user request, an active `AGENTS.md` instruction, or the instructions of an already-active skill explicitly activates that subagent. A subagent reference tells the main agent which capability to use; it does not itself create a thread. The main agent still calls `spawn_agent`.

Trigger sensitivity is agent-facing policy. The host enforces whether the named subagent exists, but it does not infer whether a prompt semantically satisfied `eager`, `balanced`, or `explicit`.

## Tool inheritance and restriction

The persona-configurable subagent tool subset contains only:

- `bash`
- `write`
- `edit`
- `view_image`
- `web`
- `history`

Tau then adds intrinsic `tau_docs` to every subagent registry, independently of this subset. Neither a persona nor a subagent `tools` list can disable it. Apart from `tau_docs`, subagents do not receive Nook, goal controls, subagent supervision tools, client tools, or TUI-local tools.

When `tools` is omitted, Tau filters the main persona's tool list to the eligible names above. For example, a main persona with `bash`, `edit`, `history`, and `spawn_agent` gives an omitted subagent list of `bash`, `edit`, and `history`.

An explicit `tools` list replaces inheritance. It may select any of the six eligible subagent tools, even if that name is absent from the main persona's own list. Use `tools: []` for a worker with no persona-configurable tools; it still receives `tau_docs`. Names are normalized to lowercase, duplicate entries are removed, and an unknown name rejects the containing persona.

The main persona must itself expose the subagent supervision tools for the model to operate subagents. Defining a subagent while omitting `spawn_agent` from an explicit persona `tools` list leaves the definition present but not launchable by the main agent. See [tools](tools.md) for the broader availability contract.

## Models and settings

By default, a new subagent inherits the active persona's model and complete settings, including reasoning and service tier. This inheritance is captured when the thread is created. Later persona or reasoning changes do not reconfigure that existing thread.

A launch override must use exact form:

```text
<provider>/<model>:<effort>
```

The provider is normalized to lowercase. The model ID remains exact and case-sensitive. Effort is one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

`launchModels` is an allowlist, not a default selection. The main agent should normally omit the `model` argument to `spawn_agent`; when omitted, the subagent inherits the active persona model and reasoning. When supplied, the normalized value must exactly match an entry in the selected subagent's allowlist. The override changes provider, model, and reasoning. Other inherited settings remain.

Model IDs may be unbundled when their provider is known, following the synthesis rules in [models](models.md). Invalid provider, model, effort, or format rejects the persona during content loading. Duplicate normalized entries are removed.

### Allowing overrides for `default`

The built-in `default` definition cannot be edited in persona frontmatter. Configure its launch allowlist through `subagents.defaultLaunchModels` in `config.json`:

```json
{
  "subagents": {
    "defaultLaunchModels": [
      "anthropic/claude-haiku-4-5:low",
      "openai/gpt-5.6-sol:high"
    ]
  }
}
```

This list is layered configuration. The nearest defined `defaultLaunchModels` array replaces the broader array rather than appending to it. Tau applies the effective list to every persona that currently enables `default`; it does not add `default` to a persona that disabled it.

## Working-directory context

`spawn_agent` normally runs the child in the main session's `cwd`. Its optional `workingDirectory` may be absolute or relative to that `cwd`; Tau resolves it to an absolute execution-environment path.

When the resolved path differs from the parent `cwd`, Tau rebuilds prompt context from that target directory. It discovers the target platform and repository metadata, reads applicable `AGENTS.md` and configured context files, discovers target skills, and filters those skills through the parent persona's skill selection.

The target directory does **not** select a different persona, subagent definition, model catalog, runtime configuration, credential source, or tool policy for the child. Those remain under parent-session authority. Target configuration is consulted only where needed to rebuild target prompt context, such as target `agentContextFiles` and skill discovery.

This distinction matters in monorepos and hosted environments. `workingDirectory` is an execution-environment path. The host and attached client must not reinterpret it against their own filesystems.

A launch is blocked if Tau cannot build target context, the directory is invalid for the backend, or working-directory resolution is unavailable. Passing `.` or another path that resolves to the existing parent `cwd` reuses the already composed parent context.

## Lifecycle and supervision tools

Subagent threads are addressed by host-generated IDs. Names identify configurations; IDs identify live thread records.

### Spawn

`spawn_agent` validates the configured name, optional launch model, title, prompt, and working directory. The prompt is the child's only initial user input, so it should be self-contained. A successful call returns immediately with the new ID while the child continues in the background.

At most eight subagent runs may be active concurrently within one main session. Completed or interrupted idle threads do not consume active capacity.

### Observe and wait

`list_agents` returns every retained thread with its ID, name, title, runtime model and reasoning, working directory, run state, context usage, cost, and response availability. Use it to rediscover an ID or inspect progress.

`wait_for_agents` accepts one or more IDs. It returns as soon as at least one requested thread finishes, and includes current state for all requested IDs. A completed response remains readable through later waits until a follow-up run replaces that retained response.

The host also publishes bounded live subagent activity to observing clients. That activity is presentation state, not a replacement for the final response returned by supervision tools.

### Follow up

`send_input_to_agent` starts another run on an existing idle thread. The thread retains its conversation state, model, settings, tools, and working directory. It must finish or be interrupted before another input is accepted.

Starting a follow-up replaces the previously retained response in the thread's latest-run state. Read any needed result before sending the next input. Follow-ups do not reread a changed persona definition or adopt a newly reloaded launch model.

### Interrupt

`interrupt_agent` requests interruption of the current run and waits for its latest state. The thread remains available for follow-up input. Calling it on an already idle thread simply returns that state.

The TUI can also interrupt the selected running subagent with `Ctrl+G`. Interrupting the main session and interrupting a child are separate actions.

## Detach, rewind, and recovery

Subagents are owned by the live host session, not by an observing TUI. Detaching a client or losing an attach transport does not by itself stop children while the hosted session remains alive. Another observer can reconnect to that live session and see current projected state.

Subagent runtimes are not recoverable across host-session disposal or process recovery. Tau may persist projected agent status while the session is live, but recovery removes those records and agent-owned presentation because the underlying conversation runtimes no longer exist. A recovered session cannot send follow-up input to an old subagent ID.

Rewind also removes subagent threads whose spawning assistant message is no longer in active history. Host shutdown or session disposal interrupts and disposes all child runtimes.

Plan durable work accordingly. Important conclusions should be returned to the main agent and committed to ordinary session history or project files before the live host disappears. [Sessions](sessions.md) explains persistence and recovery more broadly.

## Reloading and validation

Persona and global launch-policy changes take effect after `/reload` in an idle TUI session or in a newly created session. Reload updates which subagent definitions new `spawn_agent` calls see. It does not kill, rename, or reconfigure already spawned threads, and follow-ups continue on their captured runtime.

An invalid subagent definition rejects its containing persona. Common content warnings include:

- a name outside the lowercase-dash contract or longer than 64 characters;
- `subagents` that is not an object;
- `default` set to anything other than `false`;
- a custom entry set to `false` or missing `systemPrompt`;
- blank descriptions, prompts, or list entries;
- unknown subagent tools;
- `launchModels` or `defaultLaunchModels` that is not a string array; and
- an unknown provider or model, invalid effort, or malformed `<provider>/<model>:<effort>` value.

At execution time, launches can still be blocked by an unenabled name, a model outside the allowlist, exhausted concurrency, invalid arguments, missing prompt composition, or target-context failure. Follow-up, wait, and interrupt calls reject unknown IDs; follow-up also rejects a thread that is still running.

Use `tau --debug --persona <id>` before starting a local TUI to inspect effective subagent names, inherited model and settings, and tool lists. It does not reveal managed prompt bodies for built-in subagents. In a running session, `/reload` reports exact file warnings and `list_agents` verifies live runtime choices.
