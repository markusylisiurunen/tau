# Session protocol

This is the protocol that clients use to control sessions hosted by `tau serve`. Node applications can use the [SDK](sdk.md) instead. This page explains the model and lists the methods. For exact field types, read `@markusylisiurunen/tau/sdk` or `src/protocol/session_protocol.ts` in the [source](https://github.com/markusylisiurunen/tau).

## Messages

Each WebSocket text message is one JSON object. Authentication and deployment are in [remote sessions](remote-sessions.md). The server speaks first, and the versions must match exactly:

```json
{ "version": 19, "type": "ready", "methods": ["initialize", "session.create"] }
```

Use the `version` the server sends. Then send `initialize`, optionally advertising client tools:

```json
{
  "version": 19,
  "type": "request",
  "id": "init-1",
  "method": "initialize",
  "params": { "client": { "name": "acme-editor", "version": "1.4.0" } }
}
```

Responses echo the request ID. A request can stay open while other messages arrive, so route responses by `id` and streamed messages by `sessionId`.

```json
{ "version": 19, "type": "response", "id": "req-42", "ok": true, "result": {} }
{ "version": 19, "type": "response", "id": "req-42", "ok": false, "error": { "code": "busy", "message": "..." } }
```

Error codes are `parse_error`, `invalid_request`, `method_not_found`, `invalid_params`, `not_found`, `busy`, `cancelled`, and `internal_error`. Branch on the code, never on the message.

## Session state

```ts
// session.create
params: {
  executionEnvironment:
    | { kind: "local"; cwd: string; env?: Record<string, string> }
    | { kind: "fly-sprite"; spriteName: string; cwd: string };
  attributes: Record<string, string>; // required, can be empty
  personaId?: string;
  reasoning?: Reasoning;
  autoCompactThresholdTokens?: number | null;
}
result: { sessionId: string }
```

`session.create` does not observe a session. `session.observe` starts updates on this connection and returns three starting states: `snapshot`, `pendingUserMessages`, and `subagentActivities`. Install all three before processing later messages. Several connections can observe one session, and each can change it.

The **snapshot** is the saved state of a session. Important fields:

- `revision`, `lifecycle` (`idle` or `running`), `settings`, `costTotal`
- `bootstrap` and `catalog`: the selected model and prompt, and available personas, prompts, skills, and MCP servers
- `executionEnvironment`: kind, identity, `cwd`, and home
- `messages`: what the model sees
- `timeline`: what to render, in order, referencing messages, `tools`, and `operations`
- `turns`: a record for each accepted turn, keyed by `userHistoryEntryId`
- `agents`: subagents

Render from `timeline.items`, because some model-visible messages have no timeline item. User text is stored raw, so remove Tau metadata and leading `<system>...</system>` blocks before showing it. Use `turns` to find out what happened to a request, and do not infer outcomes from notices or message counts.

**Deltas** update the snapshot:

```json
{
  "version": 19,
  "type": "session.delta",
  "sessionId": "...",
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

`fromRevision` must match your revision. Apply all changes in order as one unit. A `snapshot.reset` carries a complete new snapshot, and its cause is `compaction`, `rewind`, or `resync`. If a revision is unexpected, stop applying and call `session.snapshot`.

Three other channels are separate from the snapshot, are not saved, and are empty after recovery:

- `session.pendingUserMessages` replaces the whole pending list when its own revision is newer.
- `session.subagentActivities` carries per-agent changes (`agent.set`, `agent.remove`) with its own revision.
- `session.ephemeral` carries live notices, which are not guaranteed to arrive and never need a resync. Show a `timeline.item` only if its epoch matches your snapshot.

## Concurrency

One main-session turn runs at a time, and `session.submit` and `session.retry` return `busy` on conflict. `session.queue` waits for idle, and `session.steer` joins the running turn. Session changes run one at a time across all clients. `session.exec`, `session.sample`, and ephemeral threads run alongside everything else.

## Client tools

A client that advertised a tool receives `session.clientTool.call`. Answer with `session.clientTool.ack` before `ackDeadlineMs`, and start work only after it returns `{ accepted: true }`. Then send one `session.clientTool.result`. If `session.clientTool.cancel` arrives, stop and send no result.

## Keeping a session loaded

A host keeps a session loaded while a client observes it, retention is active, or work is running. `session.setRetention` keeps an unattached session and its idle subagents available for a period. Retention exists only in memory and ends when the host shuts down.

Before deleting files that a session uses:

1. Clear retention with `durationMs: null`, and unobserve.
2. Call `session.collect`.
3. Delete the files only if it returns `disposed: true`. Otherwise keep them and retry later.

## Methods

Every request has `params`, even if empty. All `session.*` methods take `sessionId`, except `session.create` and `session.list`.

| Method | Purpose |
| --- | --- |
| `initialize` | Identify the client and advertise client tools. |
| `session.create` | Create a session in an execution environment. |
| `session.list` | List sessions on this host. |
| `session.observe` | Start updates and return starting states. |
| `session.unobserve` | Stop updates without touching the session. |
| `session.setRetention` | Set or clear the retention period. |
| `session.collect` | Unload the session if nothing holds it, and report `disposed`. |
| `session.record` | Append user text without running a turn. |
| `session.submit` | Append user text and run a turn on an idle session. |
| `session.queue` | Run a turn now, or when the session is idle. |
| `session.steer` | Add input to the running turn. |
| `session.cancelPendingMessages` | Cancel queued and steering input. |
| `session.retry` | Run a turn from current history. |
| `session.interrupt` | Stop turns, commands, samples, and maintenance. |
| `session.exec` | Run a command in the execution environment, outside the conversation. |
| `session.cancelExec` | Cancel one running command. |
| `session.sample` | Run a standalone model call with supplied context. |
| `session.snapshot` | Return the current snapshot. |
| `session.setAutoCompactThreshold` | Set the compaction threshold from the next turn. |
| `session.setReasoning` | Set reasoning from the next turn. |
| `session.setPersona` | Apply a persona and optional settings. |
| `session.resolvePrompt` | Load a prompt body. |
| `session.autocompletePaths` | Suggest paths from the execution environment. |
| `session.reload` | Reload configuration and content. |
| `session.compact` | Replace the model's context with a summary. |
| `session.rewind` | Remove a user message and everything after it. |
| `session.interruptSubagent` | Interrupt one subagent's run. |
| `session.ephemeral.create` | Create an unsaved agent context. |
| `session.ephemeral.submit` | Run or continue an ephemeral thread. |
| `session.ephemeral.close` | Close a context and its threads. |
| `session.clientTool.ack` | Acknowledge a client tool call. |
| `session.clientTool.result` | Complete a client tool call. |
