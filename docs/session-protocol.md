# Session protocol

Tau's session protocol is the public wire contract for clients that create, observe, and control hosted sessions through `tau serve`. Node applications can usually use the typed [Node SDK](node-sdk.md) instead.

The protocol is transport-neutral and request and response based, with separate server messages for observed state, pending input, subagent activity, ephemeral feedback, and delegated client tools. Tau currently exposes it over WebSocket. The complete method surface is in the [session protocol method reference](session-protocol-methods.md).

## Connect over WebSocket

`tau serve` uses one UTF-8 JSON object per text WebSocket message. Binary messages are not supported. Authentication, TLS, listener setup, SSH tunneling, and host lifetime belong to [remote sessions](remote-sessions.md).

The server exposes one host. Starting it does not create or select a session. A client lists, creates, or observes sessions explicitly.

The client, host, and execution environment remain separate logical machines even when they share a process or filesystem. Session paths and commands belong to the execution environment. Persistence, credentials, model work, and protocol coordination belong to the host. Client tools and local UI belong to the connected client. See [ownership and scope](ownership-and-scope.md) before passing paths or credentials across this boundary.

## Connect and initialize

The server sends `ready` as its first message:

```json
{
  "version": 13,
  "type": "ready",
  "methods": ["initialize", "session.create", "session.list"]
}
```

The actual `methods` array contains the complete supported method set, not only the shortened example above. Protocol versioning is exact rather than negotiated. A client and host that disagree on `version` must use compatible Tau releases.

After `ready`, send `initialize` with non-empty client metadata:

```json
{
  "version": 13,
  "type": "request",
  "id": "init-1",
  "method": "initialize",
  "params": {
    "client": { "name": "acme-editor", "version": "1.4.0" }
  }
}
```

A successful result returns `protocolVersion`, the complete `methods` array, and `alreadyInitialized`. Repeating `initialize` is allowed and reports `alreadyInitialized: true`. Initialization is a handshake signal, not a session operation, but clients should complete it before other requests.

An initializing client may advertise in-process client tools through `client.tools`. Tool calls are then delegated over this connection. The [client tools](client-tools.md) page owns tool behavior, authority, and command-backed helpers; this page describes the wire messages required by a raw protocol client.

## Send requests and match responses

Every request has the same envelope:

```json
{
  "version": 13,
  "type": "request",
  "id": "req-42",
  "method": "session.snapshot",
  "params": { "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3" }
}
```

`id` is a non-empty client-chosen string and must identify the outstanding request on that connection. `params` is always required, including `{}` for `session.list`. The host validates required fields, field types, discriminators, method names, and the exact protocol version. Unknown object fields are accepted and stripped.

Successful responses echo the request id:

```json
{
  "version": 13,
  "type": "response",
  "id": "req-42",
  "ok": true,
  "result": { "sessionId": "..." }
}
```

A request can remain open while the host emits state messages or handles later requests. Route responses by `id`, never by arrival order. Route streamed messages by `sessionId`.

## Observe before consuming session state

`session.create` creates a hosted session but does not observe it. `session.observe` establishes observation on this connection and returns three authoritative baselines together:

```json
{
  "snapshot": { "sessionId": "...", "revision": 8 },
  "pendingUserMessages": { "revision": 3, "messages": [] },
  "subagentActivities": { "revision": 5, "agents": {} }
}
```

Install all three baselines before processing later messages for that session. The host buffers updates while preparing the observe response and sends only updates newer than the returned revisions afterward.

Observation controls delivery, not session ownership. `session.unobserve` stops this connection's updates without deleting the session or interrupting work. Several connections may observe the same session, and every observer can mutate it. Client-tool names must remain unique across observing clients.

## Treat the snapshot as authoritative

`SessionProtocolSnapshot` is the recoverable public state for one session. Its major fields are:

| Field | Meaning |
| --- | --- |
| `sessionId`, `attributes`, `createdAt` | Identity and immutable creation metadata. |
| `revision` | Monotonic protocol snapshot revision. |
| `lifecycle` | `idle` or `running`. |
| `agentState` | Independent agent revision, model context key, and optional usage checkpoint. |
| `goal`, `settings`, `costTotal` | Current goal, persona and reasoning settings, and accumulated session cost. |
| `bootstrap`, `catalog` | Selected model and prompt metadata plus available personas, prompt metadata, and skills. |
| `executionEnvironment` | The environment kind, identity, `cwd`, and home used for agent-visible work. |
| `messages`, `turns` | Synchronized model-facing records and durable logical-turn receipts. |
| `timeline` | Ordered active transcript placement. |
| `tools`, `operations`, `agents` | Mutable semantic state referenced by timeline items or client views. |
| `facets` | Versioned client-facing metadata. Unknown facet kinds and versions should be ignored. |

Render active transcript order from `timeline.items`, not by sorting or filtering `messages`. A timeline item either contains a notice or references a message, tool, or operation in the corresponding snapshot collection. Some model-visible messages intentionally have no timeline item.

The timeline has an `epoch`, a per-epoch sequence high-water mark, and ordered items. Successful compaction replaces the active recoverable timeline and advances the epoch. Rewind stays in the same epoch, removes later items, and preserves the sequence high-water mark so sequence numbers are not reused.

User message text is raw recoverable session text. User-facing renderers should remove Tau metadata and leading exact `<system>...</system>\n` blocks. The Node SDK exports projection helpers for this purpose. Do not apply user-text projection to assistant, tool-result, or protocol system messages.

Turn requests return a terminal outcome, and accepted user turns are also keyed by `userHistoryEntryId` in `snapshot.turns`. Use that ledger to distinguish an unknown request from accepted running work and settled work. Do not infer request outcomes from notice titles, message counts, or timing.

User-facing behavior such as goals, retry, compaction, rewind, and recovery is described in [sessions](sessions.md).

## Apply snapshot deltas in order

Observed snapshot changes arrive as `session.delta`:

```json
{
  "version": 13,
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

For a patch, `fromRevision` must equal the installed snapshot revision and `toRevision` becomes the new revision. Apply every `changes` entry atomically and in order. Changes can set scalar state, append or replace messages, append streamed content, update the timeline, or set and remove keyed tools, operations, agents, turns, and facets.

`snapshot.reset` carries a complete replacement snapshot. Reset causes identify `compaction`, `rewind`, or `resync`; compaction and rewind include the timeline data needed to validate the transition. Use the structured cause rather than inferring destructive transitions from content.

If a patch has an unexpected `fromRevision`, or applying any change would produce invalid references or ordering, stop applying deltas and call `session.snapshot`. Deltas whose `toRevision` is already installed are stale and must not replay client presentation transitions.

Node clients can use `applySessionProtocolDelta`, which validates session identity, revision continuity, timeline rules, references, and the resulting snapshot.

## Maintain the independent live-state channels

Not all observed state belongs in the recoverable snapshot. Each live channel has its own revision or delivery semantics.

### Pending user messages

`session.pendingUserMessages` is a full replacement:

```json
{
  "version": 13,
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

Replace the complete pending list only when its revision is newer. Pending revisions are independent of snapshot revisions. This state is shared by observers while the hosted session remains in memory, but it starts empty after recovery.

### Subagent activities

`session.subagentActivities` carries an independent `revision` and a list of changes. `agent.set` replaces that agent's complete current-run activity list; `agent.remove` deletes it. Apply changes only when the message revision is newer than the installed activity revision. The observe result provides the complete baseline.

Activity lists contain bounded assistant text, settled tool presentations, and notices. They are transient supervision state, not a substitute for `snapshot.agents`, and they start empty after recovery.

### Ephemeral events

`session.ephemeral` carries best-effort live events with no channel revision:

- `feedback.notice` is temporary footer feedback.
- `ephemeral-agent.thread-update` reports live progress for an ephemeral context and thread.
- `timeline.item` is a non-recoverable notice with an active timeline epoch and allocated sequence.

A `timeline.item` can be merged into current presentation only when its epoch matches the installed snapshot. Discard old-epoch items after compaction and post-cutoff items after rewind. Missing ephemeral events do not require resynchronization.

## Delegate client tools

An initialized client that advertised a tool can receive:

```json
{
  "version": 13,
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

Acknowledge promptly with `session.clientTool.ack`, optionally including a bounded partial running presentation. Begin execution only after the acknowledgement returns `{ accepted: true }`, then send exactly one `session.clientTool.result` with either `{ ok: true, content }` or `{ ok: false, error }` and an optional independent terminal presentation. Both presentation objects may contain `subject`, `subjectWrap`, `details`, and `metadata`; the host owns action and operation and supplies every omitted field. Explicit fields are preserved unchanged after protocol safety validation, while generated defaults use Tau's canonical display truncation. Empty detail or metadata arrays suppress those defaults.

A successful result is rejected until acknowledgement has completed. If preparation itself fails, send an error result before acknowledgement; the host records it as a preparation failure without authorizing execution. If no result arrives because of timeout, cancellation, detach, or another failure, the host renders a complete fallback terminal presentation. The result method returns `{ accepted: boolean }`; `false` means the message is invalid for the call's current state or the call is no longer waiting for it.

`session.clientTool.cancel` names the session and call with reason `aborted`, `timeout`, `client-detached`, or `host-failed`. Abort local work and do not send a late result. The SDK implements this lifecycle automatically. Tool execution authority and the execution-environment facade are covered in [client tools](client-tools.md).

## Handle errors and terminal transport failure

Error responses use `ok: false`:

```json
{
  "version": 13,
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

When no valid request id can be recovered, an error response uses `id: null`. Error `message` and optional `data` are diagnostic. Branch on `code`, not message text.

A WebSocket close, malformed server payload, unsupported version, or other terminal transport failure rejects all outstanding requests. Stop sending, cancel client-local delegated tools, and reconnect or create a new transport deliberately. A WebSocket disconnect detaches from the long-running host.

## Coordinate concurrent work

The server can accept several requests before earlier requests settle, so responses and streamed messages may interleave.

- Only one ordinary main-session turn or goal turn runs at a time. `session.submit`, `session.retry`, `session.startGoal`, and `session.resumeGoal` return `busy` on conflict.
- `session.queue` waits for idle work. `session.steer` requests the next safe turn boundary. Each request receives its own eventual response.
- Session mutations are serialized in arrival order across clients. Mutations that replace context can interrupt active work and reject pending input. `session.rewind` instead requires the session to be idle with no pending input.
- `session.setReasoning` is serialized but does not interrupt the active turn. The new setting applies to the next independently started turn.
- `session.exec` and `session.sample` are side channels. They can overlap turns, mutations, each other, and ephemeral agents. Clients own workspace coordination.
- Ephemeral contexts run outside the main mutation queue. Two submissions to the same ephemeral thread conflict, while different threads can run independently.

Do not assume a success response arrives before the deltas caused by that request. Maintain state from the observed streams, correlate completion by request id, and use `session.snapshot` when continuity is uncertain.
