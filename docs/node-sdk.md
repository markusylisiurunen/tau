# Node SDK

Tau's Node SDK provides a typed client for creating, observing, and controlling sessions without implementing the wire protocol directly. Use the in-process client when your application should own the host, the WebSocket client for a long-running `tau serve` host, or the transport adapter with a custom connection implementation.

The SDK uses the same public [session protocol](session-protocol.md) as the TUI. Session behavior is therefore consistent across local applications, remote integrations, and terminal clients.

## Install and import

Tau requires Node.js 24 or later.

```sh
npm install @markusylisiurunen/tau
```

Import the SDK from its package entry point:

```ts
import { createTauSdkClient } from "@markusylisiurunen/tau/sdk";
```

Tau is an ES module package.

## Choose a client

### Own an in-process host

`createTauSdkClient()` creates a local host and connects through an in-process transport:

```ts
const client = await createTauSdkClient({
  persona: "gpt-5.6-sol-coder:high",
});
```

The host uses the current host user's Tau session store and history database. `cwd` in the client options controls startup configuration for host-wide services and defaults to `process.cwd()`. Each session separately resolves runtime configuration and content from the execution environment and `cwd` passed to `client.sessions.create()`.

The in-process options are:

```ts
type TauSdkClientOptions = {
  cwd?: string;
  persona?: string;
  reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  noAgentContextFiles?: boolean;
  connectTimeoutMs?: number;
  initialize?: { client: { name: string; version: string } };
  clientTools?: TauSdkClientTool[];
};
```

`persona`, `reasoning`, and `noAgentContextFiles` configure sessions created by this owned host. `connectTimeoutMs` defaults to 5,000 ms. Default initialization metadata is `{ client: { name: "tau-sdk", version: "1" } }`.

Closing this client also shuts down its host after persisting live sessions.

### Connect to `tau serve`

`createTauSdkWebSocketClient()` connects to a long-running WebSocket host:

```ts
import { createTauSdkWebSocketClient } from "@markusylisiurunen/tau/sdk";

const client = await createTauSdkWebSocketClient({
  url: "wss://tau.example.com",
  authToken: process.env.TAU_WS_AUTH_TOKEN,
  initialize: {
    client: { name: "acme-automation", version: "1.0.0" },
  },
});
```

Options include `url`, optional `authToken`, `connectTimeoutMs`, `initialize`, `clientTools`, and an optional `webSocketFactory` for runtimes that need a custom WebSocket implementation. Closing the SDK client closes only its connection. Sessions remain with the server.

WebSocket authentication grants full session access. Deployment and TLS guidance belongs to [remote sessions](remote-sessions.md), and the trust model belongs to [security](security.md).

### Supply a protocol transport

`createTauSdkClientFromTransport(transport, options?)` builds the same client facade over any `SessionProtocolTransport`. This keeps the SDK facade independent of WebSocket and allows applications to supply another transport without changing session semantics.

A custom transport implements:

```ts
type SessionProtocolTransport = {
  readonly ready: SessionProtocolReadyMessage;
  connect(initializeParams, timeoutMs): Promise<void>;
  request(method, params): Promise<unknown>;
  onDelta(listener): () => void;
  onEphemeral(listener): () => void;
  onPendingUserMessages(listener): () => void;
  onSubagentActivities(listener): () => void;
  onClientTool(listener): () => void;
  onFailure(listener): () => void;
  close(): Promise<void>;
};
```

A terminal transport failure must call `onFailure` listeners so the SDK can abort delegated client tools and reject outstanding work.

## Create and run a session

A typical integration creates and automatically observes a session, listens for state, submits work, and closes cleanly:

```ts
import {
  TauSessionProtocolResponseError,
  TauTransportError,
  createTauSdkClient,
} from "@markusylisiurunen/tau/sdk";

const client = await createTauSdkClient();
const session = await client.sessions.create({
  executionEnvironment: {
    kind: "local",
    cwd: process.cwd(),
  },
  attributes: {
    source: "sdk",
    repository: "github.com/example/atlas",
  },
});

const unsubscribe = session.onDelta((delta) => {
  console.log(delta.sessionId, delta.fromRevision, delta.toRevision);
});

try {
  const result = await session.submit("Summarize the current changes.");
  const snapshot = await session.snapshot();
  console.log(result.userHistoryEntryId, result.turn.status, snapshot.revision);
} catch (error) {
  if (error instanceof TauSessionProtocolResponseError) {
    console.error(error.code, error.message);
  } else if (error instanceof TauTransportError) {
    console.error(error.message);
  } else {
    throw error;
  }
} finally {
  unsubscribe();
  await session.unobserve();
  await client.close();
}
```

`client.sessions.create(input)` sends `session.create`, then observes the new session before resolving. `client.sessions.observe(sessionId)` does the same observation handshake for an existing session. `client.sessions.list()` returns `{ sessionId, lifecycle }` summaries.

Creation requires complete execution-environment input and immutable attributes. The execution `cwd` must be absolute and belongs to the selected environment, not necessarily the SDK process. Cloudflare Sandbox and Fly Sprite sessions refer to already-provisioned targets configured on the host. See [sessions](sessions.md) for creation attributes and [ownership and scope](ownership-and-scope.md) for path ownership.

`session.unobserve()` stops observation and makes that `TauSdkSession` facade terminal. It does not delete the hosted session. `client.close()` is idempotent and closes the whole client.

The connected `TauSdkClient` exposes:

| Member | Purpose |
| --- | --- |
| `ready` | The validated server `ready` message and advertised methods. |
| `sessions.create(input)` | Create, observe, and return a session facade. |
| `sessions.list()` | List hosted session summaries. |
| `sessions.observe(sessionId)` | Observe an existing session and return a facade. |
| `subscribe(listener)` | Receive deltas for every observed session on this connection. |
| `subscribePendingUserMessages(listener)` | Receive pending-state replacements across observed sessions. |
| `subscribeSubagentActivities(listener)` | Receive subagent-activity changes across observed sessions. |
| `subscribeEphemeral(listener)` | Receive best-effort ephemeral events across observed sessions. |
| `close()` | Close the client and its owned resources. |

Each subscription returns an unsubscribe function.

## Use the session facade

`TauSdkSession.id` is the bound session id. Its methods map directly to protocol operations; the [method reference](session-protocol-methods.md) defines exact results, turn outcomes, busy rules, and mutation behavior.

| SDK method | Purpose |
| --- | --- |
| `record(text, options?)` | Append user text without running a turn. |
| `submit(text, options?)` | Append user text and run an idle session turn. |
| `queue(text, options?)` | Run now or wait behind active session work. |
| `steer(text)` | Redirect active model work at a safe boundary. |
| `cancelPendingMessages()` | Cancel all queued and unapplied steering input. |
| `retry()` | Run from current history without appending user text. |
| `exec(command, options?)` | Run an independent login-Bash command in the execution environment. |
| `sample({ context, options })` | Run isolated inference without mutating the session. |
| `interrupt()` | Request cancellation of active session work. |
| `snapshot()` | Read the complete authoritative snapshot. |
| `startGoal(objective)` | Create and run a persistent autonomous goal. |
| `resumeGoal()` | Continue a blocked goal. |
| `clearGoal()` | Clear the current goal and return the updated snapshot. |
| `setReasoning(reasoning)` | Set reasoning for the next independently started turn. |
| `setPersona(personaId)` | Change persona and return the updated snapshot. |
| `resolvePrompt(promptId)` | Load a current prompt body from the execution environment. |
| `autocompletePaths({ query, limit })` | Request bounded execution-environment path suggestions. |
| `reload()` | Reload session-owned configuration and content. |
| `compact(mode, options?)` | Manually compact model context. |
| `rewindToHistoryEntryId(id)` | Rewind from one user history entry while idle. |
| `interruptSubagent(subagentId)` | Interrupt one live subagent run. |
| `createEphemeralContext(options)` | Create a non-persisted host-owned agent context. |
| `submitEphemeralThread(options)` | Run or continue one ephemeral thread. |
| `closeEphemeralContext(contextId)` | Close an ephemeral context and its threads. |
| `unobserve()` | Stop observation and retire this facade. |

`submit`, `queue`, and `record` accept `{ historyEntryId?: string }`. When omitted, Tau generates the user history id. Use `getTauSdkSessionTurnRecord(snapshot, id)` to distinguish unknown, running, and settled accepted turns, or `getTauSdkSessionTurnOutcome(snapshot, id)` when only a settled outcome matters.

### Execute a command

`exec` generates a unique wire-level execution id and supports exact positional arguments, environment overrides other than `HOME`, binary stdin, a command `cwd`, timeout, capture limit, and cancellation signal:

```ts
const controller = new AbortController();
const result = await session.exec('exec "$0" "$@"', {
  args: ["git", "status", "--short"],
  cwd: "/srv/workspaces/atlas",
  timeoutMs: 10_000,
  maxCaptureBytes: 256 * 1024,
  signal: controller.signal,
});

console.log(result.exitCode, result.output);
```

Aborting the signal sends targeted `session.cancelExec` and rejects the SDK call. It does not interrupt turns or other executions. The operation does not enter conversation history.

### Sample a model

`sample` uses the session's active resolved model target and credentials but only the supplied provider-neutral context:

```ts
const sampled = await session.sample({
  context: {
    systemPrompt: "Classify the request in one word.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "I cannot log in." }],
        timestamp: Date.now(),
      },
    ],
  },
  options: { reasoning: "low", maxTokens: 100 },
});

console.log(sampled.message.content);
```

The returned complete assistant message can be reused in a later sampling context. Optional tool schemas can produce tool-call content, but Tau does not execute those calls. Sampling does not emit deltas, change snapshot revision or cost, or write conversation history.

## Consume streamed state

The SDK exposes connection-wide subscriptions on `TauSdkClient` and session-filtered subscriptions on `TauSdkSession`. Prefer the session facade unless one component deliberately multiplexes several sessions.

### Snapshot deltas

`session.onDelta(listener)` receives only that session's `TauSdkDelta` messages. The facade buffers deltas received before its first local delta listener and replays them when that listener is attached. Use `applySessionProtocolDelta` against an installed snapshot. On any revision gap or invalid transition, refresh with `session.snapshot()`.

A method that returns an authoritative snapshot, such as reload, compact, rewind, persona change, or goal clearing, lets the facade discard buffered deltas through that revision. Do not also replay stale presentation transitions from those discarded deltas.

### Pending input

`session.pendingUserMessages()` returns a clone of the current full pending-message state. `session.onPendingUserMessages(listener)` immediately emits the current baseline, then newer full replacements. Its revision is independent of the snapshot.

```ts
const stopPending = session.onPendingUserMessages(({ state }) => {
  console.log(state.messages.map((message) => [message.mode, message.text]));
});
```

Pending input is shared among clients observing the live hosted session and starts empty after recovery.

### Subagent activity

`session.subagentActivities()` returns the current transient activity state. `session.onSubagentActivities(listener)` immediately emits the current agents as `agent.set` changes, then later per-agent replacements and removals.

For a custom accumulator, use `applySessionProtocolSubagentActivitiesMessage`. This channel has its own revision and does not replace durable `snapshot.agents`.

### Ephemeral events

`session.onEphemeral(listener)` receives best-effort footer notices, ephemeral thread progress, and non-recoverable timeline notices. These events are not replayed or included in `session.snapshot()`.

If rendering `timeline.item`, accept only the active epoch and merge by its allocated sequence. Compaction and rewind causes determine which client-local ephemeral items remain valid. The [session protocol](session-protocol.md) gives the application rules.

## Provide client tools

Pass `TauSdkClientTool` entries in `clientTools` when model-facing work must run in the integration process:

```ts
import {
  buildTauClientToolPresentation,
  createTauSdkClient,
  truncateTauClientToolSubject,
} from "@markusylisiurunen/tau/sdk";

const client = await createTauSdkClient({
  clientTools: [
    {
      schema: {
        name: "local_picker",
        description: "Choose one item from the user's local workspace.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        executionTimeoutMs: 60_000,
      },
      describe: (args) => {
        const input = args as { choice?: string };
        return buildTauClientToolPresentation({
          toolName: "local_picker",
          subject: truncateTauClientToolSubject(
            input.choice ?? "local workspace",
          ),
        });
      },
      execute: async (_args, context) => {
        context.signal.throwIfAborted();
        const status = await context.executionEnvironment.exec(
          "git status --short",
          {
            signal: context.signal,
          },
        );
        return status.output || "Working tree is clean.";
      },
    },
  ],
});
```

The handler receives `sessionId`, owning `agentId`, `callId`, an `AbortSignal`, and an execution-environment facade. The handler itself runs on the client machine. `context.executionEnvironment.exec()` crosses the session boundary and runs in the session execution environment.

The SDK calls `describe` with the arguments and execution context before acknowledgement. The callback returns a complete bounded presentation; it owns subject selection and semantic truncation. `buildTauClientToolPresentation` supplies canonical lifecycle labels, while `truncateTauClientToolSubject` provides configurable line, character, and head or middle truncation. The SDK validates and acknowledges that presentation before calling `execute`.

The SDK converts a returned string or `{ content }` to the wire result, reports thrown errors, and aborts handlers on host cancellation, client close, or terminal transport failure. `client.close()` waits for active handlers to settle.

Tool definitions are frozen for each assistant turn and remain independent of persona tool allowlists. Names cannot collide with host tools or another observing client's tools. See [client tools](client-tools.md) for authority, limits, command-backed tools, and disconnect behavior.

### Build a code-mode tool

`createTauCodeModeClientTool()` wraps a bounded one-shot JavaScript API as an SDK client tool:

```ts
import {
  buildTauCodeModeToolDescription,
  createTauCodeModeClientTool,
} from "@markusylisiurunen/tau/sdk";

const name = "tickets";
const tickets = createTauCodeModeClientTool({
  name,
  description: buildTauCodeModeToolDescription({
    name,
    description: "Read support tickets.",
  }),
  documentation: "# Tickets API\n\nUse `tickets.get(id)` to read one ticket.",
  api: {
    get: async ([id], { signal }) => ticketClient.get(String(id), { signal }),
  },
});
```

Pass `tickets` in `clientTools`. Generated code receives the declared API namespace, progressively disclosed `docs`, console output, live `Date` and `Math`, and agent-scoped scratch files when invoked as a client tool. API calls cross a bounded JSON bridge. The tool description remains explicit caller input; the builder is optional.

The SDK also exports `executeTauCodeMode` for standalone execution. The separate `@markusylisiurunen/tau/code-mode` entry point additionally exports file-capability types, `runTauClientToolCommand`, and `runTauCodeModeCommand` for command-backed tools. Use the helpers instead of implementing their framing manually.

## Cancel and close deliberately

Most turn and mutation methods do not accept an `AbortSignal`. Call `session.interrupt()` to cancel active host work. `session.exec()` is the exception: its optional signal targets only that execution.

`session.unobserve()` retires one facade. `client.close()` retires the connection, rejects pending transport requests, aborts client-tool handlers, waits for them to settle, and then closes the transport. For the default in-process client it also persists sessions and shuts down the owned host. For WebSocket it leaves the remote host and sessions running.

Always close clients in `finally`. Do not continue using a session facade after unobserve or any client after close.

## Handle errors

All exported SDK and transport errors extend `TauSessionClientError`:

- `TauSessionProtocolResponseError` means the host returned a protocol error. It exposes `code`, `message`, `requestId`, and optional `data`.
- `TauTransportError` means connection setup, framing, version validation, timeout, closure, or another terminal transport operation failed.

Branch on a protocol error's `code`, not its message. A successful request can still return a failed, aborted, or blocked turn outcome, so inspect `result.turn.status` separately.

Listener exceptions are isolated from SDK event delivery. Handle failures inside listeners and keep state application deterministic.

## Use the public types and helpers

The SDK entry point exports the types needed at integration boundaries rather than requiring imports from internal modules:

- `TauSdkClient`, `TauSdkSession`, client option types, session summaries, and request and result aliases;
- `TauSdkDelta`, `SessionProtocolSnapshot`, pending-message types, subagent-activity types, and ephemeral event types;
- `TauSdkClientTool`, its execution context and environment facade, and code-mode definition and result types;
- `SessionProtocolTransport`, listener types, WebSocket options, and transport errors.

It also exports `applySessionProtocolDelta`, `applySessionProtocolSubagentActivitiesMessage`, the turn-ledger helpers, and user-text projection helpers:

```ts
import {
  getTauUserDisplayText,
  getTauUserModelText,
  projectTauUserText,
} from "@markusylisiurunen/tau/sdk";
```

Use `getTauUserDisplayText` before rendering raw snapshot user text. It removes Tau metadata and leading exact hidden system blocks. `getTauUserModelText` removes Tau metadata while preserving model-facing hidden instructions. `projectTauUserText` returns both views together. These helpers apply only to user messages.
