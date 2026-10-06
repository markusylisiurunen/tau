# Sessions

A Tau session holds one conversation and the execution environment it works in. It saves enough state to continue after you detach or the host restarts. Short-lived client and process state is not saved. This page explains what is kept, so interruption, recovery, compaction, and remote work behave as you expect.

## Create a session

Running `tau` creates a new local session whose working directory is the current directory. Before the first turn, the host loads [configuration](configuration.md), models, [personas](personas.md), [skills](skills.md), prompts, and project context from that execution environment.

A session also gets creation attributes, which never change. They are short string pairs that record where the session came from and are used by [history](history.md). They are not settings. Common attributes are:

- `source`: the client that created the session, such as `tui` or `sdk`.
- `repository`: a normalized `host/owner/repository` value. Composite workspaces use a comma-separated list.

A local TUI can fill in `repository` before creating the session, because it manages the local execution environment directly. A remote host never inspects a path to work out attributes. The remote TUI sends `source: "tui"`. SDK and protocol clients should send complete attributes themselves.

A session's execution environment and working directory are fixed when it is created. `/new` creates another session in the same environment, with the current persona and reasoning settings. The existing session is kept, unchanged.

## Know what owns the session

Three parts can run on one machine but stay separate:

- The TUI or SDK client sends input, receives updates, and may offer client tools.
- The session host runs turns, resolves credentials, saves sessions, and manages execution environments.
- The execution environment holds the agent's working directory, files, repository, project configuration, commands, platform, and tools.

The host saves sessions under `~/.config/tau/sessions` in the host user's home. These are versioned files that Tau manages. Never edit them directly. Use Tau's session operations, project configuration, and recovery instead.

[Background Bash jobs](tools.md#bash) belong to the session. They survive turns, interruption, and clients detaching. A running job keeps a session loaded even when no client is attached, and does not block new turns. Jobs stop when the session is closed normally or the host shuts down, and are not restored after a restart. Cleanup after a crash or forced kill is not guaranteed.

## Submit, queue, and steer

A submitted message is accepted and saved before any model work starts. Tau then runs model calls and tool calls until the turn completes, fails, is blocked, or is interrupted. The model decides when its response is complete, and Tau does not start another turn by itself after a final response. Automatic compaction can continue an unfinished turn in a new context window.

Only one turn runs at a time. While work is running, there are two ways to send more input:

- A queued message waits until the session is idle, then starts its own turn.
- Steering joins the running turn at the next safe point.

In the TUI, Enter steers and Ctrl+Enter queues while work is running. When idle, both start a normal turn. Pending messages are visible to every client attached to the same live session. Alt+Up cancels queued messages and steering that has not been applied yet, and puts the text back in the editor.

A turn fixes its model, persona, reasoning, system prompt, tools, retry policy, and compaction policy when it starts. Tool calls and steering within the turn keep these, even if reasoning or host configuration changes meanwhile. A queued turn uses the settings current when it actually starts.

Queued and steering messages survive a client detaching only while the session stays loaded on the host. They are not saved and are empty after a host restart.

## Interrupt and retry

Interruption asks work to stop. It cancels the main session's running turn, direct commands, standalone model calls, and maintenance work. An interrupted turn records an interrupted assistant result where there is one. Interruption does not stop subagents: select one with Alt+Down and press Ctrl+G, or call `session.interruptSubagent` from a protocol client. Host shutdown or session disposal stops subagents. In the TUI, Escape first stops local work such as diff review, recording, or speech playback, and only then asks the host to interrupt the session.

Retry runs another assistant turn from the current history. It does not remove the interrupted or failed result, rewind context, or send the previous user text again. Tau can therefore continue from completed tool results without running those tools again. In the TUI, press Enter twice on an empty editor while idle.

Retry is unavailable when there is no earlier user turn.

Detaching is not interrupting. Closing one client of a long-running host leaves the turn running. A local TUI, however, owns its in-process host, so closing it shuts that host down and interrupts running work. See [remote sessions](remote-sessions.md).

## Change persona and reasoning

The persona and reasoning level are saved session settings.

A persona change requires an idle session, because it rebuilds the model, system instructions, skills, and tools from the execution environment's current configuration. In the TUI, use `/persona:<id>` or Ctrl+P.

Reasoning can change while work is running. The running turn keeps its reasoning, and the next turn uses the new setting. In the TUI, use Shift+Tab.

After a host restart, recovery loads the current configuration so providers and models work, then reapplies the session's saved persona and reasoning where possible. The result can differ from before if the installation or model catalog has changed. The saved conversation stays the same.

## Detach, reattach, and recover

A session is saved throughout its life, not only when the TUI exits. Reattaching to a running host returns the current state and continues with live updates. Reattaching after a host restart loads the saved session and reconnects its execution environment, using the host's configuration for that environment type.

Recovery keeps:

- the conversation messages and finished tool results
- the persona and reasoning settings
- the total cost so far, and the context accounting needed to continue
- the execution environment, working directory, and creation attributes
- the results of compaction and rewind

Recovery does not restart live processes. The session comes back idle. A turn that was accepted but not finished is recorded as aborted, running maintenance is cancelled, and tools whose outcome is unknown are marked as such. Subagents and their activity do not survive a restart.

The host lists or recovers a saved session only if it can reconnect that session's execution environment type and target. Recovery can therefore fail for a valid session, for example when a Fly Sprite connection is no longer configured, or when the Sprite, directory, or credentials are no longer available.

Newer Tau versions can open saved sessions from supported older versions. The conversation and other important data stay available, but the files may be rewritten and old content may display differently. Tau rejects corrupted sessions, and sessions saved by a newer Tau version that it does not support.

## Compact model context

Compaction replaces the conversation the model sees with a summary, called a checkpoint, so the session can continue within the model's context window. It changes only what the model sees. Searchable history is not affected.

The session's model writes the checkpoint from its own view of the conversation, including the base instructions, any earlier checkpoint, and reasoning state where the provider supports it. The checkpoint covers the whole context and does not depend on which recent messages will be kept. It is written in a separate maintenance request that runs no tools and is not a user turn. How much reasoning carries over depends on the provider. The checkpoint records useful conclusions and their reasons instead of reproducing the model's internal thinking.

The summary aims both to let work continue right away and to keep earlier work recognizable. Recent and unfinished work gets the most detail. Older work is reduced to its purpose, results, and important decisions. Across repeated compactions, the model merges the previous summary with the newer conversation, and does not drop topics just because they are old or finished. Important constraints stay precise however old they are. Compaction still loses information: over time, not every topic or detail survives.

### Automatic compaction

Automatic compaction runs before a model call when the provider's latest token count, plus an estimate for content added since, exceeds the threshold. The threshold is the model's context window minus a fixed reserve of 16,384 tokens. Writing the checkpoint uses the normal model settings, with no special output limit.

For both automatic and manual compaction, Tau checks that the request fits, using a valid token count from the provider plus estimates for new content and the summary instruction. Without a valid count, it estimates the whole request. If the request cannot fit, compaction fails; Tau never falls back to sending a flattened transcript. Compaction can run several times during one long turn.

The summary describes the conversation, completed work, findings, and remaining work, without copying long user messages or tool output word for word. It can point to details worth looking up in the transcript archive and say why they matter.

Tau keeps the most recent messages, without gaps, within a budget of 20,000 estimated tokens, and never more than the compaction threshold:

- The cut can fall inside a user turn, but messages are kept whole, and an assistant message with tool calls stays together with all its results.
- Kept messages, including tool-recovery messages, are never truncated.
- Tau does not skip a large exchange to fit earlier messages into the remaining budget.
- If the latest exchange does not fit, only the checkpoint remains.

Tau records the compaction as the start of a new context segment.

Before replacing the context, Tau tries to save a transcript archive in the execution environment's temporary directory. Each automatic compaction adds a numbered `.txt` and `.json` pair, in a directory specific to the agent. The text file is meant for searching, with large tool results shortened. The JSON file keeps the full tool results, but not assistant thinking. A `README.md` in the same directory describes both formats, with example lookups. When archiving succeeds, the continuation message includes all three paths.

These files hold details removed from the session's model context. The `history` tool is different: it searches a separate collection on the host, which may be copied to a remote service, out of date, truncated, or unavailable, and its entry IDs do not match archive records. The continuation message names the archive as the place to recover compacted details.

The continuation message includes the full archive guide, so the agent can continue without reading the file first. The guide also stays on disk. It recommends looking up entries by known ID or distinctive text, with a short chronological overview as an optional first step. Earlier numbered pairs can hold details from before the current compaction.

Archives are temporary recovery aids, not backups. If archiving fails, compaction still runs, and the execution environment may delete archives during cleanup.

### Intermediate system instructions

Besides the persona's base prompt, the conversation history can contain plain-text system instructions. The TUI hides them. They are saved with the session, recorded as system entries in searchable history, and sent to the model in conversation order. The persona's base prompt is never recorded in history. Providers that do not support system messages in the middle of a conversation may receive these instructions merged into the leading prompt.

Compaction treats these instructions as part of the history: what they caused can enter the summary, and instructions among the kept recent messages stay unchanged. The base prompt is sent separately and is never replaced by the summary. Instructions that only guided an earlier compaction are left out of both the summary and the kept messages. An instruction that must survive exactly for a long time cannot rely on being a system message; the feature that added it must add it again or keep it some other way. Rewind removes these instructions along with everything after the rewind point.

A `<system>` block written by a user never becomes a system instruction (see [prompts and project context](prompts-and-project-context.md)).

### Manual compaction

Manual compaction requires an idle session. It summarizes the whole conversation and keeps no recent messages.

```text
/compact-all preserve the deployment constraints
```

`/compact-all` replaces the context with the summary. `/compact-keep-last` also asks the summary to include the last assistant response word for word, when there is one. Text after either command is optional guidance for the summary, not a new message in the conversation.

If compaction fails, is skipped, or is interrupted, the previous context stays. Manual compaction does not save a transcript archive.

## Rewind deliberately

`/rewind` opens a list of user messages you can return to. Selecting one removes that message and everything after it from the session, and puts the selected text back in the editor so you can change and resend it.

Rewind requires an idle session with no pending messages. It removes messages, tool state, turn results, and searchable history entries from that point on. It cannot be undone. To change direction without deleting anything, send a new message or steer the running turn instead.

Compaction keeps searchable history, while rewind cuts it back to the rewind point.

## Reload session content

Run `/reload` in the TUI while the session is idle. The host reads configuration, personas, prompts, skills, and `AGENTS.md` context again from the session's working directory. It keeps the current persona if its ID still exists, and otherwise selects the first available persona. Warnings appear in the transcript.

Reload affects later turns. It never changes the saved conversation or the execution environment. It does not reload anything owned by the client, such as themes, the diff tool, speech settings, or client tools; restart the TUI for those. Codex auth storage is read again on every new request. Restart the host after changing its environment variables, `apiKeys`, listener settings, hosted environment settings, or the Tau version. [Credentials](credentials.md) and [remote sessions](remote-sessions.md) describe where each setting belongs.

Protocol clients can request changes directly, but should still wait for an idle session. Some changes interrupt running work and reject pending messages, so the session ends up with one consistent configuration.

## Session state and searchable history

Tau keeps two separate records for different purposes:

- The saved session is what Tau uses to continue one conversation. It contains the model's current context and the session state you see.
- Searchable history is a flat list of user messages, intermediate system instructions, assistant text, and finished tool calls, used to search and read across sessions. It is stored in the host's history database and can also be copied to a configured history service.

Compaction changes the saved session's model context but leaves searchable history as it was. Rewind cuts both back to the rewind point. History cannot rebuild a session and is never used to recover one. See [history](history.md) for storage, replication, and the history tool.

## Inspect model usage

Tau writes usage records on the host to daily files, `~/.config/tau/logs/usage-YYYY-MM-DD.jsonl`, in the host user's home. Each record is one finished model response from a main session, subagent, or ephemeral thread. Records include the time, the session, persona, provider, model, reasoning, and agent, and the input, output, cache-read, cache-write, and total tokens with Tau's cost estimate. They do not contain prompt or response text, and they are separate from saved sessions and searchable history.

Run the summary command as the user that runs the host:

```sh
tau usage
```

By default it groups by day and prints the request count, each token category, total tokens, cost, and an overall total. The options are:

| Option | Behavior |
| --- | --- |
| `--since <date>` | Include entries on or after a `YYYY-MM-DD` or ISO date. |
| `--persona <id>` | Match an exact persona id, case-insensitively. |
| `--provider <name>` | Match an exact provider, case-insensitively. |
| `--model <id>` | Match an exact model id, case-insensitively. |
| `--group-by day\|model` | Group by calendar day or by `provider/model`. The default is `day`. |
| `--help`, `-h` | Show the command help. |

Filters can be combined:

```sh
tau usage --since 2026-08-01 --provider openai-codex --group-by model
```

There is no `--until`, `--session`, or `--agent` filter. For a remote session, run `tau usage` on the host as the user that runs `tau serve`. Running it on an attached client reads that client user's logs instead. The command only reads, but the raw files still show times, session IDs, model choices, token volumes, and costs. Share the filtered summary instead of raw JSONL, and treat Tau's costs as estimates, not an invoice.

## What survives each event

| Event | Saved session | Pending messages | Running turns and subagents | Client state |
| --- | --- | --- | --- | --- |
| Another client detaches from a running WebSocket host | Kept | Kept in host memory | Continue | That client's tools, themes, drafts, and local tasks are gone |
| Local TUI exits | Saved as its host shuts down | Cancelled | Interrupted and recorded where possible | Lost |
| WebSocket host restarts | Recovered from storage | Lost | Session returns idle; subagents are not restored | Each client reconnects on its own |
| TUI restarts while the host keeps running | Kept | Kept in host memory | Continue | Loaded again by the new client process |
| `/new` | Old session stays saved | Not copied | New idle session | Same TUI process continues |

An unsent draft exists only in the TUI. Press Ctrl+S to copy it to the clipboard before restarting a client.

## Check a recovered session

Use normal Tau operations, not the session files.

1. Wait for running work to finish, or interrupt it.
2. Note the session ID shown at the top of the TUI.
3. Exit cleanly and reattach through the same host.
4. Confirm the messages, persona, and reasoning level.
5. Check the environment without adding to the context using `!!`, for example `!!pwd` and `!!git status --short`.
6. Send a small read-only request before continuing with work that changes things.

To reopen a saved local session, start a WebSocket host as the same user and attach from another terminal:

```sh
tau serve
tau attach --session 0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3 ws://127.0.0.1:8787
```

If recovery fails, check the host version, the hosted environment configuration, whether the target is available, and credentials before assuming the session is damaged. [Remote sessions](remote-sessions.md) covers those checks.
