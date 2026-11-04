# Subagents

Subagents are background agents that the host supervises. The main agent can start them, and a native Tau subagent can start its own. They help when part of the work can run independently or benefits from a separate context. A subagent belongs to the session it runs in. It has no saved session of its own and no persona file.

## Background workers

Subagents are general-purpose workers. There are no named types. Several can run at once, each with its own task and conversation.

A native Tau subagent works like a main agent of the active persona in the subagent's working directory. Its system prompt is the one a main agent would get there, with the same persona prompt, skills, project instructions, and environment context. Tau adds a short section in front that explains the subagent's role: work headless on its assignment, wait for work its answer depends on, delegate only when it can and is asked to, leave contact with the user to its parent, and return a self-contained result. The section also lists the session IDs from the main agent down to the subagent. This section cannot be configured. Put task-specific instructions in the launch prompt.

Whether the agents in a session can start subagents depends on the main persona's tool list. The `agents` tool name enables `tau.agents` in the `code` tool and the `wait_for_agents` tool. Built-in personas, and custom personas that omit `tools`, include it. A custom persona with a `tools` list that lacks `agents` cannot start or manage subagents, and neither can anything below it. There is no other setting to turn subagents on or off. See [personas](personas.md).

## Levels and access

Each subagent records its parent and its depth below the main agent, which has depth 0. Depth 2 is the deepest level:

```text
main
├── A (depth 1)
│   ├── B (depth 2)
│   └── C (depth 2)
└── D (depth 1)
```

The main agent and native Tau subagents at depth 1 can start subagents of either kind. Depth 2 subagents and [Claude Code subagents](#claude-code-subagents) cannot.

An agent can reach only its descendants. In the example, the main agent manages all four subagents, A manages B and C, and D manages none. This applies to every `tau.agents` method and to `wait_for_agents`, and any other ID fails with `unknown_agent`. `spawn` always makes the caller the parent.

## Trigger sensitivity

An agent starts subagents only when the user or active instructions explicitly ask for delegation. For a subagent, this includes its assignment. Having `agents` does not by itself give it permission. Ask in ordinary language; no special tag is needed.

The agent follows this rule itself. Tau checks that a launch is valid, but it does not judge whether the request asked for delegation.

## Tools

A native Tau subagent can receive these tools. [Claude Code subagents](#claude-code-subagents) use the corresponding Claude Code tools instead:

- `bash`
- `write`
- `edit`
- `view_image`
- `web`
- `history`
- `mcp`, when the session has enabled MCP servers
- `models`
- `agents`, at depth 1 only

A subagent gets each of these that its parent also has. For example, a main persona with `bash`, `edit`, `history`, and `agents` gives depth 1 subagents all four, and gives depth 2 subagents `bash`, `edit`, and `history`. Names such as `web` and `history` enable the matching capability in the subagent's `code` tool. MCP uses the parent session's servers and connections, whatever the subagent's working directory. There is no separate tool list for subagents.

Every native Tau subagent also gets the built-in `tau_docs` tool, and a persona's `tools` list cannot remove it.

Subagents also never get [client tools](client-tools.md), such as the TUI's tools or a Telegram runner's file delivery tools. Only the main agent uses tools that attached clients offer. See [tools](tools.md) for how tool availability works in general.

## Models and settings

By default, a new subagent uses its parent's model and all of its parent's settings, including reasoning and service tier. For a subagent of the main agent, these come from the active persona. A child of a subagent launched with a model override inherits that override. These are fixed when the subagent starts. Later persona or reasoning changes do not affect it.

A model override uses this exact form:

```text
<provider>/<model>:<effort>
```

The provider is lowercased. The model ID is kept exactly as written and is case-sensitive. Effort is one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

The configured list of launch models is an allowlist. It does not choose a default. An agent should normally omit the `model` option of `tau.agents.spawn`. When `model` is given, it must exactly match an allowlist entry after normalization. For native Tau subagents, the override changes the provider, model, and reasoning, and keeps the other settings.

A model ID may be missing from the catalog if its provider is known (see [models](models.md)). An entry with an invalid provider, model, effort, or format makes the configuration field invalid. Duplicate entries are removed.

### Automatic compaction

These rules apply to native Tau subagents. [Claude Code subagents](#claude-code-subagents) manage their own compaction.

When `model` is omitted, a subagent inherits the effective threshold of the parent's launching turn, including any session `/auto-compact` override. A setting change during that turn affects only later turns and their launches.

When `model` is specified, the threshold comes from the persona's `subagentAutoCompactThresholdTokens` entry for that `<provider>/<model>`, without reasoning effort. The provider matches in any case, and the model ID must match exactly. If there is no entry, it uses the selected model's context window minus 16,384 tokens. This applies even when the explicit model matches the parent.

All thresholds are capped at the selected model's context window minus 16,384 tokens. Each child measures its own usage and keeps its launch threshold for follow-ups. See [personas](personas.md) for a configuration example.

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

The `claude-code` launch provider runs Claude Code through Anthropic's Agent SDK. Agents manage these workers with the same `tau.agents` methods and `wait_for_agents` tool as native Tau subagents. Claude Code models are available only as explicit subagent launch overrides.

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

Workers receive no Tau `code` capabilities, Tau MCP connections, `tau_docs`, or client tools, so they cannot start Tau subagents. Claude Code's own nested agents and interactive questions are disabled. Hooks and automatic memory are disabled too. Claude Code discovers its own MCP servers from its normal configuration sources, including project and user configuration on the execution environment. These connections are independent of the parent persona's `mcp` tool selection and of Tau's `mcpServers` setting. They run on the execution environment, so workers can use them even in a session on a remote execution environment, where Tau's own MCP is unavailable. Managed Claude Code policies still apply.

Selected tools use `bypassPermissions`, with Claude Code's sandbox disabled. They run with the execution environment's operating-system authority, like Tau's tools. Review the local Claude settings, skills, and MCP configuration before enabling these workers.

Tau displays short assistant updates and tool completion summaries. It also records the worker's assistant text, tool calls, and tool results in the worker's [trace](#conversation-traces), using Claude Code's own tool names, such as `Bash` and `Read`. Tau records SDK-reported token usage as it arrives, so interruption preserves counts already received. Final SDK totals supply cost estimates, so cost from an interrupted run remains unavailable until the SDK reports it.

Before sending the task, Tau checks that the SDK reports a subscription login without API-key authentication. Claude Code keeps its own credentials. Tau removes API and cloud-provider routing overrides from the child environment and provides no API fallback. Fast mode is disabled. Account-level extra usage can still incur charges; disable it in Claude to use only the included subscription allowance. The SDK's dollar estimates do not report subscription charges.

Steering messages go to Claude Code through the Agent SDK's streaming input while the worker is busy. Claude Code decides when to read them, typically between tool rounds, and a tool that is already running may continue. A steering message that Claude Code has not read when its turn ends is handled in another turn. Queued messages wait until Claude Code reports that its turn is finished.

Claude workers share the [session-wide limit](#spawn) and the usual subagent lifetime. Interrupting a worker terminates its process group. A follow-up can resume its Claude session while the parent session remains alive. Host restart, session disposal, and rewind remove workers under the same rules as native Tau subagents. Claude's transcript files remain on disk, but Tau does not use them to restore workers after a restart.

## Working directory

`tau.agents.spawn` normally runs the subagent in its parent's working directory. The optional `workingDirectory` may be absolute or relative to that directory. Tau resolves it to an absolute path on the execution environment, and the host and attached clients never resolve it against their own filesystems.

For native Tau subagents, when that path differs from the parent's working directory, Tau rebuilds the subagent's context for the new directory. It detects the platform and repository there, reads the applicable `AGENTS.md` files, and discovers that directory's skills. The persona, model catalog, runtime configuration, credentials, and tool policy still come from the parent.

A native Tau launch fails if Tau cannot build context for the directory. A path that resolves to the parent's working directory, such as `.`, reuses the parent's context. Claude Code workers load context themselves in the selected directory; an invalid directory fails when the worker starts.

## Managing subagents

An agent manages its descendants with `tau.agents` inside the [`code` tool](code-mode.md), and waits for them with the `wait_for_agents` tool. Each subagent has an ID that the host generates, and one conversation that grows with each input.

| Method | Purpose |
| --- | --- |
| `spawn({ title, prompt, model?, workingDirectory? })` | Start a subagent. |
| `list()` | State of every descendant as a flat list, plus the number running in the session and the limit. |
| `read({ id })` | State of one subagent. |
| `sendInput({ id, message, mode })` | Queue or steer more input. |
| `interrupt({ id, wait?, scope? })` | Stop the current turn and discard pending input, for one subagent or its whole branch. |
| `waitUntilIdle({ id })` | Wait inside a program until the subagent is idle. |
| `trace({ id, kinds?, toolName?, limit?, cursor? })` | Read a page of the subagent's conversation. |
| `readText({ id, seq, maxChars? })` | Read the text of one assistant message or tool result. |
| `readContent({ id, ref, cursor? })` | Page through large or non-text content. |

The agent reads the complete reference, with types and examples, by printing `await tau.docs("agents")` in `code`. Only what a program prints reaches the calling agent's conversation, so the agent can select the part of a long trace it needs.

### Spawn

`spawn` takes a single-line title of at most 512 characters, a prompt of at most 262,144 characters, an optional model, and an optional working directory. The prompt is the subagent's first message, and the subagent does not see the parent conversation, so the prompt should be self-contained. The call returns right away with the subagent's state, and the subagent keeps working in the background.

When a native Tau subagent has `history`, it follows the same history rules as the main agent, and an assignment that asks about past conversations counts as an explicit request. It may also read its ancestors' transcripts, including the main agent's, which holds what the user said. Without being asked, it reads them only when missing context would stop the work or force an important assumption. These reads use `tau.history.read` with `source: "local"`, which reads the host's history and skips any remote collection. Local recording is best-effort, so the newest entries can be missing.

At most 16 subagents can be working at once in one session, across both levels. A parent counts while its own turn is active, including when it is waiting for its children. Idle subagents and the main agent do not count. A launch that would exceed the limit fails right away and is not queued.

### State and waiting

A subagent's state has its ID, parent's ID, depth, title, model and reasoning, working directory, status, counts of pending queued and steering input, token usage, context size, and cost. The status is one of:

- `working`: the subagent is handling input.
- `stopping`: an interrupt was requested and the turn has not ended yet.
- `idle`: no turn is running and no input is pending. `reason` tells how the latest turn ended: `completed`, `interrupted`, or `failed`, with an error code and message for a failure.

`completed` means the turn ended normally. It does not mean the task succeeded, so the parent reads the subagent's answer before relying on it. Background Bash and code jobs that a subagent started do not keep it working.

`wait_for_agents` takes one or more IDs. It returns as soon as at least one of them is idle, with a text block for every requested subagent:

```
id: 0b6c2f1e-7d4a-4c1b-9a53-2e8f0d9c4b71
title: "review authentication"
status: idle
reason: completed
pending: queue=0 steer=0
response_seq: 42
response_complete: true
response_partial: false

--- response ---
No problems found in the session expiry checks.
```

A subagent that is still working or stopping gets only its ID, title, status, and pending counts. An idle subagent also gets `reason`, an `error` line with the code and message after a failed turn, and the last assistant message from its latest turn:

- `response_seq` is the message's `seq` in the trace, for reading more with `readText`.
- `response_complete` is `false` when the text was shortened to fit the budget, or when some of it is no longer available.
- `response_partial` is `true` when the turn failed or was interrupted, so the message may be an unfinished answer.
- `response: none` replaces these lines when the latest turn produced no assistant message.

The response text of all requested subagents shares a budget of 8,192 estimated tokens, split evenly between them, working ones included. The optional `maxOutputTokens` sets a different budget, from 1 to 65,536.

Inside a program, `waitUntilIdle` waits for one subagent with the same meaning of idle and returns its state without the response. Neither wait returns until queued input has been handled too. Both cover only the requested subagents. A parent can be idle while its children are working, and a child finishing does not start another turn for its parent. Cancelling a wait, or stopping the program that waits, does not interrupt the subagent.

The host also sends attached clients a live summary of subagent activity for display.

### Send more input

`sendInput` requires a `mode`:

- `queue`: the subagent finishes its current work, then handles the message as a separate turn. Queued messages run in the order they were sent.
- `steer`: the subagent takes the message into account as soon as possible during its current turn. A native Tau subagent applies it at the next safe point, never in the middle of a model response or tool call, as in the [main session](sessions.md#submit-queue-and-steer). [Claude Code subagents](#claude-code-subagents) follow Claude Code's own streaming-input behavior.

Either mode starts a new turn right away on an idle subagent. The call returns once the input is accepted, before the subagent reads it. The subagent keeps its conversation, model, settings, tools, and working directory.

Sending input fails while the subagent is stopping, when 64 inputs are already pending, or when the subagent is idle and 16 subagents are already working.

### Interrupt

`interrupt` stops the current turn and discards all pending input, so the subagent does not continue with queued work. With the default `scope: "agent"`, only the selected subagent stops and its descendants keep running. Interrupting an idle subagent this way only returns its state. `scope: "subtree"` stops the selected subagent and all its descendants, even when the selected one is idle. Until they have stopped, they refuse new input, and launches they have in progress fail.

By default the call waits until every targeted turn has ended. With `wait: false` it returns right away, and the status may still be `stopping`. The result is the selected subagent's state. Background jobs that the subagents started keep running, and the subagents stay available for more input.

In the TUI, `Ctrl+G` interrupts only the selected running subagent. Interrupting the main session does not interrupt subagents, and interrupting a subagent does not interrupt the main session.

### Conversation traces

Each subagent has a trace: an ordered record of what it was told, what it said, and what its tools returned. Native Tau and Claude Code subagents produce the same kinds of entries:

| Kind | Contents |
| --- | --- |
| `input` | Each accepted message, with its mode: `initial`, `queue`, or `steer`. |
| `assistant` | The subagent's message text. |
| `tool_call` | The tool name, call ID, and arguments as JSON. |
| `tool_result` | The tool name, call ID, outcome, and result as the subagent received it. |
| `notice` | An event with a machine-readable code, such as `input.discarded` or the failure code of a failed turn. |
| `status` | The subagent started working, began stopping, or became idle. |

Traces do not contain reasoning or system prompts. Output that a tool itself shortened stays shortened.

Each entry has a sequence number `seq` and a timestamp. A `trace` call returns the newest matching entries in chronological order, 20 by default and at most 50. It can filter by entry kinds and by tool name. Its `nextCursor` leads to older entries.

Content of at most 4,096 bytes as JSON, without images, is inline in the entry. Larger content and all images are references. `readText` returns the text of one assistant message or tool result, up to 30,000 UTF-16 code units by default and at most 100,000. Content with JSON or images needs `readContent`, which returns one block per page, with text in chunks of at most 16,384 UTF-16 code units.

A trace keeps the newest 4,096 entries, up to 64 MiB, for each subagent. When older entries are removed, trace pages report `historyEvicted: true`, and reading a removed entry or reference fails. A single content value larger than 6 MiB is replaced by a block that marks it unavailable. Traces last as long as the subagent and do not survive a host restart.

A failed call throws an error with a `code` and a `message`. The codes are `invalid_arguments`, `unknown_agent`, `invalid_cursor`, `expired_content`, `content_type`, `operation_failed`, and `cancelled`. A subagent's own failure is part of its state and trace, not a failed call.

## Detach, rewind, and recovery

Subagents belong to the running session on the host, not to an attached TUI. Detaching or losing a connection does not stop them. A running subagent keeps the session loaded, and another client can attach and see its state. An idle subagent lasts only as long as a loaded session; see [retention](remote-sessions.md#keep-a-session-loaded).

Subagents do not survive the end of a session on the host or a host restart. Recovery removes any saved records of them, so a recovered session cannot send input to an old subagent ID.

Rewind also removes subagents that the main agent started from an assistant message the rewind removed, together with all their descendants. A subagent started from a `code` program belongs to the assistant message that ran the program, including a program running as a background job. Rewind is refused while any subagent is running. Host shutdown or session disposal interrupts and removes all subagents.

Tau records native subagents in [history](history.md#native-subagent-sessions) as child sessions of their immediate parents, even without the `history` tool. These sessions stay after a rewind, but history cannot restore the subagents. Claude Code is excluded.

Important results should reach the main agent and end up in the session history or in project files before the session on the host goes away. [Sessions](sessions.md) covers saving and recovery in general.

## Reloading and validation

Changes to persona tools or to the launch allowlist apply after `/reload` in an idle session, or in a new session. Reload updates the main agent, so only the subagents it launches later, and their children, use the new setup. Existing subagents keep the setup they started with, including its tools and launch allowlist, and pass it on to children they launch later. For example, an existing subagent can still launch a child with a model you removed from `subagents.launchModels`.

`subagents.launchModels` must be an array of valid `<provider>/<model>:<effort>` strings. Unknown providers, invalid efforts, and malformed entries produce configuration warnings.

A launch can fail because of invalid arguments, a model outside the allowlist, the concurrency limit, an interrupted caller, or a prompt or working-directory context that cannot be built.

Before starting a local TUI, `tau --debug --persona <id>` shows which tools are available, the model and settings subagents inherit, and the subagents' tool list. In a running session, `/reload` reports file warnings and `tau.agents.list()` shows live subagent state.
