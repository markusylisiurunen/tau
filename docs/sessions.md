# Sessions

A Tau session is the durable home of one conversation and its execution environment. It keeps enough state to continue after detaching or restarting the host, while deliberately leaving short-lived client and process state out. Understanding that boundary makes interruption, recovery, compaction, and remote work predictable.

## Create a session

Running `tau` creates a fresh local session with the current directory as its execution cwd. The host resolves [configuration](configuration.md), models, [personas](personas.md), [skills](skills.md), prompts, and project context from that execution environment before the first turn.

The session also receives immutable creation attributes. They are bounded string pairs used for provenance and [history](history.md), not mutable runtime settings. Conventional attributes are:

- `source`, identifying the creating client, such as `tui` or `sdk`.
- `repository`, using a normalized `host/owner/repository` value. Composite workspaces use comma-delimited repository values.

For a local TUI, Tau can derive `repository` before creation because that client directly manages the local execution environment. A remote host does not inspect an execution path to infer attributes. Remote TUI creation supplies `source: "tui"`; SDK and protocol clients should provide complete authoritative attributes themselves.

A session’s execution-environment identity and cwd are fixed at creation. `/new` creates another session in the same environment with the current persona and reasoning settings. It does not clear or reuse the existing session.

## Know what owns the session

Three components can be physically colocated but remain logically separate:

- The TUI or SDK client submits input, observes updates, and may provide client-local tools.
- The session host orchestrates turns, resolves credentials, persists sessions, and supervises execution environments.
- The execution environment owns the agent-visible cwd, files, repository, project configuration, commands, platform, and runtime tools.

The host persists ordinary sessions under `~/.config/tau/sessions` for the host user. These versioned documents are managed storage, not an editing interface. Never modify them directly. Use Tau’s session operations, normal project configuration, and recovery path instead.

## Submit, queue, and steer

A normal submission is accepted and persisted before model work begins. Tau then runs model and tool subturns until the turn completes, fails, is blocked, or is interrupted.

Only one logical turn runs at a time. Input sent during active work has two useful delivery modes:

- A queued message waits for the session to become idle, then starts an independent turn.
- Steering joins the active logical turn at a safe continuation boundary.

In the TUI, Enter queues and Ctrl+Enter steers while work is active. When idle, either starts a normal turn. Pending messages are visible to every observer of the same live hosted session. Alt+Up cancels queued messages and steering that has not been applied and restores the text to the editor.

A turn captures its model, persona, reasoning, system prompt, tools, retry policy, and compaction policy when it starts. Tool subturns and steering continuations keep that captured specification even if reasoning or host configuration changes meanwhile. A queued turn captures the then-current specification when it later starts.

Pending queue and steering state survives client detach only while the hosted session remains alive in memory. It is not part of durable recovery and starts empty after a host restart.

## Interrupt and retry

Ordinary session interruption is cooperative. It requests cancellation of the main session’s active turn, all direct executions, isolated model samples, and maintenance work. An interrupted turn records an interrupted assistant result where one exists. It does not stop independently running supervised subagents; select one with Alt+Down and use Ctrl+G, or call `session.interruptSubagent` from a protocol client. Host shutdown or session disposal cleans up those child runtimes. In the TUI, Escape interrupts client-local foreground work such as diff review, recording, or speech playback before requesting main-session interruption from the host.

Retry runs another assistant turn from the current session history. It does not remove the interrupted or failed result, rewind context, or submit the previous user text again. This lets Tau continue from completed tool results without automatically rerunning them. In the TUI, press Enter twice on an empty editor while idle.

Retry is unavailable when there is no prior user turn. It is also unavailable for goal-controlled turns because a blocked goal has an explicit resume operation.

Detaching is not the same as interrupting. Closing one observer of a long-running host leaves the hosted turn running. By contrast, a local TUI owns its in-process host, so closing it causes that host to shut down and interrupt active work. See [remote sessions](remote-sessions.md).

## Change persona and reasoning safely

The selected persona and reasoning level are durable session settings.

Persona changes require idle state because they rebuild the effective model, system instructions, skills, and tools from the execution environment’s current configuration. In the TUI, use `/persona:<id>` or Ctrl+P.

Reasoning can be changed while work is active. The current turn keeps its captured reasoning, while the next independently started or queued turn uses the new setting. Use Shift+Tab in the TUI.

After a host restart, recovery resolves current runtime configuration so providers and model definitions remain usable, then reapplies the session’s persisted persona and reasoning settings where possible. The effective recovered bootstrap can change when the current installation or model catalog has changed, but the session’s committed semantic content remains the recovery source of truth.

## Detach, reattach, and recover

A session is persisted throughout its lifetime, not only when the TUI exits. Reattaching to a live host returns the current state and continues receiving updates. Reattaching after host restart loads the stored session and restores its execution environment through a configured resolver.

Recovery preserves user-visible durable state including:

- committed conversation messages and terminal tool results
- current persona and reasoning settings
- cumulative usage cost and context accounting needed for continuation
- persistent goal state
- execution-environment identity, cwd, and creation attributes
- compaction and rewind results

Recovery intentionally does not recreate every live process. It returns the session idle, settles any accepted but unfinished turn as aborted, cancels running maintenance operations, and normalizes tools whose completion cannot be proven. Supervised subagents and their live activity do not survive restart. An active persistent goal becomes blocked rather than continuing autonomously without an explicit resume.

A stored session is listed or recovered only when the current host has a resolver capable of restoring its execution-environment kind and named target. Recovery can therefore fail even when the session document is valid, for example when a Cloudflare bridge was removed, a Fly API target is no longer configured, or the underlying sandbox, Sprite, directory, or credentials are unavailable.

Newer Tau versions preserve the openability of supported stored sessions through storage migrations and recovery normalization. This promises access to recoverable semantic data, not byte-for-byte files or identical historical presentation. A genuinely newer unsupported storage version or corrupted document can still be rejected.

## Use persistent goals

A persistent goal lets Tau continue across repeated model turns until the agent marks the objective complete or blocked. Start one from the TUI:

```text
/goal prepare the release and verify the package
```

Tau stores the objective before running it. While the goal remains active, the host creates continuation turns automatically. The agent’s goal tools can refine the objective, block it when human input is needed, or complete and clear it.

Use the controls deliberately:

- `/goal` shows the current objective and status.
- `/goal resume` resumes a blocked goal.
- `/goal clear` clears the goal. If work is active, clearing interrupts it and cancels pending input associated with the old flow.

Only one goal can exist at a time. Clear it before starting another. Interruption, provider failure, blocked execution, or host recovery changes an active goal to `blocked`. Tau never silently resumes autonomous goal work after recovery. Goal-controlled turns cannot use ordinary retry; use `/goal resume` after resolving the blocker.

A goal survives client detach and host restart because its objective and status are session state. The process doing the work does not survive restart.

## Compact model context

Compaction replaces older model-visible conversation context with a synthetic summary so the session can continue within the model’s context window. It changes active model context, not the independent searchable transcript.

### Automatic compaction

Automatic compaction runs before a model subturn when fresh provider usage plus newly added estimated context exceeds the configured threshold. The threshold is the model context window minus `autoCompact.reserveTokens`. Tau keeps a recent tail bounded by `autoCompact.keepRecentTokens`, summarizes older context, and can compact more than once during a long logical turn.

The summary model may copy important original user messages verbatim into the summary. Recent retained messages stay available to the model, although unusually large textual tool and recovery results may be truncated in retained context. Tau records the compaction as a new active context segment.

Before replacing context, Tau makes a best-effort archive in the execution environment’s temporary directory. Each automatic compaction adds a numbered `.txt` and `.json` pair under a directory isolated by agent id. The text file is convenient for bounded search and truncates large tool results; the JSON pair retains the archived content without those tool-result truncations, excluding assistant thinking. The continuation message gives the agent the exact paths when archiving succeeds.

These archives are temporary recovery aids, not backups. Archive failure does not block compaction, and execution-environment cleanup may remove them.

Configure the policy in [configuration](configuration.md):

```json
{
  "autoCompact": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Manual compaction

Manual compaction requires idle state and summarizes the whole active model history rather than retaining an automatic recent tail.

```text
/compact-all preserve the deployment constraints
```

`/compact-all` replaces context with the generated summary. `/compact-keep-last` also asks the summary to include the prior last assistant response verbatim when one is available. Text after either command is optional guidance to the compaction model, not a new conversation turn.

A failed, skipped, or interrupted compaction leaves the previous context active. Manual compaction does not create the automatic pre-compaction archive.

## Rewind deliberately

`/rewind` opens a picker of eligible user messages. Selecting one removes that selected message and everything after it from the active session, then returns the selected text to the editor so it can be revised and resubmitted.

Rewind requires the session to be idle with no pending submissions. It truncates messages, tool state, turn outcomes, and searchable transcript entries from the selected boundary onward. It is not a display-only operation and has no built-in undo. If the intent is merely to correct course without deleting history, submit a new message or steer the active turn instead.

Compaction and rewind differ in an important way: compaction preserves the flat transcript history, while rewind truncates it to match the chosen session boundary.

## Reload session content

Run `/reload` from the TUI while the session is idle. The host rereads runtime configuration and model overlays, personas, prompts, skills, and AGENTS.md context from the execution environment cwd. It keeps the current persona if that id still exists and otherwise selects the first available persona. Reload warnings appear in the transcript.

Reload updates future turns. It does not rewrite committed conversation content or change the execution environment. It also does not reload client-owned themes, diff launchers, speech settings, or client tools. Restart the attaching TUI for those. Effective configured model `apiKeys` update through `/reload`, while managed Codex auth storage is read again on later credential resolutions. Restart the host for changed process environment variables, listener settings, resolver targets, or the Tau binary. [Credentials](credentials.md) has the canonical distinctions, and [remote sessions](remote-sessions.md) identifies each owner.

Protocol clients can request mutations directly, but should still wait for idle state. Mutating operations can interrupt current work and reject pending messages so the session reaches one canonical configuration.

## Session state and transcript history are different

Tau keeps two durable views for different jobs:

- The session snapshot is the recoverable source of truth for continuing one conversation. It contains the current active model context and user-visible session state.
- Transcript history is a flat sequence of committed user entries, assistant text, and completed tools used for cross-session search and reading. It is stored separately in the host’s history database and may also replicate to a configured history service.

Compaction changes the session snapshot’s active context but leaves transcript history intact. Rewind truncates both from the removed boundary. Transcript history cannot reconstruct all session runtime state and is not used to recover a session. See [history](history.md) for storage, replication, and the history tool.

## Inspect model usage

Tau writes host-owned usage records to daily `~/.config/tau/logs/usage-YYYY-MM-DD.jsonl` files under the host user’s home. Records cover finalized assistant model responses from main sessions, supervised subagents, and ephemeral threads. They include timestamps and session, persona, provider, model, reasoning, and agent attribution, plus input, output, cache-read, cache-write, total-token, and Tau-recorded cost values. They do not contain prompt or response text and are separate from session snapshots and transcript history.

Run the summary command as the user who runs the host:

```sh
tau usage
```

It groups by day by default and prints request count, each token category, total tokens, cost, and an overall total. The supported options are:

| Option | Behavior |
| --- | --- |
| `--since <date>` | Include entries on or after an inclusive `YYYY-MM-DD` or ISO date. |
| `--persona <id>` | Match an exact persona id, case-insensitively. |
| `--provider <name>` | Match an exact provider, case-insensitively. |
| `--model <id>` | Match an exact model id, case-insensitively. |
| `--group-by day\|model` | Group by calendar day or by `provider/model`; the default is `day`. |
| `--help`, `-h` | Show the command help. |

Filters can be combined:

```sh
tau usage --since 2026-08-01 --provider openai-codex --group-by model
```

There is no `--until`, `--session`, or `--agent` filter. For a remote session, run `tau usage` on the host under the same user as `tau serve`; running it on an attaching client reads that client user’s logs instead. The command is read-only, but the raw files still reveal timestamps, session identifiers, model choices, token volume, and cost activity. Prefer the filtered aggregate output over copying raw JSONL into a shared transcript, and treat Tau-recorded costs as operational estimates rather than a provider invoice.

## What survives each boundary

| Event | Durable session state | Pending input | Active turns and subagents | Client-local state |
| --- | --- | --- | --- | --- |
| Another client detaches from a live WebSocket host | Preserved | Preserved in host memory | Continue | Detached client tools, themes, drafts, and local tasks are lost |
| Local TUI exits | Persisted by owned-host shutdown | Cancelled | Interrupted and settled where possible | Lost |
| WebSocket host restarts | Recovered from storage | Lost | Returns idle; subagents are not restored | Each client reconnects separately |
| TUI restarts while host stays live | Preserved | Preserved in host memory | Continue | Reloaded from the new client process |
| `/new` | Old session remains stored | Not copied | New idle session | Same TUI process continues |

An unsent editor draft belongs only to the TUI. Use Ctrl+S to move it to the local clipboard before restarting a client.

## Verify a recovered session safely

Use normal Tau operations rather than opening or editing session files.

1. Wait for active work to finish or interrupt it intentionally.
2. Note the session id shown in the TUI startup block.
3. Exit cleanly and reattach through the same host.
4. Confirm the expected messages, persona, reasoning level, and `/goal` status.
5. Run non-contextual environment checks with `!!`, for example `!!pwd` and `!!git status --short`.
6. Submit a small read-only request before resuming destructive work.

For a local stored session, start a WebSocket host under the same user and attach from another terminal:

```sh
tau serve
tau attach --session 0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3 ws://127.0.0.1:8787
```

If recovery fails, verify the host version, execution-environment resolver configuration, target availability, and credentials before assuming the stored session is damaged. [Remote sessions](remote-sessions.md) covers those checks.
