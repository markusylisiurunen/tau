# rpc mode

rpc mode runs tau without the interactive TUI. instead of rendering a terminal UI, tau speaks newline-delimited json (NDJSON) over stdin/stdout.

start it like this:

```sh
tau rpc --persona gpt-5.2-coder --risk read-only
```

you can still use the usual startup flags (`--persona`, `--risk`, `--sandbox`, `--load`, `--no-agent-context-files`, etc). `--persona` accepts `<id>` or `<id>:<reasoning>`. rpc mode uses the same config/persona loading and runtime as TUI mode. `--caffeinated` is TUI-only and rejected in rpc mode.

## transport

- input: stdin
- output: stdout
- framing: one JSON object per line (NDJSON)
- encoding: utf-8

stdin/stdout are reserved for protocol traffic in rpc mode. piped stdin is not treated as an initial user message.

## message types

every protocol message includes `version`.

```json
{ "version": 1, "type": "..." }
```

server-to-client messages are:

- `ready`
- `response`
- `event`

client-to-server messages are:

- `request`

### ready message

when the rpc server starts, it immediately emits a `ready` line:

```json
{
  "version": 1,
  "type": "ready",
  "sessionId": "tau-main-...",
  "methods": [
    "initialize",
    "session.submit",
    "session.interrupt",
    "session.snapshot",
    "session.reset",
    "session.shutdown"
  ],
  "coreEventVersion": 1
}
```

`sessionId` is the active session id at startup.

## requests

all requests use this envelope:

```json
{
  "version": 1,
  "type": "request",
  "id": "req-1",
  "method": "session.submit",
  "params": { "text": "hello" }
}
```

rules:

- `id` must be a string or number.
- `method` must be one of the supported rpc methods.
- `params` are validated per method.
- unsupported extra top-level request fields are rejected.
- unsupported extra fields inside `params` are rejected.

### methods

#### initialize

params (required):

```json
{ "client": { "name": "my-client", "version": "0.1.0" } }
```

`initialize` returns protocol metadata and whether initialization already happened:

```json
{
  "version": 1,
  "type": "response",
  "id": "init-1",
  "ok": true,
  "result": {
    "protocolVersion": 1,
    "sessionId": "tau-main-...",
    "methods": [
      "initialize",
      "session.submit",
      "session.interrupt",
      "session.snapshot",
      "session.reset",
      "session.shutdown"
    ],
    "alreadyInitialized": false
  }
}
```

note: tau does not require `initialize` before other methods, but most clients should still call it as a handshake.

#### session.submit

params (required):

```json
{ "text": "implement this", "historyEntryId": "optional-user-entry-id" }
```

behavior:

- appends a user message to session history
- runs one assistant turn
- streams core events as `event` messages with `requestId`
- ends with a success `response`

if another turn is already running, tau returns:

```json
{
  "version": 1,
  "type": "response",
  "id": "submit-2",
  "ok": false,
  "error": {
    "code": "busy",
    "message": "a session turn is already running"
  }
}
```

#### session.interrupt

params (required): `{}`

returns:

```json
{
  "interrupted": true,
  "isTurnRunning": true
}
```

`isTurnRunning` can still be `true` immediately after interrupt is requested while shutdown/cleanup is still in progress.

#### session.snapshot

params (required): `{}`

returns current session state:

- `sessionId`
- `isTurnRunning`
- `historyLength`
- `history` (plain message array)
- `historyEntries` (message array with stable entry ids)

#### session.reset

params (required): `{}`

behavior:

- participates in a server-side mutation queue with `session.shutdown`
- interrupts any running turn
- waits for in-flight submit handling to settle
- clears history and creates a new session id

concurrent reset calls are processed in arrival order (ordered transitions, not collapse). response includes both previous and new session ids.

#### session.shutdown

params (required): `{}`

behavior:

- participates in a server-side mutation queue with `session.reset`
- interrupts any running turn
- waits for in-flight submit handling to settle
- stops forwarding streamed core events
- marks rpc server as shut down

concurrent shutdown calls are idempotent (`{ "shutdown": true }`). after shutdown, non-`initialize` requests return `invalid_request` (`"rpc server is shut down"`).

## events

events are wrapped core events:

```json
{
  "version": 1,
  "type": "event",
  "requestId": "submit-1",
  "event": {
    "version": 1,
    "event": {
      "type": "assistant_partial",
      "historyEntryId": "history-...",
      "snapshot": { "text": "..." }
    }
  }
}
```

notes:

- events tied to `session.submit` include `requestId`.
- `subagent_ui` events include stable `requestId` correlation to the submit that spawned the subagent run, even when the update arrives during a later submit.
- `subagent_ui` core events include `originHistoryEntryId` for explicit origin correlation.
- core event payloads follow `src/core/events/types.ts`.

## errors

error responses use:

```json
{
  "version": 1,
  "type": "response",
  "id": "req-1",
  "ok": false,
  "error": {
    "code": "invalid_params",
    "message": "session.submit params.text must be a string",
    "data": {}
  }
}
```

error codes:

- `parse_error`: invalid json line
- `invalid_request`: malformed envelope, bad version/type/id, or shut down server
- `method_not_found`: unsupported method
- `invalid_params`: params failed method validation
- `busy`: overlapping `session.submit` or submit rejected while a mutating request is in progress
- `internal_error`: unexpected runtime failure

for lines that cannot produce a valid request id (for example malformed json), `id` is `null`.

## concurrency and ordering

`runRpcServer` handles incoming lines concurrently with explicit serialization for mutating transitions. this means:

- multiple requests can be accepted before earlier ones complete
- `session.reset` and `session.shutdown` run through a shared mutation queue (arrival order)
- only one `session.submit` can run at once (`busy` otherwise)
- `session.submit` is rejected with `busy` while a queued/running reset or shutdown mutation exists
- responses/events from different request ids may still interleave

clients should route by `id` and `requestId`, not by arrival order alone.
