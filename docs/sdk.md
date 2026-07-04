# node sdk

tau ships a Node SDK at `@markusylisiurunen/tau/sdk`. by default it creates an in-process Tau host and talks to it through the same session protocol used by session transports. Callers can also connect to a `tau serve` WebSocket host or build the same typed client over any session protocol transport. The TUI uses the same protocol surface:

```sh
tau attach ws://vps:8787
tau attach -- ssh vps 'cd /repo && tau rpc --risk read-only'
```

## install and import

```sh
npm install @markusylisiurunen/tau
```

```ts
import { createTauSdkClient } from "@markusylisiurunen/tau/sdk";
```

## quick start

```ts
import {
  TauSessionProtocolResponseError,
  TauTransportError,
  createTauSdkClient,
} from "@markusylisiurunen/tau/sdk";

const client = await createTauSdkClient({
  persona: "gpt-5.4-coder",
  riskLevel: "read-only",
});

const session = await client.sessions.create({
  executionEnvironment: {
    kind: "local",
    cwd: process.cwd(),
  },
});

const unsubscribe = session.onDelta((delta) => {
  console.log(delta.sessionId, delta.toRevision, delta.reason);
});

try {
  const submit = await session.submit("summarize this repository");
  console.log(submit.userHistoryEntryId, submit.turn.aborted);

  const snapshot = await session.snapshot();
  console.log(snapshot.sessionId, snapshot.messages.length);

  await session.unobserve();
} catch (error) {
  if (error instanceof TauSessionProtocolResponseError) {
    console.error(error.code, error.message, error.data);
  } else if (error instanceof TauTransportError) {
    console.error(error.message);
  } else {
    throw error;
  }
} finally {
  unsubscribe();
  await client.close();
}
```

## api

### `createTauSdkClient(options?)`

creates, connects, and initializes a new sdk client.

default behavior:

- creates a local in-process session host
- uses the file session store under the current host user's Tau config directory
- resolves config/content from `options.cwd ?? process.cwd()` for SDK startup defaults
- waits up to `5000ms` for the session protocol `ready` message
- sends session protocol `initialize` with default metadata `{ client: { name: "tau-sdk", version: "1" } }`

returns a connected `TauSdkClient` instance.

sdk lifecycle notes:

- the sdk waits for session protocol `ready`, then immediately sends `initialize`; `initialize` is a transport handshake and does not create or observe a session.
- connected clients start without an observed session; call `client.sessions.list()`, `client.sessions.observe(sessionId)`, or `client.sessions.create({ executionEnvironment })` before submitting, snapshotting, or interrupting.
- `client.close()` closes the transport. For `createTauSdkClient()`, it also shuts down the owned in-process host after persisting live session snapshots. Persisted sessions can be observed by a later client that knows the session id.
- `session.unobserve()` stops observing from this SDK facade and makes the facade terminal. It does not delete the hosted session.

#### options

- `cwd?: string`
  - startup cwd for resolving SDK default config/content before sessions are created
- `persona?: string`
  - default persona id and optional reasoning level for locally created in-process sessions
- `reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"`
  - explicit reasoning effort for locally created in-process sessions
- `riskLevel?: "read-only" | "read-write"`
  - default risk level for locally created in-process sessions
- `noAgentContextFiles?: boolean`
  - disables AGENTS.md context discovery for locally created in-process sessions
- `connectTimeoutMs?: number`
  - ready/initialize timeout (default `5000`)
- `initialize?: { client: { name: string; version: string } }`
  - metadata sent with session protocol `initialize`
  - `client.name` and `client.version` must be non-empty strings

### `createTauSdkWebSocketClient(options)`

creates, connects, and initializes the SDK client over a WebSocket session host started with `tau serve`.

```ts
import { createTauSdkWebSocketClient } from "@markusylisiurunen/tau/sdk";

const client = await createTauSdkWebSocketClient({
  url: "wss://tau.example.com",
  authToken: process.env.TAU_WS_AUTH_TOKEN,
});

const session = await client.sessions.create({
  executionEnvironment: {
    kind: "local",
    cwd: "/srv/workspaces/repo",
  },
});
await session.submit("summarize the PR");
await client.close();
```

When the host config defines a Cloudflare Sandbox bridge, SDK callers can create a session bound to an already-provisioned sandbox:

```ts
const session = await client.sessions.create({
  executionEnvironment: {
    kind: "cloudflare-sandbox",
    bridgeId: "default",
    sandboxId: "sandbox_123",
    cwd: "/workspace/repo",
  },
});
```

The `cwd` is a real path inside the sandbox. Tau does not create or provision the sandbox as part of session creation.

Fly Sprites are similar: configure the Sprite API on the host, then create a session against an already-provisioned Sprite name and real Sprite path:

```ts
const session = await client.sessions.create({
  executionEnvironment: {
    kind: "fly-sprite",
    apiId: "default",
    spriteName: "sprite-123",
    cwd: "/home/sprite/repo",
  },
});
```

Tau does not create or provision the Sprite as part of session creation.

options:

- `url: string`
  - `ws://` or `wss://` URL for a `tau serve` host
- `authToken?: string`
  - token required by servers started with `--auth-token` or `TAU_WS_AUTH_TOKEN`
- `connectTimeoutMs?: number`
  - open/ready/initialize timeout (default `5000`)
- `initialize?: { client: { name: string; version: string } }`
  - metadata sent through the transport connect handshake
- `webSocketFactory?: (url: string) => WebSocketLike`
  - optional custom WebSocket constructor hook for tests or non-default runtimes

`client.close()` closes only the WebSocket client connection. Hosted sessions remain persisted on the server.

### `createTauSdkClientFromTransport(transport, options?)`

creates, connects, and initializes the same SDK client facade over a caller-provided `SessionProtocolTransport`.

`createTauSdkClient()` is the in-process convenience wrapper. `createTauSdkWebSocketClient()` is the WebSocket convenience wrapper. `createTauSdkClientFromTransport()` is the transport-agnostic path for stdio subprocesses, daemon, session, or test transports that carry the canonical session protocol.

The SDK entrypoint also exports `StdioSessionProtocolTransport` for callers that want to spawn or wrap a `tau rpc` process themselves.

options:

- `connectTimeoutMs?: number`
  - transport connect timeout (default `5000`)
- `initialize?: { client: { name: string; version: string } }`
  - metadata sent through the transport connect handshake
  - `client.name` and `client.version` must be non-empty strings

### `TauSdkClient`

- `ready: TauSdkReadyMessage`
  - the session protocol ready payload (supported methods and protocol versions)
- `sessions`
  - session facade with `create()`, `list()`, and `observe(sessionId)`
- `subscribe(listener)`
  - subscribes to all streamed `session.delta` messages on this client connection
  - returns an unsubscribe function
- `subscribeEphemeral(listener)`
  - subscribes to all live-only `session.ephemeral` messages on this client connection
  - returns an unsubscribe function
- `close()`
  - closes the transport
  - for `createTauSdkClient()`, also shuts down the owned in-process host after persisting live session snapshots
  - idempotent

### `client.sessions`

- `create()`
  - sends `session.create`
  - resolves with a new `TauSdkSession`
- `list()`
  - sends `session.list`
  - resolves with the hosted session summary array
- `observe(sessionId)`
  - sends `session.observe`
  - resolves with a `TauSdkSession` bound to the returned session id

### `TauSdkSession`

- `id`
  - current session id for this facade
- `onDelta(listener)`
  - subscribes to streamed `session.delta` messages for this session id only
  - replays any deltas received by this session facade before the first local listener was attached
  - returns an unsubscribe function for the local SDK listener
- `onEphemeral(listener)`
  - subscribes to non-persisted `session.ephemeral` messages for this session id only
  - used for live-only progress such as ephemeral agent thread updates
- `unobserve()`
  - sends `session.unobserve` with this session id, stops this connection's server-side observation for the session, and makes this session facade terminal
- `record(text, options?)`
  - sends `session.record` with this session id
  - appends a user message without running an assistant turn
- `submit(text, options?)`
  - sends `session.submit` with this session id
- `queue(text, options?)`
  - sends `session.queue` with this session id
  - accepts active-work queueing semantics from the session protocol
- `steer(text, options?)`
  - sends `session.steer` with this session id
  - accepts active-turn steering semantics from the session protocol
- `retry()`
  - sends `session.retry` with this session id to run a turn without appending user text
- `exec(command, options?)`
  - sends `session.exec` with this session id
  - runs a raw command in the session execution environment and returns interleaved `output` plus split `stdout` and `stderr`
  - does not add output to session history
- `interrupt()`
  - sends `session.interrupt` with this session id
- `snapshot()`
  - sends `session.snapshot` with this session id
  - returns raw recoverable session user text; renderers should use `getTauUserDisplayText()` or `projectTauUserText()` to hide Tau metadata and leading exact `<system>...</system>\n` blocks from user messages before showing them to users
- `setRiskLevel("read-only" | "read-write")`
  - sends `session.setRisk` with this session id and resolves with the updated session snapshot
- `setReasoning("none" | "minimal" | "low" | "medium" | "high" | "xhigh")`
  - sends `session.setReasoning` with this session id and resolves with `{ revision, settings }`
- `setPersona(personaId)`
  - sends `session.setPersona` with this session id and resolves with the updated session snapshot
- `resolvePrompt(promptId)`
  - sends `session.resolvePrompt` with this session id
  - loads the latest prompt body from the session execution environment
- `autocompletePaths({ query, limit })`
  - sends `session.autocompletePaths` with this session id
  - returns bounded file and directory path suggestions from the session execution environment
- `reload()`
  - sends `session.reload` with this session id
  - resolves with the updated snapshot plus warning strings and counts for personas, prompts, and skills
- `compact("summary-only" | "summary-and-last", options?)`
  - sends `session.compact` with this session id and optional `guidance`
  - resolves with the updated snapshot plus `compactionMessage` and `includedLastAssistant`
- `pruneToolResults("earliest" | "largest" | "smart", { fraction, guidance? })`
  - sends `session.prune` with this session id
  - resolves with the updated snapshot plus prune counts and operation message
- `rewindToHistoryEntryId(historyEntryId)`
  - sends `session.rewind` with this session id
  - resolves with the updated snapshot, removed history ids, and rewound user text
- `terminateSubagent(subagentId)`
  - sends `session.terminateSubagent` with this session id
  - resolves with `{ found: boolean }`
- `createEphemeralContext({ instructions, tools, riskLevel })`
  - sends `session.ephemeral.create` with this session id
  - creates non-persisted host-owned agent context and returns `{ contextId }`
- `submitEphemeralThread({ contextId, threadId, forkFromThreadId?, message })`
  - sends `session.ephemeral.submit` with this session id
  - runs or continues an ephemeral host-owned agent thread and returns `{ threadId, response }`
- `closeEphemeralContext(contextId)`
  - sends `session.ephemeral.close` with this session id
  - closes non-persisted host-owned ephemeral agent state

## deltas

`onDelta` receives `TauSdkDelta`, the same `session.delta` message emitted by the connected session host:

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
    "changes": []
  }
}
```

Clients can apply deltas to a `session.snapshot()` result with `applySessionProtocolDelta` from `@markusylisiurunen/tau/sdk`. If a revision gap is detected, refresh with `session.snapshot()`. For payload semantics, see [docs/rpc.md](./rpc.md).

## ephemeral events

`onEphemeral` receives live-only `TauSdkEphemeral` messages. These are not recoverable from snapshots and should be treated as best-effort progress:

```ts
const unsubscribeEphemeral = session.onEphemeral((message) => {
  if (message.event.type === "ephemeral-agent.thread-update") {
    console.log(message.event.threadId, message.event.update.lastActivityText);
  }
});
```

## errors

sdk calls may reject with:

- `TauSessionProtocolResponseError`
  - the session protocol returned `ok: false` with a protocol error (`busy`, `invalid_params`, etc)
  - includes `code`, `message`, `requestId`, and optional `data`
- `TauTransportError`
  - connection/setup failures, malformed transport output, timeout, or closed client
- `TauProcessError` (extends `TauTransportError`)
  - subprocess failure with `exitCode`, `signal`, and captured `stderr`

all session client and transport errors extend `TauSessionClientError`.

## exported types

The SDK entrypoint exports the public `TauSdk*` aliases for client/session interfaces, request and result shapes, streamed `TauSdkDelta` and `TauSdkEphemeral` messages, ephemeral agent tools, WebSocket options, session protocol method/request ids, and user-message projection helpers (`projectTauUserText`, `getTauUserModelText`, `getTauUserDisplayText`). It also re-exports the transport interfaces and errors needed to build custom protocol transports.
