# rpc mode

rpc mode runs tau without the interactive TUI. instead of rendering a terminal UI, tau speaks newline-delimited json (NDJSON) over stdin/stdout.

the same session protocol can also be hosted over WebSocket:

```sh
tau serve --host 0.0.0.0 --port 8787 --auth-token "$TAU_WS_AUTH_TOKEN" --risk read-only
```

and observed from a local TUI:

```sh
tau attach --auth-token "$TAU_WS_AUTH_TOKEN" ws://vps:8787
```

start it like this:

```sh
tau rpc --persona gpt-5.4-coder --risk read-only
```

The terminal UI can attach to any command that exposes this protocol over stdio:

```sh
tau attach -- ssh vps 'cd /repo && tau rpc --risk read-only'
```

Use `tau attach --session <id> -- <command...>` to attach the TUI to an existing stored session id.

Use `tau attach --session <id> ws://host:port` to attach the TUI to an existing stored session on a WebSocket server.

Use `tau attach --new --cwd /path/to/repo ws://host:port` or `tau attach --new --cwd /path/to/repo -- <command...>` to create and attach a fresh hosted session in an already-provisioned host-local directory. Add `--execution-kind cloudflare-sandbox --cloudflare-bridge <id> --cloudflare-sandbox <sandboxId>` or `--execution-kind fly-sprite --fly-api <id> --fly-sprite <name>` to create sessions in those already-provisioned execution environments. Without `--session` or `--new`, attach asks the server for `session.list` and prompts for which session to open; choosing to create a session prompts for the execution environment.

you can still use the usual startup flags (`--persona`, `--risk`, `--no-agent-context-files`, etc). `--persona` accepts `<id>` or `<id>:<reasoning>`. rpc and serve mode start without creating a session or selecting a project cwd; clients must call `session.list`, `session.observe`, or `session.create` with an execution environment. `session.create` resolves session-owned Tau config, model overlays, personas, prompt metadata, skills, project files, and AGENTS.md context from the selected execution environment cwd, then persists the resolved session bootstrap in the session snapshot. Prompt bodies and other large execution-environment content are loaded lazily when used. Component-owned config stays with the component that runs it: the attaching TUI uses local TUI config such as themes and speech settings, the host uses host config such as sandbox bridge credentials, and the execution environment owns session content/defaults. `--caffeinated` is TUI-only and rejected outside TUI mode.

## transport

The session protocol has one semantic request/response/delta contract and multiple transports.

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
{ "version": 1, "type": "..." }
```

server-to-client messages are:

- `ready`
- `response`
- `session.delta`
- `session.ephemeral`

client-to-server messages are:

- `request`

### ready message

when the rpc server starts, it immediately emits a `ready` line:

```json
{
  "version": 1,
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
    "session.retry",
    "session.exec",
    "session.interrupt",
    "session.snapshot",
    "session.setRisk",
    "session.setReasoning",
    "session.setPersona",
    "session.resolvePrompt",
    "session.autocompletePaths",
    "session.reload",
    "session.compact",
    "session.prune",
    "session.rewind",
    "session.terminateSubagent",
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

`tau rpc` and `tau serve` store session snapshots under `~/.config/tau/sessions` for the current host user. Starting a server does not create a session. `session.create` creates one in an explicitly selected, already-provisioned execution environment, and closing the transport or server persists hosted sessions. Stored sessions recover from persisted snapshot state, including current settings, bootstrap metadata, catalog metadata, execution environment identity, messages, timeline items, tools, agents, and facets; host-only config is resolved by the host and is not serialized into the snapshot.

## requests

all requests use this envelope:

```json
{
  "version": 1,
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
  "version": 1,
  "type": "response",
  "id": "init-1",
  "ok": true,
  "result": {
    "protocolVersion": 1,
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
      "session.retry",
      "session.exec",
      "session.interrupt",
      "session.snapshot",
      "session.setRisk",
      "session.setReasoning",
      "session.setPersona",
      "session.resolvePrompt",
      "session.autocompletePaths",
      "session.reload",
      "session.compact",
      "session.prune",
      "session.rewind",
      "session.terminateSubagent",
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
    "cwd": "/repo"
  }
}
```

creates a new hosted session in the selected execution environment and returns its authoritative snapshot. Tau resolves config/content from the selected execution environment cwd before creating the runtime, then stores current settings, bootstrap metadata, lightweight catalog metadata, and prompt composition metadata in the snapshot. Prompt bodies and other large execution-environment content are loaded lazily when used. `session.reload` resolves config/content again and replaces the authoritative snapshot. For local execution environments the `cwd` is resolved on the host, not on the client:

Cloudflare Sandbox execution environments use host-configured bridge ids and already-provisioned sandbox ids. The `cwd` is a real path inside that sandbox:

```json
{
  "executionEnvironment": {
    "kind": "cloudflare-sandbox",
    "bridgeId": "default",
    "sandboxId": "sandbox_123",
    "cwd": "/workspace/repo"
  }
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
  }
}
```

Tau does not create or provision Sprites during `session.create`; provider-specific SDK behavior, command-backed config/content collection, command streaming, and path validation stay inside the Fly Sprite execution adapter.

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "revision": 1,
  "lifecycle": "idle",
  "settings": {
    "personaId": "gpt-5.5-coder",
    "riskLevel": "read-only",
    "reasoning": "medium"
  },
  "bootstrap": {
    "model": {
      "id": "gpt-5.5",
      "name": "GPT-5.5",
      "api": "openai-codex-responses",
      "provider": "openai-codex",
      "baseUrl": "",
      "reasoning": true,
      "input": ["text", "image"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "prompt": {
      "environmentTag": "<environment>...</environment>",
      "subagentPrompts": {}
    }
  },
  "catalog": {
    "personas": [
      {
        "id": "gpt-5.5-coder",
        "label": "GPT-5.5 coder",
        "allowedReasoningLevels": ["medium", "high", "xhigh"],
        "tools": ["bash", "write", "edit", "view_image"],
        "skills": "*",
        "source": "builtin"
      }
    ],
    "prompts": [{ "id": "fix", "label": "fix issue" }],
    "skills": []
  },
  "executionEnvironment": {
    "kind": "local",
    "cwd": "/repo",
    "home": "/home/user"
  },
  "messages": [
    {
      "id": "system",
      "state": "committed",
      "modelVisible": true,
      "message": {
        "role": "system",
        "content": "You are Tau...",
        "timestamp": 1782850000000
      }
    }
  ],
  "timeline": [],
  "tools": {},
  "agents": {},
  "facets": {}
}
```

The snapshot stores current session settings explicitly and does not include a broad `runtimeConfig` blob. If a value is needed by clients, it is promoted to a typed snapshot field. Host-only values stay host-side. Theme files and theme selection are TUI-local presentation state and are not part of the session snapshot.

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

returns the authoritative current session snapshot for that session id:

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "revision": 1,
  "lifecycle": "idle",
  "settings": {
    "personaId": "gpt-5.5-coder",
    "riskLevel": "read-only",
    "reasoning": "medium"
  },
  "bootstrap": {
    "model": {
      "id": "gpt-5.5",
      "name": "GPT-5.5",
      "api": "openai-codex-responses",
      "provider": "openai-codex",
      "baseUrl": "",
      "reasoning": true,
      "input": ["text", "image"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 400000,
      "maxTokens": 128000
    },
    "prompt": {
      "environmentTag": "<environment>...</environment>",
      "subagentPrompts": {}
    }
  },
  "catalog": {
    "personas": [],
    "prompts": [],
    "skills": []
  },
  "executionEnvironment": {
    "kind": "local",
    "cwd": "/repo",
    "home": "/home/user"
  },
  "messages": [
    {
      "id": "system",
      "state": "committed",
      "modelVisible": true,
      "message": {
        "role": "system",
        "content": "You are Tau...",
        "timestamp": 1782850000000
      }
    }
  ],
  "timeline": [],
  "tools": {},
  "agents": {},
  "facets": {}
}
```

for each `session.observe` response, any deltas produced while the server is preparing the snapshot are sent only after the response. deltas whose `toRevision` is already included in the returned snapshot are not replayed.

if the session id is not hosted, returns `not_found`.

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
    "aborted": false,
    "blocked": {
      "reason": "auto-compaction-failed",
      "message": "optional failure message"
    }
  }
}
```

`turn.blocked` is omitted for normal completion. currently the only blocked reason is `auto-compaction-failed`, which means tau could not compact safely before continuing the turn.

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
- does not ask the active turn to stop early
- returns the same success shape as `session.submit`

#### session.steer

params are the same as `session.submit`.

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "text": "change direction",
  "historyEntryId": "optional-non-empty-user-entry-id"
}
```

behavior:

- if the session is idle, behaves like `session.submit`
- if an assistant turn is active, accepts the request, asks the active turn to stop at the next safe boundary, batches any additional steering messages in arrival order, and then starts one new turn with a short `<system>` steering instruction plus the batched user messages
- returns the same success shape as `session.submit`

#### session.retry

params (required):

```json
{ "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3" }
```

behavior:

- runs one assistant turn without appending a user message
- streams snapshot changes as broadcast `session.delta` messages with `sessionId`
- returns `busy` if another turn is already running or a mutating session request is in progress

success result:

```json
{
  "turn": {
    "aborted": false
  }
}
```

#### session.exec

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "command": "git diff -- src/main.ts",
  "cwd": "/repo",
  "timeoutMs": 30000
}
```

runs a raw shell command through the session execution environment and returns captured output. `output` is stdout and stderr interleaved in arrival order; `stdout` and `stderr` are the split streams. `cwd` and `timeoutMs` are optional. `cwd` is the command working directory, not a confinement boundary; absolute paths are allowed when the execution environment permits them. The command does not add anything to session history; clients that want command output in model context should call `session.record` with their chosen text.

returns:

```json
{
  "output": "interleaved stdout and stderr",
  "stdout": "stdout only",
  "stderr": "stderr only",
  "exitCode": 0,
  "truncated": false
}
```

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

`isTurnRunning` can still be `true` immediately after interrupt is requested while turn cleanup is still in progress.

#### session.snapshot

params (required):

```json
{ "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3" }
```

returns current session state:

- `sessionId`
- `revision` (monotonic snapshot revision for this session id)
- `lifecycle` (`"idle"` or `"running"`)
- `settings` (current persona id, risk level, reasoning, and service tier)
- `bootstrap` (selected model/provider metadata and prompt-composition metadata)
- `catalog` (lightweight personas, prompt metadata, and skills available to observed clients)
- `executionEnvironment` (where tools/files/commands execute)
- `messages` (complete synchronized transcript with stable message ids)
- `timeline` (default render projection; may omit messages that still exist in `messages`)
- `tools` (semantic tool execution state keyed by tool call id)
- `agents` (semantic subagent execution state)
- `facets` (client-only structured metadata attached to session/message/tool/agent/operation subjects)

derive transcript length from `messages.length`; the protocol does not duplicate it. The first committed message is the effective system instruction message. Running state is derived from `lifecycle`, draft/interrupted messages, tools, agents, and operations; there is no `activeTurn` side object. If an assistant turn is interrupted mid-stream, the streamed content is retained as an `interrupted` assistant message and remains model-visible unless the host intentionally marks that record `modelVisible: false`.

User message text in `messages` is the raw recoverable Tau session text. It may start with Tau's internal metadata prefix, which is persisted for recovery but is never sent to the model or shown to users. After that metadata is removed, user text may start with one or more strict hidden model instruction blocks in the form `<system>...</system>\n`; these blocks are sent to the model as part of the user turn but should be hidden from user-facing renderers. Clients that render user messages should derive display text by removing Tau metadata and then removing only leading exact `<system>...</system>\n` blocks from user messages. Do not apply this display projection to assistant, tool, or protocol system messages.

#### session.setRisk

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "riskLevel": "read-write"
}
```

sets the session risk level to `"read-only"` or `"read-write"` and returns the authoritative updated session snapshot. The host applies the change through the session mutation queue so it does not race another mutating request or an active turn.

#### session.setReasoning

params (required):

```json
{ "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3", "reasoning": "high" }
```

sets the session reasoning effort to `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, or `"xhigh"` and returns `{ "revision": number, "settings": { ... } }` with the authoritative updated settings. Observed clients receive a `settings.set` snapshot patch for the same revision. The host applies the settings update through the session mutation queue, but it does not interrupt an active turn or reject queued/steering messages. If a turn is already running, the new reasoning applies to the next user-message turn.

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

#### session.prune

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "strategy": "smart",
  "fraction": 0.25,
  "guidance": "keep errors"
}
```

`strategy` is `"earliest"`, `"largest"`, or `"smart"`. `fraction` is a required number from `0` to `1`. `guidance` is optional and only used by `"smart"`.

prunes bash tool results and compacts edit tool payloads/results in the session history. returns:

```json
{
  "snapshot": { "...": "authoritative updated session snapshot" },
  "message": "pruned 1 bash tool result (512 tokens).",
  "noop": false,
  "bashResultsPruned": 1,
  "editCallsPruned": 0,
  "editResultsPruned": 0,
  "bytesPruned": 3072
}
```

the host applies pruning through the session mutation queue, interrupts any running turn, waits for in-flight submit handling to settle, and rejects pending steering submits. clients should render the returned `snapshot` as authoritative session state; prune counts and `message` describe the operation result and are not stored UI state.

#### session.terminateSubagent

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "subagentId": "subagent-..."
}
```

requests termination of a running subagent in the hosted session. returns `{ "found": true }` when the subagent id was known and `{ "found": false }` otherwise.

#### session.ephemeral.create

params (required):

```json
{
  "sessionId": "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
  "instructions": "You are helping with a focused code review...",
  "tools": ["bash", "view_image"],
  "riskLevel": "read-only"
}
```

creates a host-owned ephemeral agent context outside the persisted session timeline. The context inherits the hosted session persona and execution environment, appends the provided instructions, uses the requested tool set and risk level, and returns `{ "contextId" }`. These contexts are not persisted in `session.snapshot` and are not recoverable after disconnect or host restart.

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
  "version": 1,
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
  "version": 1,
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

`snapshot.patch` changes include lifecycle, message, timeline, tool, agent, and facet updates. High-rate assistant streaming uses `message.content.append` after the draft assistant message exists so clients do not receive the full accumulated assistant text on every frame. A content append targets only draft assistant messages and must include non-empty `text` and/or `thinking`; when a thinking block is created, clients insert it before the text block so applying patches reconstructs the canonical assistant content order. Maintenance operations such as reload, rewind, compaction, and pruning may use `snapshot.reset` when replacing the complete state is clearer than sending a long patch sequence.

`reason` describes why the transition happened and is for logging, animation, and client policy. Correctness comes from applying the delta. Current reasons are `user-message`, `assistant-stream`, `assistant-message`, `tool-run`, `tool-result`, `notice`, `agent-run`, `maintenance`, `configuration`, and `recovery`.

notes:

- every delta includes `sessionId`.
- deltas do not include `requestId`; request ids correlate request/response pairs, while deltas are broadcast facts about observed session state.
- queued and steering requests each receive their own response when accepted work settles.
- notices and maintenance operations are stored as timeline items, so late-attaching clients can reconstruct them from `session.snapshot`.
- tool progress, tool UI payloads, and subagent progress are stored in `tools`, `agents`, and `facets` instead of live-only side-channel events.

## ephemeral events

`session.ephemeral` messages carry non-recoverable observed-session activity that is intentionally not stored in `SessionSnapshot`. The current use is live ephemeral-agent progress:

```json
{
  "version": 1,
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
- `invalid_request`: malformed envelope or bad version/type/id
- `method_not_found`: unsupported method
- `invalid_params`: params failed method validation
- `not_found`: requested session does not exist on this host
- `busy`: overlapping idle-only `session.submit`/`session.retry`/`session.exec` or activity rejected while a mutating request is in progress
- `internal_error`: unexpected runtime failure

for lines that cannot produce a valid request id (for example malformed json), `id` is `null`.

## concurrency and ordering

`runRpcServer` handles incoming lines concurrently with explicit serialization for mutating transitions. this means:

- multiple requests can be accepted before earlier ones complete
- `session.record`, `session.setRisk`, `session.setReasoning`, `session.setPersona`, `session.reload`, `session.compact`, `session.prune`, `session.rewind`, `session.terminateSubagent`, `session.ephemeral.create`, and `session.ephemeral.close` run through a session-owned mutation queue (arrival order across clients observed to the same live session)
- `session.setReasoning` updates settings immediately without interrupting an active turn; active turns keep their captured reasoning and the new setting applies to the next user-message turn
- only one idle-only `session.submit`, `session.retry`, or `session.exec` can run at once (`busy` otherwise)
- `session.queue` can be accepted during active work and runs after the active turn settles
- `session.steer` can be accepted during an active turn and runs at the next safe boundary after requesting the active turn to stop
- `session.submit`, `session.retry`, and `session.exec` are rejected with `busy` while a queued/running compact or prune mutation exists
- responses and deltas may still interleave

clients should route responses by `id` and broadcast deltas by `sessionId`, not by arrival order alone.
