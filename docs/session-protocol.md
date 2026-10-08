# Session protocol

Tau's session protocol is the wire format for clients that create, observe, and control sessions hosted by `tau serve`. Node applications can usually use the typed [Node SDK](node-sdk.md) instead.

The protocol is based on requests and responses, plus server messages for session state, pending input, subagent activity, short-lived feedback, and client tool calls. It does not depend on a particular transport; Tau serves it over WebSocket. The complete method surface is in the [session protocol method reference](session-protocol-methods.md).

## Connect over WebSocket

`tau serve` uses one UTF-8 JSON object per text WebSocket message. Binary messages are not supported. Authentication, TLS, listener setup, SSH tunneling, and host lifetime belong to [remote sessions](remote-sessions.md).

The server exposes one host. Starting it does not create or select a session. A client lists, creates, or observes sessions explicitly.

The client, host, and execution environment are separate, even when they share a process or filesystem. Session paths and commands are on the execution environment. Saving, credentials, model calls, and protocol handling are on the host. Client tools and local UI are on the connected client. See [ownership and scope](ownership-and-scope.md) before passing paths or credentials across this boundary.

## Connect and initialize

The server sends `ready` as its first message:

```json
{
  "version": 18,
  "type": "ready",
  "methods": ["initialize", "session.create", "session.list"]
}
```

The real `methods` array lists every supported method; the example above is shortened. Versions must match exactly and are not negotiated. If client and host disagree on `version`, use matching Tau releases.

After `ready`, send `initialize` with non-empty client metadata:

```json
{
  "version": 18,
  "type": "request",
  "id": "init-1",
  "method": "initialize",
  "params": {
    "client": { "name": "acme-editor", "version": "1.4.0" }
  }
}
```

A successful result returns `protocolVersion`, the full `methods` array, and `alreadyInitialized`. Calling `initialize` again is allowed and returns `alreadyInitialized: true`. It does not act on any session, but clients should complete it before other requests.

A client can offer its own tools in `client.tools` when initializing. Calls to those tools are then sent to it over this connection. [Client tools](client-tools.md) covers tool behavior, permissions, and command helpers; this page covers only the wire messages a raw protocol client needs.

## Send requests and match responses

Every request has the same envelope:

```json
{
  "version": 18,
  "type": "request",
  "id": "req-42",
  "method": "session.snapshot",
  "params": { "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3" }
}
```

`id` is a non-empty string chosen by the client, unique among its open requests on the connection. `params` is always required, even if empty, as in `{}` for `session.list`. The host validates required fields, types, discriminators, method names, and the exact protocol version. Unknown fields are accepted and removed, except in system messages and their metadata, where they are rejected.

Successful responses echo the request id:

```json
{
  "version": 18,
  "type": "response",
  "id": "req-42",
  "ok": true,
  "result": { "sessionId": "..." }
}
```

A request can remain open while the host emits state messages or handles later requests. Route responses by `id`, never by arrival order. Route streamed messages by `sessionId`.

## Observe before consuming session state

`session.create` creates a session but does not observe it. `session.observe` starts observing on this connection and returns three complete starting states together:

```json
{
  "snapshot": { "sessionId": "...", "revision": 8 },
  "pendingUserMessages": { "revision": 3, "messages": [] },
  "subagentActivities": { "revision": 5, "agents": {} }
}
```

Install all three before processing later messages for that session. The host holds back updates while preparing the response, and afterward sends only updates newer than the returned revisions.

Observing controls which updates you receive; it does not make you the owner. `session.unobserve` stops this connection's updates without deleting the session or interrupting work. Several connections can observe one session, and each can change it. Client tool names must be unique among observing clients.

## Treat the snapshot as the source of truth

`SessionProtocolSnapshot` is the saved, recoverable state of one session. Its main fields are:

| Field | Meaning |
| --- | --- |
| `sessionId`, `attributes`, `createdAt` | Identity and immutable creation metadata. |
| `revision` | Monotonic protocol snapshot revision. |
| `lifecycle` | `idle` or `running`. |
| `agentState` | Independent agent revision, model context key, and optional usage checkpoint. |
| `settings`, `costTotal` | Persona, reasoning, and auto-compaction settings, and accumulated session cost. |
| `bootstrap`, `catalog` | Selected model and prompt metadata plus available personas, prompt metadata, skills, and enabled host-configured MCP server names. |
| `executionEnvironment` | The environment kind, identity, `cwd`, and home used for agent-visible work. |
| `messages`, `turns` | Messages sent to the model, and a saved record for each accepted turn. |
| `timeline` | Ordered active transcript placement. |
| `tools`, `operations`, `agents` | Changing state that timeline items or client views refer to. |
| `facets` | Versioned client-facing metadata. Unknown facet kinds and versions should be ignored. |

Both auto-compaction fields in `settings` are required:

- `autoCompactThresholdTokens` is the configured value: a safe integer of at least 50,000, or `null` for the model-based default.
- `effectiveAutoCompactThresholdTokens` is the integer threshold clients should display. It is the model's context window minus 16,384 tokens, or the configured value if that is smaller.

`bootstrap.model.contextWindow` is the full model window, regardless of the compaction threshold.

`catalog.mcpServers` lists the enabled MCP servers in the host configuration, by name only. It does not mean they are connected; servers connect on first use. Connection settings and credentials are never included.

`bootstrap.prompt.subagentSystemPrompt` is present when subagents can be started. Each catalog persona has a `subagentLaunchModels` allowlist. Subagent records have task titles and IDs; there are no worker types.

Render active transcript order from `timeline.items`, not by sorting or filtering `messages`. A timeline item either contains a notice or references a message, tool, or operation in the corresponding snapshot collection. Some model-visible messages intentionally have no timeline item.

The timeline has an `epoch`, a per-epoch sequence high-water mark, and ordered items. Successful compaction replaces the active recoverable timeline and advances the epoch. Rewind stays in the same epoch, removes later items, and preserves the sequence high-water mark so sequence numbers are not reused.

User message text is stored raw. Before showing it, remove Tau metadata and any leading `<system>...</system>\n` blocks; the Node SDK exports helpers for this. Apply this only to user messages, never to assistant, tool-result, or system messages.

The first system message is the persona's base prompt. Later system messages are history records, in order, with plain-text `content`, a `timestamp`, and required `metadata`: `{ type: "instruction" | "auto-compaction-continuation", version: 1 }`. The model sees them and they are recoverable. The TUI hides them, and searchable history includes them as system entries. Tau metadata is removed before sending to the provider. System messages cannot contain text-block arrays, named sections, or tool changes.

These later system messages are added without a turn record. Adding one uses the `system-message` delta cause and needs no timeline item. The base prompt has no such metadata, and recovery restores later instructions without duplicating it. Clients cannot insert system messages, and a user's `<system>` text is never turned into one.

Turn requests return a final outcome, and each accepted user turn is also recorded in `snapshot.turns`, keyed by `userHistoryEntryId`. Use this record to tell an unknown request apart from accepted work that is running or finished. Never infer outcomes from notice titles, message counts, or timing.

User-facing behavior such as retry, compaction, rewind, and recovery is described in [sessions](sessions.md).

## Apply snapshot deltas in order

Observed snapshot changes arrive as `session.delta`:

```json
{
  "version": 18,
  "type": "session.delta",
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "fromRevision": 8,
  "toRevision": 9,
  "cause": { "type": "assistant-stream" },
  "delta": {
    "type": "snapshot.patch",
    "changes": [
      {
        "type": "message.content.append",
        "messageId": "assistant-1",
        "text": "Done.",
        "timestamp": 1784463600000
      }
    ]
  }
}
```

For a patch, `fromRevision` must equal your current snapshot revision, and `toRevision` becomes the new one. Apply all `changes` in order, as one unit. Changes can set scalar state, append or replace messages, append streamed content, update the timeline, or set and remove keyed tools, operations, agents, turns, and facets.

`snapshot.reset` carries a complete new snapshot. Its cause is `compaction`, `rewind`, or `resync`, and compaction and rewind include the timeline data needed to validate the change. Use the cause; never guess at a destructive change from the content.

If a patch has an unexpected `fromRevision`, or a change would leave invalid references or ordering, stop applying deltas and call `session.snapshot`. A delta whose `toRevision` you already have is stale; do not replay its effects in the UI.

Node clients can use `applySessionProtocolDelta`, which validates session identity, revision continuity, timeline rules, references, and the resulting snapshot.

## Maintain the independent live-state channels

Some live state is not part of the snapshot. Each of these channels has its own revision or delivery rules.

### Pending user messages

`session.pendingUserMessages` is a full replacement:

```json
{
  "version": 18,
  "type": "session.pendingUserMessages",
  "sessionId": "...",
  "state": {
    "revision": 4,
    "messages": [
      { "id": "pending-1", "mode": "steer", "text": "Use the smaller API." },
      { "id": "pending-2", "mode": "queue", "text": "Run tests afterward." }
    ]
  }
}
```

Replace the whole list, but only when the revision is newer. These revisions are separate from snapshot revisions. All observers share this state while the session is loaded on the host. It is empty after recovery.

### Subagent activities

`session.subagentActivities` carries an independent `revision` and a list of changes. `agent.set` replaces that agent's complete current-run activity list; `agent.remove` deletes it. Apply changes only when the message revision is newer than the installed activity revision. The observe result provides the complete baseline.

Activity lists contain limited assistant text, finished tool cards, and notices. They are live progress information, do not replace `snapshot.agents`, and are empty after recovery.

### Ephemeral events

`session.ephemeral` carries live events that are not guaranteed and have no revision:

- `feedback.notice` is short-lived footer feedback.
- `ephemeral-agent.thread-update` reports progress of an ephemeral context and thread.
- `timeline.item` is a notice that is not saved, with a timeline epoch and sequence number.

Show a `timeline.item` only if its epoch matches your snapshot. After compaction, drop items from the old epoch; after rewind, drop items past the rewind point. Missing ephemeral events never require a resync.

## Delegate client tools

An initialized client that advertised a tool can receive:

```json
{
  "version": 18,
  "type": "session.clientTool.call",
  "sessionId": "...",
  "agentId": "main",
  "callId": "call-1",
  "toolName": "local_picker",
  "arguments": {},
  "ackDeadlineMs": 2000,
  "executionDeadlineMs": 60000
}
```

Acknowledge promptly with `session.clientTool.ack`, optionally with a partial presentation for the running tool card. Start work only after the acknowledgement returns `{ accepted: true }`. Then send exactly one `session.clientTool.result` with `{ ok: true, content }` or `{ ok: false, error }`, optionally with a separate presentation for the finished card. `content` is an ordered array of text and image blocks. Both presentations may contain `subject`, `subjectWrap`, `details`, and `metadata`. The host sets the action and operation and fills in omitted fields. Fields you set are kept unchanged once they pass validation, while defaults are truncated the way Tau truncates its own cards. An empty `details` or `metadata` array hides that default.

A successful result is rejected until the acknowledgement has completed. If preparation fails, send an error result before acknowledging; the host records a preparation failure and the tool never runs. If no result arrives, because of a timeout, cancellation, detach, or other failure, the host shows a complete default card. The result method returns `{ accepted: boolean }`; `false` means the result does not fit the call's current state or the call no longer expects it.

`session.clientTool.cancel` names the session and call, with reason `aborted`, `timeout`, `client-detached`, or `host-failed`. Stop local work and do not send a result. The SDK handles all of this for you. Permissions and execution-environment access for client tools are covered in [client tools](client-tools.md).

## Handle errors and terminal transport failure

Error responses use `ok: false`:

```json
{
  "version": 18,
  "type": "response",
  "id": "req-42",
  "ok": false,
  "error": {
    "code": "busy",
    "message": "a session turn is already running"
  }
}
```

The supported codes are:

| Code | Meaning |
| --- | --- |
| `parse_error` | The JSON payload could not be parsed. |
| `invalid_request` | The envelope, version, type, id, or requested operation is invalid. |
| `method_not_found` | The method is unsupported. |
| `invalid_params` | Method parameters failed validation. |
| `not_found` | The addressed session does not exist on this host. |
| `busy` | Conflicting session work or a same-thread ephemeral submission is active. |
| `cancelled` | Pending input, execution, or sampling was cancelled. |
| `internal_error` | The host could not complete the operation. |

When the request ID cannot be read, the error response uses `id: null`. The error `message` and optional `data` are for diagnostics. Branch on `code`, never on message text.

A WebSocket close, a malformed server message, an unsupported version, or another fatal transport failure rejects all open requests. Stop sending, cancel running client tools, and reconnect or create a new transport on purpose. A WebSocket disconnect only detaches from the long-running host.

## Coordinate concurrent work

The server accepts new requests before earlier ones finish, so responses and streamed messages can interleave.

- Only one main-session turn runs at a time. `session.submit` and `session.retry` return `busy` on conflict.
- `session.queue` waits until the session is idle. `session.steer` joins the running turn at its next safe point. Each request gets its own response when done.
- Session changes run one at a time, in arrival order across all clients. Changes that replace the context can interrupt running work and reject pending input. `session.rewind` instead requires an idle session with no pending input.
- `session.setReasoning` and `session.setAutoCompactThreshold` wait their turn but do not interrupt the running turn. New settings apply from the next logical turn. The running turn and its steering continuations keep their original settings.
- `session.exec` and `session.sample` run alongside everything else: turns, other changes, each other, and ephemeral agents. Clients must coordinate their own use of the workspace.
- Ephemeral contexts are not part of that one-at-a-time ordering. Two submissions to the same ephemeral thread conflict, while different threads can run at once.

A success response may arrive before or after the deltas the request caused. Keep state from the observed streams, match completion by request ID, and call `session.snapshot` when unsure whether you missed something.
