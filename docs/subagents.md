# Subagents

Subagents are background agents that the main agent starts and the host supervises. They help when part of the work can run independently or benefits from a separate context. A subagent belongs to its parent session. It is not a session of its own and has no persona file.

## Background workers

Subagents are general-purpose workers. There are no named types. Several can run at once, each with its own task and conversation.

A native Tau subagent works like a main agent of the active persona in the subagent's working directory. Its system prompt is the one a main agent would get there, with the same persona prompt, skills, project instructions, and environment context. Tau adds a short section in front that explains the subagent's role: work headless on the part of the main agent's task given in the assignment, treat later messages as coming from the main agent, wait for background work its answer depends on, never start other agents, leave contact with the user to the main agent, and return a self-contained result. The section also gives the parent session's ID. This section cannot be configured. Put task-specific instructions in the launch prompt.

Whether the agent can start subagents depends on the main persona's tool list. The `agents` tool name enables `tau.agents` in the `code` tool and the `wait_for_agents` tool. Built-in personas, and custom personas that omit `tools`, include it. A custom persona with a `tools` list that lacks `agents` cannot start or manage subagents. There is no other setting to turn subagents on or off. See [personas](personas.md).

## Trigger sensitivity

The main agent starts subagents only when the user or active instructions explicitly ask for delegation. Ask in ordinary language; no special tag is needed. The request itself does not create a subagent: the main agent still has to call `tau.agents.spawn`.

The agent follows this rule itself. Tau checks that a launch is valid, but it does not judge whether the request really asked for delegation.

## Tools

A native Tau subagent can receive these tools. [Claude Code subagents](#claude-code-subagents) use the corresponding Claude Code tools instead:

- `bash`
- `write`
- `edit`
- `view_image`
- `web`
- `history`
- `mcp`, when the host has enabled MCP servers
- `models`

A subagent gets each of these that the main persona also has. For example, a main persona with `bash`, `edit`, `history`, and `agents` gives its subagents `bash`, `edit`, and `history`. Names such as `web` and `history` enable the matching capability in the subagent's `code` tool. MCP uses the host's existing connections, whatever the subagent's working directory. There is no separate tool list for subagents.

Every native Tau subagent also gets the built-in `tau_docs` tool, and a persona's `tools` list cannot remove it. Subagents never get `agents`: their `code` tool has no `tau.agents`, and they have no `wait_for_agents`. A subagent cannot start or manage other agents.

Subagents also never get [client tools](client-tools.md), such as the TUI's tools or a Telegram runner's file delivery tools. Only the main agent uses tools that attached clients offer. See [tools](tools.md) for how tool availability works in general.

## Models and settings

By default, a new subagent uses the active persona's model and all of its settings, including reasoning and service tier. These are fixed when the subagent starts. Later persona or reasoning changes do not affect it.

A model override uses this exact form:

```text
<provider>/<model>:<effort>
```

The provider is lowercased. The model ID is kept exactly as written and is case-sensitive. Effort is one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

The configured list of launch models is an allowlist. It does not choose a default. The main agent should normally omit the `model` option of `tau.agents.spawn`, and the subagent then uses the active persona's model and reasoning. When `model` is given, it must exactly match an allowlist entry after normalization. For native Tau subagents, the override changes the provider, model, and reasoning, and keeps the other settings.

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

The nearest `launchModels` list replaces broader ones; lists are not combined. The resulting list applies to every persona that has `agents`.

## Claude Code subagents

The `claude-code` launch provider runs Claude Code through Anthropic's Agent SDK. The main agent manages these workers with the same `tau.agents` methods and `wait_for_agents` tool as native Tau subagents. Claude Code models are available only as explicit subagent launch overrides.

Install Claude Code on the session's execution environment, put `claude` on its login-shell `PATH`, and sign in there with a Claude subscription. A login on the host or attached laptop does not reach a separate execution environment. Tau includes Agent SDK 0.3.312, so no separate SDK installation is needed.

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

The worker uses Claude Code's native system prompt with a short addition: complete the task autonomously, treat later messages as coming from the parent agent, preserve other agents' work, and return a self-contained result. It cannot ask the parent or user for clarification. Tau does not copy the parent conversation, persona prompt, project instructions, or skill descriptions. The worker is instructed to follow applicable project instructions itself.

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

Tau displays short assistant updates and tool completion summaries. It also records the worker's assistant text, tool calls, and tool results in the worker's [trace](#conversation-traces), using Claude Code's own tool names, such as `Bash` and `Read`. Tau records SDK-reported assistant token usage as it arrives, so interruption preserves counts already received. Repeated message blocks and resumed messages are counted once. Final SDK totals reconcile these counts and supply cost estimates, including earlier usage when a session resumes. Cost from an interrupted run remains unavailable until the SDK reports it. The latest assistant usage supplies a context-token estimate; after a successful run, the SDK's context summary supplies the window size and a fuller measurement.

Before sending the task, Tau checks that the SDK reports a subscription login without API-key authentication. Claude Code keeps its own credentials. Tau removes API and cloud-provider routing overrides from the child environment and provides no API fallback. Fast mode is disabled. Account-level extra usage can still incur charges; disable it in Claude to use only the included subscription allowance. The SDK's dollar estimates do not report subscription charges.

Steering messages go to Claude Code through the Agent SDK's streaming input while the worker is busy. Claude Code decides when to read them, typically between tool rounds, and a tool that is already running may continue. A steering message that Claude Code has not read when its turn ends is handled in another turn. Queued messages wait until Claude Code reports that its turn is finished.

Claude workers share the eight-worker limit and the usual subagent lifetime. Interrupting a worker terminates its process group. A follow-up can resume its Claude session while the parent session remains alive. Host restart, session disposal, and rewind remove workers under the same rules as native Tau subagents. Claude's transcript files remain on disk, but Tau does not use them to restore workers after a restart.

## Working directory

`tau.agents.spawn` normally runs the subagent in the main session's `cwd`. The optional `workingDirectory` may be absolute or relative to that `cwd`. Tau resolves it to an absolute path on the execution environment.

For native Tau subagents, when that path differs from the parent's `cwd`, Tau rebuilds the subagent's context for the new directory. It detects the platform and repository there, reads the applicable `AGENTS.md` files, and discovers that directory's skills.

For native Tau subagents, the new directory does not change the persona, model catalog, runtime configuration, credentials, or tool policy. Those come from the parent session. Configuration in the new directory is read only where context needs it, such as for skill discovery.

`workingDirectory` is always a path on the execution environment, which matters in monorepos and hosted environments. The host and attached clients never resolve it against their own filesystems.

A native Tau launch fails if Tau cannot build context for the directory, if the directory is invalid for the environment, or if the environment cannot resolve working directories. A path that resolves to the parent's `cwd`, such as `.`, reuses the parent's context. Claude Code workers load context themselves in the selected directory; an invalid directory fails when the worker starts.

## Managing subagents

The main agent manages subagents with `tau.agents` inside the [`code` tool](code-mode.md), and waits for them with the `wait_for_agents` tool. Each subagent has an ID that the host generates, and one conversation that grows with each input.

| Method | Purpose |
| --- | --- |
| `spawn({ title, prompt, model?, workingDirectory? })` | Start a subagent. |
| `list()` | State of every subagent, plus the number running and the limit. |
| `read({ id })` | State of one subagent. |
| `sendInput({ id, message, mode })` | Queue or steer more input. |
| `interrupt({ id, wait? })` | Stop the current turn and discard pending input. |
| `waitUntilIdle({ id })` | Wait inside a program until the subagent is idle. |
| `trace({ id, kinds?, toolName?, limit?, cursor? })` | Read a page of the subagent's conversation. |
| `readText({ id, seq, maxChars? })` | Read the text of one assistant message or tool result. |
| `readContent({ id, ref, cursor? })` | Page through large or non-text content. |

The agent reads the complete reference, with types and examples, by printing `await tau.docs("agents")` in `code`. A program reads conversation data into JavaScript variables. Only what the program prints reaches the main agent's conversation, so the agent can select the part of a long trace it needs.

### Spawn

`spawn` takes a single-line title of at most 256 characters, a prompt of at most 262,144 characters, an optional model, and an optional working directory. The prompt is the subagent's first message, and the subagent does not see the parent conversation, so the prompt should be self-contained. The call returns right away with the subagent's state, and the subagent keeps working in the background.

When the main persona has `history`, a native Tau subagent may read the parent session's transcript as a last resort, when missing context would stop the work or force an important assumption. It reads with `tau.history.read` and `source: "local"`, so the read uses the host's local history even when a remote collection is configured. Local recording is best-effort, so the newest parent entries can occasionally be missing.

At most eight subagents can be working at once in one main session. Idle subagents do not count toward this limit.

### State and waiting

A subagent's state has its ID, title, model and reasoning, working directory, status, counts of pending queued and steering input, token usage, context size, and cost. The status is one of:

- `working`: the subagent is handling input.
- `stopping`: an interrupt was requested and the turn has not ended yet.
- `idle`: no turn is running and no input is pending. `reason` tells how the latest turn ended: `completed`, `interrupted`, or `failed`, with an error code and message for a failure.

`completed` means the turn ended normally. It does not mean the task succeeded, so the main agent reads the subagent's answer before relying on it. Background Bash and code jobs that a subagent started do not keep it working. A subagent that needs a job's result must wait for the job before it answers.

`wait_for_agents` takes one or more IDs. It returns as soon as at least one of them is idle, with JSON listing the idle IDs in `ready` and the state of every requested subagent in `agents`. It returns no conversation content. Inside a program, `waitUntilIdle` waits for one subagent with the same meaning of idle. Neither wait returns until queued input has been handled too. Cancelling a wait, or stopping the program that waits, does not interrupt the subagent.

The host also sends live subagent activity to attached clients for display. It is a summary for display. The subagent's messages and tool results are in its trace.

### Send more input

`sendInput` requires a `mode`:

- `queue`: the subagent finishes its current work, then handles the message as a separate turn. Queued messages run in the order they were sent.
- `steer`: the subagent takes the message into account as soon as possible during its current turn. A native Tau subagent applies it at the next safe point, never in the middle of a model response or tool call, as in the [main session](sessions.md#submit-queue-and-steer). [Claude Code subagents](#claude-code-subagents) follow Claude Code's own streaming-input behavior.

Either mode starts a new turn right away on an idle subagent. The call returns once the input is accepted, before the subagent reads it. The subagent keeps its conversation, model, settings, tools, and working directory. Earlier messages stay readable in its trace.

Sending input fails while the subagent is stopping, when 64 inputs are already pending, or when the subagent is idle and eight subagents are already working. Follow-up input does not pick up a changed persona definition or a reloaded allowlist.

### Interrupt

`interrupt` stops the current turn and discards all pending input, so the subagent does not continue with queued work. By default the call waits until the turn has ended. With `wait: false` it returns right away, and the status may still be `stopping`. Interrupting an idle subagent only returns its state. Background jobs that the subagent started keep running, and the subagent stays available for more input.

In the TUI, `Ctrl+G` interrupts the selected running subagent. Interrupting the main session does not interrupt subagents, and interrupting a subagent does not interrupt the main session.

### Conversation traces

Each subagent has a trace: an ordered record of what it was told, what it said, and what its tools returned. Native Tau and Claude Code subagents produce the same kinds of entries:

| Kind | Contents |
| --- | --- |
| `input` | Each message the subagent was sent, with its mode: `initial`, `queue`, or `steer`. Recorded when the message is accepted. |
| `assistant` | The subagent's message text. |
| `tool_call` | The tool name, call ID, and arguments as JSON. |
| `tool_result` | The tool name, call ID, outcome, and the result exactly as the subagent received it. |
| `notice` | An event with a machine-readable code, such as `input.discarded` after an interrupt or `compaction.compacted`. A failed turn adds a notice with the failure code. |
| `status` | The subagent started working, began stopping, or became idle. |

Traces do not contain reasoning or system prompts. A tool result that the tool itself shortened stays shortened, and the trace cannot recover the missing output.

Each entry has a sequence number `seq` and a timestamp. A `trace` call returns the newest matching entries in chronological order, 20 by default and at most 50. It can filter by entry kinds and by tool name. Its `nextCursor` leads to older entries. A cursor keeps its starting point, so new activity does not shift the pages.

Content of at most 4,096 bytes as JSON, without images, is inline in the entry. Larger content and all images are references. `readText` returns the text of one assistant message or tool result, up to 30,000 UTF-16 code units by default and at most 100,000. Its `complete` field is `false` when the text was cut or some content is unavailable. It does not detect output that the tool itself shortened. Content with JSON or images needs `readContent`, which returns one block per page. Text arrives in chunks of at most 16,384 UTF-16 code units that join to the exact text.

A trace keeps the newest 4,096 entries, up to 16 MiB, for each subagent. When older entries are removed, trace pages report `historyEvicted: true`, and reading a removed entry or reference fails. A single content value larger than 6 MiB is replaced by a block that marks it unavailable. Traces last as long as the subagent and do not survive a host restart.

These methods never call a model. When a program passes trace content to `tau.models`, the content is sent to [OpenRouter](openrouter.md).

A failed call throws an error with a `code` and a `message`. The codes are `invalid_arguments`, `unknown_agent`, `invalid_cursor`, `expired_content`, `content_type`, `operation_failed`, and `cancelled`. A subagent's own failure is part of its state and trace, not a failed call.

## Detach, rewind, and recovery

Subagents belong to the running session on the host, not to an attached TUI. Detaching a client, or losing the connection, does not stop them while the session stays alive. Another client can attach to the session and see their current state.

Subagents do not survive the end of a session on the host or a host restart. Their status may be saved while the session is live, but recovery removes those records, because their runtimes no longer exist. A recovered session cannot send input to an old subagent ID.

Rewind also removes subagents that were started by an assistant message the rewind removed. A subagent started from a `code` program belongs to the assistant message that ran the program, including a program running as a background job. Host shutdown or session disposal interrupts and removes all subagents.

Plan long work with this in mind. Important results should reach the main agent and end up in the session history or in project files before the session on the host goes away. [Sessions](sessions.md) covers saving and recovery in general.

## Reloading and validation

Changes to persona tools or to the launch allowlist apply after `/reload` in an idle session, or in a new session. Reload affects only new launches. Running subagents, and follow-ups to them, keep their existing setup.

`subagents.launchModels` must be an array of valid `<provider>/<model>:<effort>` strings. Unknown providers, invalid efforts, and malformed entries produce configuration warnings.

A launch can fail because of invalid arguments, a model outside the allowlist, the concurrency limit, a prompt that cannot be built, or a working directory whose context cannot be built. Calls with an unknown subagent ID fail. Sending input also fails under the conditions in [send more input](#send-more-input).

Before starting a local TUI, `tau --debug --persona <id>` shows which tools are available, the model and settings subagents inherit, and the subagents' tool list. In a running session, `/reload` reports file warnings and `tau.agents.list()` shows live subagent state.
