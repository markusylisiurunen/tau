# rpc mode

rpc mode runs tau without the interactive TUI. instead of rendering a terminal UI, tau speaks newline-delimited json (NDJSON) over stdin/stdout.

the same session protocol can also be hosted over WebSocket:

```sh
tau serve --host 0.0.0.0 --port 8787 --auth-token "$TAU_WS_AUTH_TOKEN"
```

and observed from a local TUI:

```sh
tau attach --auth-token "$TAU_WS_AUTH_TOKEN" ws://vps:8787
```

start it like this:

```sh
tau rpc --persona gpt-5.5-coder
```

The terminal UI can attach to any command that exposes this protocol over stdio:

```sh
tau attach -- ssh vps 'cd /repo && tau rpc'
```

Use `tau attach --session <id> -- <command...>` to attach the TUI to an existing stored session id.

Use `tau attach --session <id> ws://host:port` to attach the TUI to an existing stored session on a WebSocket server.

Use `tau attach --new --cwd /path/to/repo ws://host:port` or `tau attach --new --cwd /path/to/repo -- <command...>` to create and attach a fresh hosted session in an already-provisioned host-local directory. Add `--execution-kind cloudflare-sandbox --cloudflare-bridge <id> --cloudflare-sandbox <sandboxId>` or `--execution-kind fly-sprite --fly-api <id> --fly-sprite <name>` to create sessions in those already-provisioned execution environments. Without `--session` or `--new`, attach asks the server for `session.list` and prompts for which session to open; choosing to create a session prompts for the execution environment.

By default, an attached TUI advertises its diff review and input prefill client tools plus command-backed tools from the TUI machine's global Tau config. When multiple TUIs observe one session, pass `--no-client-tools` to every additional TUI so only one client advertises those tools. `prefill_input` fills only an empty editor and refuses to replace a draft the user is already editing. Command-backed tools execute on the attaching TUI machine, never on the host or session execution environment; see README.md for their config and process protocol.

you can still use the applicable startup flags (`--persona`, `--no-agent-context-files`, etc); `--debug`, `--caffeinated`, and `--no-client-tools` are rejected because rpc and serve do not create a TUI session. `--persona` accepts `<id>` or `<id>:<reasoning>`; rpc and serve validate its syntax at startup and resolve the persona only during `session.create` against the selected execution environment. rpc and serve mode start without creating a session or selecting a project cwd; clients must call `session.list`, `session.observe`, or `session.create` with an execution environment. `session.create` resolves session-owned Tau config, model overlays, personas, prompt metadata, skills, project files, and AGENTS.md context from the selected execution environment cwd, then persists the resolved session bootstrap in the session snapshot. Prompt bodies and other large execution-environment content are loaded lazily when used. Component-owned state stays with the component that runs it: the attaching TUI owns local UI config and client-local processes such as the diff tool, the host owns session persistence, orchestration, credentials, and execution-environment lifecycle, and the execution environment owns every agent-visible path, cwd, repository root, project config/content, AGENTS.md file, skill, model overlay, platform value, Node version, and command. These are logical boundaries even when components are physically co-located, and host or TUI filesystem APIs never inspect execution-environment paths. `--caffeinated` is TUI-only and rejected outside TUI mode.

## transport

The session protocol has one semantic request/response/delta contract and multiple transports. Object payloads accept and strip unknown fields while still validating known fields, required fields, discriminators, and method names.

### stdio

- input: stdin
- output: stdout
- framing: one JSON object per line (NDJSON)
- encoding: utf-8

stdin/stdout are reserved for protocol traffic in rpc mode. piped stdin is not treated as an initial user message.

### websocket

- command: `tau serve`
- URL: `ws://host:port`
- framing: one JSON object per text WebSocket message
- encoding: utf-8 JSON text
- auth: if the server starts with `--auth-token <token>` or `TAU_WS_AUTH_TOKEN`, clients provide the same token with `tau attach --auth-token <token> ws://...` or SDK `authToken`

WebSocket auth tokens authorize full session access. Use `wss://` behind a trusted TLS proxy on untrusted networks, avoid token-bearing URLs, and treat logs that capture headers, query strings, or WebSocket handshake details as sensitive.

WebSocket clients receive the same `ready`, `response`, `session.delta`, and `session.ephemeral` payloads as stdio clients. WebSocket servers use the same host/session store as `tau rpc`; closing a client socket unobserves that client, and stopping the server persists hosted sessions in the host session store.

## message types

every protocol message includes `version`.

```json
{ "version": 8, "type": "..." }
```

server-to-client messages are:

- `ready`
- `response`
- `session.delta`
- `session.pendingUserMessages`
- `session.ephemeral`

client-to-server messages are:

- `request`

### ready message

when the rpc server starts, it immediately emits a `ready` line:

```json
{
  "version": 8,
  "type": "ready",
  "methods": [
    "initialize",
    "session.create",
    "session.list",
    "session.observe",
    "session.unobserve",
    "session.record",
    "session.submit",
    "session.queue",
    "session.steer",
    "session.cancelPendingMessages",
    "session.retry",
    "session.exec",
    "session.cancelExec",
    "session.sample",
    "session.interrupt",
    "session.snapshot",
    "session.startGoal",
    "session.resumeGoal",
    "session.clearGoal",
    "session.setReasoning",
    "session.setPersona",
    "session.resolvePrompt",
    "session.autocompletePaths",
    "session.reload",
    "session.compact",
    "session.rewind",
    "session.interruptSubagent",
    "session.ephemeral.create",
    "session.ephemeral.submit",
    "session.ephemeral.close",
    "session.clientTool.ack",
    "session.clientTool.result"
  ]
}
```

`ready` identifies protocol capabilities only. It does not select or create a session.

## lifecycle

rpc lifecycle has two connection states:

- `pre-initialize`: server has emitted `ready`, has not seen `initialize`, and accepts all rpc methods.
- `active`: server has seen `initialize` at least once and still accepts all rpc methods.

state transitions:

- server start enters `pre-initialize` and emits `ready` immediately.
- `initialize` moves `pre-initialize` to `active`.
- repeated `initialize` calls stay in `active` and return `alreadyInitialized: true`.

`initialize` is a handshake signal, not a gate for other methods. clients may call other rpc methods before `initialize`, though most clients should still initialize immediately after `ready`.

`tau rpc` and `tau serve` store session snapshots under `~/.config/tau/sessions` for the current host user. Starting a server does not create a session. `session.create` creates one in an explicitly selected, already-provisioned execution environment, and closing the transport or server persists hosted sessions. Each file uses a versioned `tau-session` storage document whose version is independent of the session protocol version. Tau loads older unwrapped snapshots through sequential storage migrations and rewrites migrated state in the current format during recovery.

Stored sessions recover from persisted snapshot state, including immutable creation attributes and timestamp, independent durable agent revision/context accounting state, current settings, cumulative cost, bootstrap metadata, catalog metadata, execution environment identity, messages, timeline items, tools, and non-agent facets; host-only config is resolved by the host and is not serialized into the snapshot. The separately stored transcript history is for discovery and reading, not session recovery. Supervised subagent runtimes are not recoverable across process restart, so recovery discards persisted agents and agent-owned facets before returning and rewrites the normalized snapshot. The agent revision is not the protocol snapshot revision. A fresh persisted usage checkpoint lets the first model subturn after recovery make the same automatic-compaction decision as an uninterrupted session. Legacy snapshots without a checkpoint wait for fresh provider usage before automatic compaction. Pending queued and steering messages are transient host state rather than snapshot state: they survive client detach while the hosted session remains in memory, but they are discarded on host restart or session recovery so recovered sessions never resume work without new user input.

Main sessions, supervised background agents, and ephemeral threads use the same stateful agent runtime for model streaming, tool admission and execution, retries, recovery, context accounting, steering boundaries, and compaction. The runtime emits ordered semantic transitions through one awaited sink. The hosted-session adapter applies those transitions to protocol snapshots and persists durable state before acknowledging them; child supervision, ephemeral thread maps and forks, pending normal submissions, and usage attribution are separate host concerns.

## requests

all requests use this envelope:

```json
{
  "version": 8,
  "type": "request",
  "id": "req-1",
  "method": "session.submit",
  "params": {
    "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
    "text": "hello"
  }
}
```

rules:

- `id` must be a non-empty string. Tau clients generate UUID strings by default.
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

`initialize` returns protocol metadata and whether initialization already happened. Clients may include `client.tools` to advertise client-provided tools. The host freezes eligible client tools per assistant turn and delegates calls back to the advertising client with `session.clientTool.call` messages; clients answer with `session.clientTool.ack` and `session.clientTool.result`.

```json
{
  "version": 8,
  "type": "response",
  "id": "init-1",
  "ok": true,
  "result": {
    "protocolVersion": 8,
    "methods": [
      "initialize",
      "session.create",
      "session.list",
      "session.observe",
      "session.unobserve",
      "session.record",
      "session.submit",
      "session.queue",
      "session.steer",
      "session.cancelPendingMessages",
      "session.retry",
      "session.exec",
      "session.cancelExec",
      "session.sample",
      "session.interrupt",
      "session.snapshot",
      "session.startGoal",
      "session.resumeGoal",
      "session.clearGoal",
      "session.setReasoning",
      "session.setPersona",
      "session.resolvePrompt",
      "session.autocompletePaths",
      "session.reload",
      "session.compact",
      "session.rewind",
      "session.interruptSubagent",
      "session.ephemeral.create",
      "session.ephemeral.submit",
      "session.ephemeral.close"
    ],
    "alreadyInitialized": false
  }
}
```

`alreadyInitialized` reports whether the server has already seen a prior `initialize` request.

#### session.create

params (required):

```json
{
  "executionEnvironment": {
    "kind": "local",
    "cwd": "/repo",
    "env": {
      "GH_CONFIG_DIR": "/srv/cowork/gh"
    }
  },
  "attributes": {
    "source": "sdk",
    "repository": "github.com/example/project"
  }
}
```

Creates a new hosted session in the selected execution environment and returns its identity. `attributes` is a required bounded map of immutable string pairs used as opaque history provenance and exact-match search fields. Clients call `session.observe` to establish observation and receive the authoritative initial state. Tau resolves config/content from the selected execution environment cwd before creating the runtime, then stores current settings, bootstrap metadata, lightweight catalog metadata, and prompt composition metadata in the snapshot. Prompt bodies and other large execution-environment content are loaded lazily when used. `session.reload` resolves config/content again and replaces the authoritative snapshot.

For local execution environments, `cwd` is resolved on the host, not on the client. They also accept optional `env` overrides for tool processes except `HOME`, which is owned by the execution environment. Tau sanitizes inherited host variables first, then overlays the accepted explicit values unchanged, including sensitive names such as `GH_TOKEN`. All overrides are persisted in the session snapshot, so clients are responsible for protecting the session store when passing secrets.

Cloudflare Sandbox execution environments use host-configured bridge ids and already-provisioned sandbox ids. The `cwd` is a real path inside that sandbox:

```json
{
  "executionEnvironment": {
    "kind": "cloudflare-sandbox",
    "bridgeId": "default",
    "sandboxId": "sandbox_123",
    "cwd": "/workspace/repo"
  },
  "attributes": { "source": "sdk" }
}
```

Tau does not create or provision Cloudflare sandboxes during `session.create`; provider-specific bridge behavior, path validation, command-backed config/content collection, and command cancellation stay inside the Cloudflare execution adapter.

Fly Sprites execution environments use host-configured API ids and already-provisioned Sprite names. The `cwd` is a real path inside that Sprite:

```json
{
  "executionEnvironment": {
    "kind": "fly-sprite",
    "apiId": "default",
    "spriteName": "sprite-123",
    "cwd": "/home/sprite/repo"
  },
  "attributes": { "source": "sdk" }
}
```

Tau does not create or provision Sprites during `session.create`; provider-specific SDK behavior, command-backed config/content collection, command streaming, and path validation stay inside the Fly Sprite execution adapter.

```json
{ "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3" }
```

The snapshot returned by `session.observe` stores current session settings explicitly and does not include a broad `runtimeConfig` blob. If a value is needed by clients, it is promoted to a typed snapshot field. Host-only values stay host-side. Theme files and theme selection are TUI-local presentation state and are not part of the session snapshot.

#### session.list

params (required): `{}`

returns hosted session summaries:

```json
{
  "sessions": [
    { "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3", "lifecycle": "idle" }
  ]
}
```

`lifecycle` is `"idle"` or `"running"`.

#### session.observe

params (required):

```json
{ "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3" }
```

Establishes observation for that session on this connection and returns the authoritative bootstrap state:

```json
{
  "snapshot": {
    "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
    "revision": 1,
    "agentState": {
      "revision": 0,
      "contextEpoch": "8f98c4..."
    },
    "lifecycle": "idle",
    "goal": null,
    "costTotal": 0,
    "settings": {
      "personaId": "gpt-5.5-coder",
      "reasoning": "medium"
    },
    "bootstrap": { "...": "model and prompt bootstrap metadata" },
    "catalog": { "personas": [], "prompts": [], "skills": [] },
    "executionEnvironment": {
      "kind": "local",
      "cwd": "/repo",
      "home": "/home/user"
    },
    "messages": [],
    "timeline": [],
    "tools": {},
    "agents": {},
    "facets": {}
  },
  "pendingUserMessages": {
    "revision": 1,
    "messages": []
  }
}
```

The host buffers snapshot deltas and pending-message replacements while preparing this response. After the response, it sends only updates newer than the returned snapshot and pending-message revisions. Clients therefore install both baselines from the response before applying subsequent events; no separate hydration event is required.

If the session id is not hosted, returns `not_found`.

#### session.unobserve

params (required):

```json
{ "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3" }
```

unobserves this connection from the addressed session without shutting down the hosted session or interrupting active work. The server stops forwarding `session.delta` messages for that session on this connection. Other connections observing the same session are unaffected.

returns:

```json
{ "unobserved": true }
```

#### session.record

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "text": "model-visible user message",
  "historyEntryId": "optional-non-empty-user-entry-id"
}
```

appends a user message and commits a new snapshot without running an assistant turn. This is used by clients for first-class user-authored messages such as returned diff-review feedback. returns:

```json
{
  "snapshot": { "...": "authoritative updated session snapshot" },
  "userHistoryEntryId": "history-..."
}
```

#### session.submit

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "text": "implement this",
  "historyEntryId": "optional-non-empty-user-entry-id"
}
```

behavior:

- appends a user message to session history
- `historyEntryId`, when present, must be a non-empty string and is used as the appended user message history id
- requires the session to be idle, then runs one assistant turn
- streams snapshot changes as broadcast `session.delta` messages with `sessionId`
- automatically compacts when provider-reported context usage crosses the configured threshold
- ends with a success `response`

success result:

```json
{
  "userHistoryEntryId": "history-...",
  "turn": {
    "status": "completed",
    "stopReason": "stop"
  }
}
```

`turn` is a discriminated terminal outcome. completed turns include the model `stopReason`; failed turns use status `failed`, stop reason `error`, and an optional `errorMessage`; interrupted turns use status and stop reason `aborted`. blocked turns include a reason and message instead of a stop reason. currently the only blocked reason is `auto-compaction-failed`, which means tau could not compact safely before continuing the turn. The outcome is also persisted on the submitted user message in session snapshots.

if another turn is already running, tau returns:

```json
{
  "version": 8,
  "type": "response",
  "id": "submit-2",
  "ok": false,
  "error": {
    "code": "busy",
    "message": "a session turn is already running"
  }
}
```

session-specific requests with an unknown `sessionId` return `not_found`.

#### session.queue

params are the same as `session.submit`.

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "text": "run this after the current turn",
  "historyEntryId": "optional-non-empty-user-entry-id"
}
```

behavior:

- if the session is idle, behaves like `session.submit`
- if an assistant turn or direct bash command is active, accepts the request and starts the queued user-message turn after active work settles
- publishes the pending message through `session.pendingUserMessages` until its turn begins
- does not ask the active turn to stop early
- returns the same success shape as `session.submit`

#### session.steer

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "text": "change direction"
}
```

behavior:

- if the session is idle, behaves like `session.submit`
- if an assistant turn is active, accepts the request, asks the active turn to stop at the next safe boundary, batches any additional steering messages in arrival order, and then starts one new turn with a short `<system>` steering instruction plus the batched user messages
- the batched steering turn receives one generated user history entry id shared by every associated response; `session.steer` does not accept a caller-provided history entry id
- publishes pending steering messages through `session.pendingUserMessages` until the steering turn begins
- returns the same success shape as `session.submit`

#### session.cancelPendingMessages

params (required):

```json
{ "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3" }
```

Atomically cancels every pending queued and steering message without interrupting the active turn. The result returns the cancelled messages in effective processing order, steering first and queued messages second:

```json
{
  "cancelled": [
    { "id": "pending-1", "mode": "steer", "text": "change direction" },
    { "id": "pending-2", "mode": "queue", "text": "run tests afterward" }
  ]
}
```

Each cancelled `session.queue` or `session.steer` request receives a `cancelled` error. Cancelling steering also withdraws the requested turn-boundary stop when the active turn has not reached that boundary yet. A turn already stopping at the boundary cannot be resumed.

#### session.retry

params (required):

```json
{ "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3" }
```

behavior:

- runs one assistant turn without appending a user message
- rejects goal-controlled turns with `invalid_request`; clients must use `session.resumeGoal` for a blocked goal
- streams snapshot changes as broadcast `session.delta` messages with `sessionId`
- returns `busy` if another turn is already running or a mutating session request is in progress

success result:

```json
{
  "turn": {
    "status": "completed",
    "stopReason": "stop"
  }
}
```

#### session.exec

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "execId": "exec-0195d6e4",
  "command": "exec \"$0\" \"$@\"",
  "args": ["git", "diff", "--", "src/main.ts"],
  "env": { "GIT_OPTIONAL_LOCKS": "0" },
  "stdinBase64": "aW5wdXQ=",
  "cwd": "/repo",
  "timeoutMs": 30000,
  "maxCaptureBytes": 2097152
}
```

runs `command` in a fresh, non-interactive login Bash belonging to the session execution environment and returns captured output. `execId` is required and must be unique among active executions in the session. Optional `args` are appended after Bash's command string, so the first value becomes `$0` and the rest become `$@`; Tau uses `exec "$0" "$@"` with exact arguments for Node, Git, grep, and file helpers so those executables resolve from the same login-configured `PATH` as model commands without shell quoting. Optional `env` supplies the shell's starting environment overrides except `HOME`, which is owned by the execution environment, and `stdinBase64` supplies up to 16 MiB of binary stdin.

Tau sets `HOME` to the execution environment home, so Bash reads `/etc/profile` and then the first available user login file (`~/.bash_profile`, `~/.bash_login`, or `~/.profile`). Bash also reads inherited `BASH_ENV` when set; otherwise `.bashrc` is loaded only when the login configuration sources it. Login startup files must not write to stdout or stderr, read stdin, require a TTY, or terminate the shell unexpectedly. Tau does not filter or frame startup output. Each call starts a new process, so shell state does not persist.

`output` is stdout and stderr interleaved in arrival order; `stdout` and `stderr` are the split streams. `args`, `env`, `stdinBase64`, `cwd`, `timeoutMs`, and `maxCaptureBytes` are optional. `maxCaptureBytes` overrides the default one-megabyte capture limit for this command, up to 24 MiB. `cwd` is the command working directory, not a confinement boundary; absolute paths are allowed when the execution environment permits them. Exec requests are independent side channels: multiple commands can run concurrently with each other and with session turns, mutations, samples, or ephemeral agents. They do not enter the session mutation queue, change snapshots, or emit deltas. Workspace races are allowed, so clients must coordinate commands when consistency matters. `session.cancelExec` targets one active exec by id; `session.interrupt` remains the explicit session-wide cancellation operation. The command does not add anything to session history; clients that want command output in model context should call `session.record` with their chosen text.

returns:

```json
{
  "output": "interleaved stdout and stderr",
  "stdout": "stdout only",
  "stderr": "stderr only",
  "exitCode": 0,
  "truncated": false,
  "timedOut": false,
  "aborted": false,
  "closeSignal": null
}
```

#### session.cancelExec

params require `sessionId` and `execId`. Cancels only that active `session.exec` operation and returns `{ "cancelled": boolean }`; it does not interrupt turns, samples, or other execs.

#### session.sample

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "context": {
    "systemPrompt": "Classify support tickets.",
    "messages": [
      {
        "role": "user",
        "content": [{ "type": "text", "text": "I cannot log in" }],
        "timestamp": 1784463599000
      }
    ]
  },
  "options": {
    "reasoning": "low",
    "maxTokens": 500
  }
}
```

samples the current persona's model without using or mutating the Tau conversation. `context.systemPrompt`, `context.messages`, and `options` are required; `options.reasoning` and `options.maxTokens` are optional and override the active persona settings. `context.tools` may contain provider-neutral `{ name, description, parameters }` schemas. Tool calls can be returned in the assistant content but are never executed.

The result contains the complete provider-neutral assistant message, including thinking, text, tool calls, provider/model/API identifiers, stop reason, usage/cost, and timestamp:

```json
{
  "message": {
    "role": "assistant",
    "content": [{ "type": "text", "text": "authentication" }],
    "api": "openai-responses",
    "provider": "openai",
    "model": "gpt-5.6-sol",
    "stopReason": "stop",
    "usage": {
      "input": 42,
      "output": 9,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 51,
      "cost": {
        "input": 0.0001,
        "output": 0.0002,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0.0003
      }
    },
    "timestamp": 1784463600000
  }
}
```

The returned message can be appended directly to the next request's `context.messages`. Sampling uses the session only for the active persona model, resolved credentials, model catalog, and persona stream defaults. It does not include the Tau system prompt or history, emit deltas, change snapshot revisions or `costTotal`, write session storage or Tau usage logs, or affect later turns. A terminal assistant message with `stopReason: "error"` is returned faithfully; failures before a final message use the normal protocol error response. `session.interrupt` cancels active samples.

#### session.interrupt

params (required):

```json
{ "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3" }
```

returns:

```json
{
  "interrupted": true,
  "isTurnRunning": true
}
```

`isTurnRunning` can still be `true` immediately after interrupt is requested while active turn, command, maintenance, or sampling cleanup is still in progress.

#### session.snapshot

params (required):

```json
{ "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3" }
```

returns current session state:

- `sessionId`
- `revision` (monotonic protocol snapshot revision for this session id)
- `agentState` (the independent durable agent revision, context epoch, and optional provider usage checkpoint used to resume context accounting after recovery)
- `lifecycle` (`"idle"` or `"running"`)
- `goal` (the persisted `{ objective, status }` goal, or `null`; status is `"active"` or `"blocked"`)
- `settings` (current persona id, reasoning, and service tier)
- `bootstrap` (selected model/provider metadata and prompt-composition metadata)
- `catalog` (lightweight personas, prompt metadata, and skills available to observed clients)
- `executionEnvironment` (where tools/files/commands execute)
- `messages` (complete synchronized transcript with stable message ids)
- `timeline` (default render projection; may omit messages that still exist in `messages`)
- `tools` (semantic tool execution state keyed by tool call id; `streaming` runs expose only tool identity plus draft-message origin, while executable states reference a complete assistant `toolCall` through `call`)
- `agents` (semantic subagent execution state)
- `facets` (client-only structured metadata attached to session/message/tool/agent/operation subjects)

Tool status is projected from semantic runtime outcomes (`succeeded`, `failed`, `blocked`, or `cancelled`). Tool-owned activity only adds presentation facets and never determines or overwrites semantic status.

derive transcript length from `messages.length`; the protocol does not duplicate it. The first committed message is the effective system instruction message. Running state is derived from `lifecycle`, draft/interrupted messages, tools, agents, and operations; there is no `activeTurn` side object. If an assistant turn is interrupted mid-stream, the streamed content is retained as an `interrupted` assistant message and remains model-visible unless the host intentionally marks that record `modelVisible: false`.

User message text in `messages` is the raw recoverable Tau session text. It may start with Tau's internal metadata prefix, which is persisted for recovery but is never sent to the model or shown to users. After that metadata is removed, user text may start with one or more strict hidden model instruction blocks in the form `<system>...</system>\n`; these blocks are sent to the model as part of the user turn but should be hidden from user-facing renderers. Clients that render user messages should derive display text by removing Tau metadata and then removing only leading exact `<system>...</system>\n` blocks from user messages. Do not apply this display projection to assistant, tool, or protocol system messages.

#### session.startGoal

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "objective": "Ship the feature"
}
```

creates an active persisted goal, commits the objective as the visible user message with hidden goal policy, and starts the logical goal run. The request returns the same `{ userHistoryEntryId, turn }` shape as `session.submit`. If an assistant response leaves the goal active, the host appends a hidden continuation turn and runs again. Queued messages wait until the goal is completed, blocked, interrupted, or failed. Creating a second goal fails until the current goal is cleared.

#### session.resumeGoal

params (required):

```json
{ "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3" }
```

changes a blocked goal to active, commits a hidden continuation message, and returns `{ turn }` after the logical goal run settles. Process recovery converts active goals to blocked, so recovery never starts work automatically.

#### session.clearGoal

params (required):

```json
{ "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3" }
```

clears the current goal and returns the updated snapshot. When a goal exists, the mutation interrupts active work first, matching other session-resetting mutations. Without a goal it returns `invalid_request` without interrupting active work or cancelling pending messages.

#### session.setReasoning

params (required):

```json
{ "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3", "reasoning": "high" }
```

sets the session reasoning effort to `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, or `"max"` and returns `{ "revision": number, "settings": { ... } }` with the authoritative updated settings. Observed clients receive a `settings.set` snapshot patch for the same revision. The host applies the settings update through the session mutation queue, but it does not interrupt an active turn or reject queued/steering messages. If a turn is already running, it and any steering continuations retain the spec captured when it started; the new reasoning applies to the next independently submitted or queued turn.

#### session.setPersona

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "personaId": "gpt-5.5-coder"
}
```

sets the session persona by id from the session snapshot catalog and returns the authoritative updated session snapshot. The host applies the change through the session mutation queue so it does not race another mutating request or an active turn.

#### session.resolvePrompt

params (required):

```json
{ "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3", "promptId": "fix" }
```

loads the current prompt body from the session execution environment and returns it:

```json
{
  "promptId": "fix",
  "text": "Prompt body loaded from disk at call time..."
}
```

Prompt catalog entries in the snapshot are intentionally lightweight and do not include prompt template text. Clients use the catalog for autocomplete and call `session.resolvePrompt` when a prompt is actually invoked.

#### session.autocompletePaths

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "query": "src tui",
  "limit": 25
}
```

returns bounded path suggestions from the session execution environment:

```json
{
  "paths": ["src/tui/session_chat_app.ts", "src/tui/session_chat_controller.ts"]
}
```

Path suggestions are intentionally not stored in `session.snapshot`; clients call this method when file/path autocomplete is needed. Results may include directory entries with trailing `/`.

#### session.reload

params (required):

```json
{ "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3" }
```

reloads config/content from the session execution environment, refreshes the session catalog, rebuilds the active persona prompt context, and returns the authoritative updated session snapshot plus warning strings and counts for personas, prompts, and skills. Themes are TUI-local and are not part of this result. The host applies the change through the session mutation queue so it does not race another mutating request or an active turn.

#### session.compact

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "mode": "summary-only",
  "guidance": "preserve decisions"
}
```

`mode` is `"summary-only"` or `"summary-and-last"`. `guidance` is optional.

manually compacts the session into one synthetic user summary message and returns:

```json
{
  "snapshot": { "...": "authoritative updated session snapshot" },
  "compactionMessage": "summary text rendered in the compacted history",
  "includedLastAssistant": false
}
```

the host applies compaction through the session mutation queue, interrupts any running turn, waits for in-flight submit handling to settle, and rejects pending steering submits. Clients should render the returned `snapshot` as authoritative session state; `compactionMessage` and `includedLastAssistant` describe the operation result and are not stored UI state.

#### session.interruptSubagent

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "subagentId": "subagent-..."
}
```

interrupts the current run of a subagent in the hosted session without disposing its reusable thread. returns `{ "found": true }` when the subagent id was known and `{ "found": false }` otherwise.

#### session.ephemeral.create

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "instructions": "You are helping with a focused code review...",
  "tools": ["bash", "view_image"]
}
```

creates a host-owned ephemeral agent context outside the persisted session timeline. The context inherits the hosted session persona and execution environment, appends the provided instructions, uses the requested tool set, and returns `{ "contextId" }`. Ephemeral context creation, submission, and closure run independently of main-session turns and mutations. These contexts are not persisted in `session.snapshot` and are not recoverable after disconnect or host restart.

#### session.ephemeral.submit

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "contextId": "ephemeral-...",
  "threadId": "thread-...",
  "message": "explain this comment"
}
```

submits a message to an ephemeral agent thread and returns `{ "threadId", "response" }`. `forkFromThreadId` is optional and creates a new thread fork from a previous idle thread in the same context.

#### session.ephemeral.close

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "contextId": "ephemeral-..."
}
```

closes a host-owned ephemeral context and interrupts/disposes any live threads. returns `{ "closed": true }` when the context existed.

## session deltas

observed-session changes are broadcast as `session.delta` messages:

```json
{
  "version": 8,
  "type": "session.delta",
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "fromRevision": 1,
  "toRevision": 2,
  "reason": "assistant-stream",
  "delta": {
    "type": "snapshot.patch",
    "changes": [
      {
        "type": "message.content.append",
        "messageId": "assistant-1",
        "text": "partial text",
        "timestamp": 1782850001000
      }
    ]
  }
}
```

`fromRevision` must match the client's current snapshot revision before applying a patch. If it does not, the client missed a delta and should call `session.snapshot`. `fromRevision` is `null` only for a full reset:

```json
{
  "version": 8,
  "type": "session.delta",
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "fromRevision": null,
  "toRevision": 7,
  "reason": "recovery",
  "delta": {
    "type": "snapshot.reset",
    "snapshot": { "...": "complete authoritative session snapshot" }
  }
}
```

`snapshot.patch` changes include lifecycle, goal, message, timeline, tool, agent, and facet updates. High-rate assistant streaming uses `message.content.append` after the draft assistant message exists so clients do not receive the full accumulated assistant text on every frame. A content append targets only draft assistant messages and must include non-empty `text` and/or `thinking`; when a thinking block is created, clients insert it before the text block so applying patches reconstructs the canonical assistant content order. Maintenance operations such as reload, rewind, and compaction may use `snapshot.reset` when replacing the complete state is clearer than sending a long patch sequence.

`reason` describes why the transition happened and is for logging, animation, and client policy. Correctness comes from applying the delta. Current reasons are `user-message`, `assistant-stream`, `assistant-message`, `tool-run`, `tool-result`, `notice`, `agent-run`, `maintenance`, `configuration`, `goal`, and `recovery`.

notes:

- every delta includes `sessionId`.
- deltas do not include `requestId`; request ids correlate request/response pairs, while deltas are broadcast facts about observed session state.
- queued and steering requests each receive their own response when accepted work settles.
- notices and maintenance operations are stored as timeline items, so late-attaching clients can reconstruct them from `session.snapshot`.
- tool progress, tool UI payloads, and subagent progress are stored in `tools`, `agents`, and `facets` instead of live-only side-channel events.

## pending user messages

`session.pendingUserMessages` replaces the current non-persisted pending-message facet for an observed in-memory session:

```json
{
  "version": 8,
  "type": "session.pendingUserMessages",
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "state": {
    "revision": 3,
    "messages": [
      { "id": "pending-1", "mode": "steer", "text": "change direction" },
      { "id": "pending-2", "mode": "queue", "text": "run tests afterward" }
    ]
  }
}
```

Pending-message revisions are independent from snapshot revisions. Each event replaces only the pending-message list. The initial baseline is included in the `session.observe` result, and later replacements are sent while the connection observes that session. Pending steering messages are ordered before queued messages because steering has processing priority.

Pending messages are shared across attached clients and survive client detach while the hosted session remains in memory. They are not written to the session store and start empty when a session is recovered from disk. They must not be folded into `session.snapshot` or applied with `applySessionProtocolDelta`. Future non-persisted features should define their own independently revisioned facets rather than extending this replacement payload.

## ephemeral events

`session.ephemeral` messages carry non-recoverable observed-session activity that is intentionally not stored in `SessionSnapshot`. The current use is live ephemeral-agent progress:

```json
{
  "version": 8,
  "type": "session.ephemeral",
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "event": {
    "type": "ephemeral-agent.thread-update",
    "contextId": "ephemeral-...",
    "threadId": "thread-...",
    "update": {
      "costTotal": 0.001,
      "usage": {
        "input": 1000,
        "output": 200,
        "cacheRead": 0,
        "cacheWrite": 0,
        "contextWindowUsageTokens": 1200,
        "contextWindow": 200000
      },
      "lastActivityText": "bash: npm test failed"
    }
  }
}
```

Clients must treat ephemeral events as best-effort live progress only. If a client misses them or attaches later, it should not expect to recover that state from `session.snapshot`.

## errors

error responses use:

```json
{
  "version": 8,
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
- `invalid_request`: malformed envelope or bad version/type/id
- `method_not_found`: unsupported method
- `invalid_params`: params failed method validation
- `not_found`: requested session does not exist on this host
- `busy`: overlapping main-session turns, same-thread ephemeral submissions, or activity rejected while a mutating request is in progress
- `cancelled`: a pending queued/steering request, execution command, or model sample was cancelled
- `internal_error`: unexpected runtime failure

for lines that cannot produce a valid request id (for example malformed json), `id` is `null`.

## concurrency and ordering

`runRpcServer` handles incoming lines concurrently with explicit serialization for mutating transitions. this means:

- multiple requests can be accepted before earlier ones complete
- `session.record`, `session.clearGoal`, `session.setReasoning`, `session.setPersona`, `session.reload`, `session.compact`, `session.rewind`, and `session.interruptSubagent` run through a session-owned mutation queue (arrival order across clients observed to the same live session)
- `session.setReasoning` updates settings immediately without interrupting an active turn; the active turn and its steering continuations keep their captured spec, and the new setting applies to the next independently submitted or queued turn
- `session.rewind` requires no active submit or pending user work and fails with `busy` without interrupting or cancelling anything
- only one `session.submit`, `session.retry`, `session.startGoal`, or `session.resumeGoal` turn can run at once (`busy` otherwise)
- `session.exec` and `session.sample` calls can run concurrently with each other and with normal session work; they never enter the mutation queue, and `session.cancelExec` targets one exec without interrupting the others
- `session.ephemeral.create`, `session.ephemeral.submit`, and `session.ephemeral.close` manage independent, non-persisted contexts outside the main-session mutation queue; only overlapping submissions to the same ephemeral thread return `busy`
- `session.queue` can be accepted during active main-session work and runs after the active turn settles
- `session.steer` can be accepted during active model work or between autonomous goal continuations and runs at the next safe boundary before goal work continues
- `session.cancelPendingMessages` atomically removes pending queue and steering requests without interrupting active work
- `session.submit` and `session.retry` are rejected with `busy` while a queued/running main-session mutation exists
- responses and deltas may still interleave

clients should route responses by `id` and broadcast deltas by `sessionId`, not by arrival order alone.
